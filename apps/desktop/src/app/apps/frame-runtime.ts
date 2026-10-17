/**
 * The multiplayer runtime inside a chat app's sandboxed frame. Bundled on its
 * own (the `hermes:app-runtime` plugin in vite.config.ts) and inlined into the
 * srcdoc ahead of the page:
 *
 *   await hermes.ready
 *   hermes.state.set('votes', 3)                 // per-key JSON, last writer wins
 *   hermes.state.on('votes', v => render(v))      // fires now and on every change
 *   hermes.text('notes', textarea)                // simultaneous editing (@codemirror/collab)
 *   hermes.presence.on(peers => …)                // who else has this app open
 *   <textarea data-hermes-text="notes">            // the same, without a script
 *   <input data-hermes-state="title">
 *
 * The frame has an opaque origin and no credential: it only posts to its
 * parent, tagged with the mount token, and the window relays to `/api/apps`
 * (app/apps/protocol.ts). Without a connection (a chat not saved yet, a
 * server without the route) the app still works, for this window alone.
 */

import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab'
import { ChangeSet, EditorState, type Transaction } from '@codemirror/state'

type Role = 'local' | 'owner' | 'participant' | 'viewer'

interface Person {
  id?: string
  user?: string
  name: string
  color: string
}

interface Peer extends Person {
  id: string
  role?: Role
  cursor: null | { x: number; y: number }
}

interface WireUpdate {
  clientID: string
  changes: unknown
}

type ServerFrame = Record<string, unknown>
type Editable = HTMLInputElement | HTMLTextAreaElement
type ValueListener = (value: unknown, key: string, by: null | Person) => void

interface TextModel {
  key: string
  state: EditorState
  els: Set<Editable>
  subs: Set<(text: string) => void>
  inflight: boolean
  retry: number
  /** Waiting for the server to take (or ignore) the markup's starting text: edits would race it. */
  seeding: boolean
  fallback: string
}

const token = String((window as unknown as { __HERMES_APP__?: { token?: string } }).__HERMES_APP__?.token ?? '')
const OUT = 'hermes-app'
const IN = 'hermes-app-in'
const OFFLINE_AFTER_MS = 4000
const PUSH_RETRY_MS = 4000
const SEED_WAIT_MS = 3000
const CURSOR_INTERVAL_MS = 50
const clientID = `c${Math.random().toString(36).slice(2, 12)}`

let role: Role = 'local'
let connected = false
let self: null | Peer = null
let isReady = false

let resolveReady: () => void = () => {}
const ready = new Promise<void>(resolve => (resolveReady = resolve))

const values = new Map<string, unknown>()
const valueSubs = new Set<{ fn: ValueListener; key: string }>()
const texts = new Map<string, TextModel>()
const snapshotTexts = new Map<string, { doc: string; version: number }>()
const peers = new Map<string, Peer>()
const peerSubs = new Set<(peers: Peer[]) => void>()
const roleSubs = new Set<(role: Role) => void>()
const stateBindings = new Set<HTMLElement>()

const post = (op: Record<string, unknown>) => parent.postMessage({ ...op, token, type: OUT }, '*')
const canEdit = () => role !== 'viewer'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function safely<A extends unknown[]>(fn: (...args: A) => void, ...args: A) {
  try {
    fn(...args)
  } catch (error) {
    console.error(error)
  }
}

function markReady() {
  if (!isReady) {
    isReady = true
    resolveReady()
  }
}

// ---- values: last writer wins -------------------------------------------------------------------

function applyValue(key: string, raw: unknown, by: null | Person) {
  const value = raw ?? undefined

  if (same(values.get(key), value)) {
    return
  }

  if (value === undefined) {
    values.delete(key)
  } else {
    values.set(key, value)
  }

  for (const sub of valueSubs) {
    if (sub.key === key || sub.key === '*') {
      safely(sub.fn, value, key, by)
    }
  }

  for (const el of stateBindings) {
    if (el.dataset.hermesState === key) {
      paintStateBinding(el)
    }
  }
}

const state = {
  get: (key: string) => values.get(key),
  all: () => Object.fromEntries(values),
  /** Applies here at once; the order the server receives sets in decides the value everywhere. */
  set(key: string, value: unknown): boolean {
    if (!canEdit()) {
      return false
    }

    applyValue(key, value, null)

    if (connected) {
      post({ key, op: 'set', value: value ?? null })
    }

    return true
  },
  on(key: string, fn: ValueListener): () => void {
    const sub = { fn, key }
    valueSubs.add(sub)

    if (key !== '*' && isReady) {
      safely(fn, values.get(key), key, null)
    }

    return () => void valueSubs.delete(sub)
  }
}

function paintStateBinding(el: HTMLElement) {
  const value = values.get(el.dataset.hermesState ?? '')
  const shown = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    el.checked = el.type === 'radio' ? value === el.value : Boolean(value)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.value !== shown && document.activeElement !== el) {
      el.value = shown
    }
  } else {
    el.textContent = shown
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    el.disabled = !canEdit()
  }
}

function bindState(el: HTMLElement) {
  const key = el.dataset.hermesState

  if (!key || stateBindings.has(el)) {
    return
  }

  stateBindings.add(el)

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    el.addEventListener('change', () => {
      if (el.type === 'checkbox') {
        state.set(key, el.checked)
      } else if (el.checked) {
        state.set(key, el.value)
      }
    })
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    el.addEventListener('input', () => {
      const numeric = el instanceof HTMLInputElement && el.type === 'number'
      state.set(key, numeric ? (el.value === '' ? null : Number(el.value)) : el.value)
    })
  }

  if (isReady) {
    paintStateBinding(el)
  }
}

// ---- text: simultaneous editing -----------------------------------------------------------------

const editorState = (doc: string, version: number) =>
  EditorState.create({ doc, extensions: [collab({ clientID, startVersion: version })] })

/** One replacement turning `before` into `after` (common prefix and suffix kept). */
function diff(before: string, after: string): null | { from: number; insert: string; to: number } {
  if (before === after) {
    return null
  }

  const limit = Math.min(before.length, after.length)
  let start = 0

  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) {
    start++
  }

  let end = 0

  while (end < limit - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) {
    end++
  }

  return { from: start, insert: after.slice(start, after.length - end), to: before.length - end }
}

function paintText(model: TextModel, except?: Editable, tr?: Transaction) {
  const text = model.state.doc.toString()

  for (const el of model.els) {
    el.readOnly = !canEdit() || model.seeding || !isReady

    if (el === except || model.seeding || el.value === text) {
      continue
    }

    const focused = document.activeElement === el
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    el.value = text

    if (focused && tr) {
      // Keep the caret where it was relative to the text around it, as an editor would.
      const mapped = (pos: number) => tr.changes.mapPos(Math.min(pos, tr.startState.doc.length), 1)
      el.setSelectionRange(mapped(start), mapped(end))
    }
  }

  for (const fn of model.subs) {
    safely(fn, text)
  }
}

function flush(model: TextModel) {
  if (model.inflight || !connected || !canEdit()) {
    return
  }

  const pending = sendableUpdates(model.state)

  if (pending.length === 0) {
    return
  }

  model.inflight = true
  post({
    key: model.key,
    op: 'text.push',
    updates: pending.map(update => ({ changes: update.changes.toJSON(), clientID: update.clientID })),
    version: getSyncedVersion(model.state)
  })
  window.clearTimeout(model.retry)
  model.retry = window.setTimeout(() => {
    model.inflight = false
    flush(model)
  }, PUSH_RETRY_MS)
}

function edit(model: TextModel, next: string, from?: Editable) {
  const change = diff(model.state.doc.toString(), next)

  if (change) {
    model.state = model.state.update({ changes: change }).state
    paintText(model, from)
    flush(model)
  }
}

function receiveText(model: TextModel, start: number, raw: WireUpdate[], reply: boolean) {
  const synced = getSyncedVersion(model.state)

  if (start > synced) {
    post({ key: model.key, op: 'text.pull', version: synced })

    return
  }

  model.seeding = false
  const fresh = raw.slice(synced - start)
  let tr: Transaction | undefined

  if (fresh.length > 0) {
    try {
      tr = receiveUpdates(
        model.state,
        fresh.map(update => ({ changes: ChangeSet.fromJSON(update.changes), clientID: update.clientID }))
      )
    } catch {
      post({ key: model.key, op: 'text.pull', version: 0 })

      return
    }

    model.state = tr.state
  }

  paintText(model, undefined, tr)

  if (reply || fresh.some(update => update.clientID === clientID)) {
    model.inflight = false
    window.clearTimeout(model.retry)
  }

  flush(model)
}

function resetText(model: TextModel, doc: string, version: number) {
  window.clearTimeout(model.retry)
  model.inflight = false
  model.seeding = false
  model.state = editorState(doc, version)
  paintText(model)
}

/** Offer the markup's starting text; the server keeps the first offer and ignores the rest. */
function seed(model: TextModel) {
  if (!model.fallback || !canEdit() || getSyncedVersion(model.state) !== 0 || model.state.doc.length > 0) {
    return
  }

  model.seeding = true
  post({ key: model.key, op: 'text.seed', text: model.fallback })
  window.setTimeout(() => {
    if (model.seeding) {
      model.seeding = false
      paintText(model)
    }
  }, SEED_WAIT_MS)
}

function modelFor(key: string, fallback: string): TextModel {
  const existing = texts.get(key)

  if (existing) {
    return existing
  }

  const known = snapshotTexts.get(key)

  const model: TextModel = {
    els: new Set(),
    fallback,
    inflight: false,
    key,
    retry: 0,
    seeding: false,
    state: editorState(known?.doc ?? '', known?.version ?? 0),
    subs: new Set()
  }

  texts.set(key, model)

  if (connected && !known) {
    // Opened after the snapshot: catch up from the start, then offer the starting text.
    post({ key, op: 'text.pull', version: 0 })
    seed(model)
  }

  return model
}

function text(key: string, el?: Editable | null) {
  const model = modelFor(key, el ? el.value.replace(/\r\n?/g, '\n') : '')

  if (el && !model.els.has(el)) {
    model.els.add(el)
    el.addEventListener('input', () => {
      if (canEdit() && !model.seeding && isReady) {
        edit(model, el.value.replace(/\r\n?/g, '\n'), el)
      } else {
        paintText(model)
      }
    })

    if (isReady) {
      paintText(model)
    } else {
      el.readOnly = true // shows its starting text until the shared one arrives
    }
  }

  return {
    get: () => model.state.doc.toString(),
    /** Replace the whole text; merged with everyone else's edits like any typing. False for a viewer. */
    set(value: string): boolean {
      if (!canEdit()) {
        return false
      }

      edit(model, value)

      return true
    },
    on(fn: (text: string) => void): () => void {
      model.subs.add(fn)
      safely(fn, model.state.doc.toString())

      return () => void model.subs.delete(fn)
    }
  }
}

// ---- presence -----------------------------------------------------------------------------------

let layer: HTMLDivElement | null = null

const docSize = () => {
  const root = document.documentElement

  return {
    height: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0) || 1,
    width: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) || 1
  }
}

function paintPeers() {
  if (document.body) {
    if (!layer) {
      // Fixed and zero-sized: never part of the size the frame reports, so cursors cannot grow it.
      layer = document.createElement('div')
      layer.setAttribute('data-hermes-peers', '')
      layer.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647'
      document.body.appendChild(layer)
    }

    const { height, width } = docSize()
    layer.replaceChildren()

    for (const peer of peers.values()) {
      if (!peer.cursor) {
        continue
      }

      const mark = document.createElement('div')
      mark.setAttribute('data-hermes-peer', peer.name)
      mark.style.cssText = `position:absolute;left:${peer.cursor.x * width - scrollX}px;top:${peer.cursor.y * height - scrollY}px`
      mark.innerHTML =
        '<svg width="14" height="18" viewBox="0 0 14 18" style="display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))">' +
        `<path d="M1 1l12 9-5.5.8L5 17z" fill="${peer.color}" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`
      const tag = document.createElement('span')
      tag.textContent = peer.name
      tag.style.cssText = `position:absolute;left:12px;top:14px;padding:1px 6px;border-radius:999px;background:${peer.color};color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap`
      mark.appendChild(tag)
      layer.appendChild(mark)
    }
  }

  const list = [...peers.values()]

  for (const fn of peerSubs) {
    safely(fn, list)
  }
}

let cursor: null | { x: number; y: number } = null
let cursorSentAt = 0
let cursorTimer = 0

function sendCursor() {
  cursorTimer = 0
  cursorSentAt = Date.now()
  post({ cursor, op: 'cursor' })
}

function noteCursor(next: null | { x: number; y: number }) {
  cursor = next

  if (connected && !cursorTimer) {
    cursorTimer = window.setTimeout(sendCursor, Math.max(0, CURSOR_INTERVAL_MS - (Date.now() - cursorSentAt)))
  }
}

addEventListener('pointermove', event => {
  if (event.pointerType !== 'touch') {
    const { height, width } = docSize()
    noteCursor({ x: event.pageX / width, y: event.pageY / height })
  }
})
document.addEventListener('pointerleave', () => noteCursor(null))

// ---- frames from the server ---------------------------------------------------------------------

function setRole(next: Role) {
  if (next === role) {
    return
  }

  role = next

  for (const model of texts.values()) {
    paintText(model)
  }

  for (const el of stateBindings) {
    paintStateBinding(el)
  }

  for (const fn of roleSubs) {
    safely(fn, role)
  }
}

function onSnapshot(frame: ServerFrame) {
  connected = true
  self = (frame.self as Peer) ?? null
  peers.clear()

  for (const peer of (frame.peers as Peer[]) ?? []) {
    peers.set(peer.id, peer)
  }

  setRole((frame.role as Role) ?? 'participant')
  markReady()
  const incoming = (frame.values as Record<string, unknown>) ?? {}

  for (const key of [...values.keys()]) {
    if (!(key in incoming)) {
      applyValue(key, null, null)
    }
  }

  for (const [key, value] of Object.entries(incoming)) {
    applyValue(key, value, null)
  }

  snapshotTexts.clear()

  for (const [key, entry] of Object.entries((frame.texts as Record<string, { doc: string; version: number }>) ?? {})) {
    snapshotTexts.set(key, entry)
  }

  for (const model of texts.values()) {
    const known = snapshotTexts.get(model.key)
    resetText(model, known?.doc ?? '', known?.version ?? 0)

    if (!known) {
      seed(model)
    }
  }

  for (const el of stateBindings) {
    paintStateBinding(el)
  }

  paintPeers()
}

/** No server to share with: the app runs for this window alone, starting from its markup. */
function goLocal() {
  if (isReady) {
    return
  }

  markReady()

  for (const model of texts.values()) {
    if (model.state.doc.length === 0 && model.fallback) {
      model.state = editorState(model.fallback, 0)
    }

    paintText(model)
  }
}

const handlers: Record<string, (frame: ServerFrame) => void> = {
  snapshot: onSnapshot,
  set(frame) {
    const by = (frame.by as Person | undefined) ?? null
    applyValue(String(frame.key), frame.value, by)
  },
  'text.updates'(frame) {
    const model = texts.get(String(frame.key))

    if (model) {
      receiveText(model, Number(frame.version), (frame.updates as WireUpdate[]) ?? [], frame.reply === true)
    } else {
      snapshotTexts.delete(String(frame.key)) // a later binding pulls it from the start
    }
  },
  'text.reset'(frame) {
    const model = texts.get(String(frame.key))
    const doc = String(frame.doc ?? '')
    const version = Number(frame.version) || 0

    if (model) {
      resetText(model, doc, version)
    } else {
      snapshotTexts.set(String(frame.key), { doc, version })
    }
  },
  peer(frame) {
    if (frame.gone) {
      peers.delete(String(frame.id))
    } else {
      peers.set(String(frame.id), frame as unknown as Peer)
    }

    paintPeers()
  },
  role(frame) {
    setRole((frame.role as Role) ?? 'viewer')
  },
  closed() {
    // The chat stopped being shared with this person: what is on screen stays, read-only.
    connected = false
    peers.clear()
    setRole('viewer')
    paintPeers()
  },
  offline() {
    connected = false
    peers.clear()
    paintPeers()
    goLocal()
  },
  error(frame) {
    if (frame.code === 'read_only') {
      setRole('viewer')
    }
  }
}

addEventListener('message', event => {
  const data = event.data as { frame?: ServerFrame; token?: unknown; type?: unknown } | null

  if (event.source === parent && data?.type === IN && data.token === token && data.frame) {
    handlers[String(data.frame.type)]?.(data.frame)
  }
})

const host = window as unknown as { hermes?: Record<string, unknown> }
const api = (host.hermes ??= {})

Object.assign(api, {
  ready,
  state,
  text,
  presence: {
    peers: () => [...peers.values()],
    get self() {
      return self
    },
    on(fn: (peers: Peer[]) => void): () => void {
      peerSubs.add(fn)
      safely(fn, [...peers.values()])

      return () => void peerSubs.delete(fn)
    }
  },
  onRole(fn: (role: Role) => void): () => void {
    roleSubs.add(fn)

    return () => void roleSubs.delete(fn)
  }
})
// Live accessors, defined rather than assigned: Object.assign would copy today's value once.
Object.defineProperties(api, {
  canEdit: { configurable: true, enumerable: true, get: canEdit },
  role: { configurable: true, enumerable: true, get: () => role }
})

function bindMarkup() {
  document.querySelectorAll<HTMLElement>('[data-hermes-text]').forEach(el => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      text(el.dataset.hermesText ?? '', el)
    }
  })
  document.querySelectorAll<HTMLElement>('[data-hermes-state]').forEach(bindState)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindMarkup)
} else {
  bindMarkup()
}

post({ op: 'hello' })
window.setTimeout(goLocal, OFFLINE_AFTER_MS)
