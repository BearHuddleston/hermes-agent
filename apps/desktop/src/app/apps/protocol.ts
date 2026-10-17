/**
 * Messages between a chat app's sandboxed frame and the window hosting it.
 *
 * The frame (`frame-runtime.ts`) has an opaque origin and no credential: it can
 * only `postMessage` its parent. The parent checks every message against the
 * mount's token, keeps only the operations below, stamps the app handle itself
 * and relays them over `/api/apps` (`lib/apps-client.ts`); the server checks
 * the chat's access list (`hermes_cli/web_apps.py`).
 */

export const APP_MESSAGE_TYPE = 'hermes-app'
/** Parent → frame: one `/api/apps` server frame for this app, tagged with the mount token. */
export const APP_IN_MESSAGE_TYPE = 'hermes-app-in'
/** Keys of shared values and texts (mirrors `KEY_RE` in hermes_cli/web_apps.py). */
export const APP_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_UPDATES = 200
const MAX_SEED_LENGTH = 200_000

/** Does a page use the shared-state runtime? Pages that only `hermes.send` skip it. */
export function usesAppRuntime(doc: string): boolean {
  return /hermes\.(?:state|text|presence|ready|role)\b|data-hermes-(?:text|state)\b/.test(doc)
}

export interface TextUpdate {
  clientID: string
  changes: unknown[]
}

export interface AppCursor {
  x: number
  y: number
}

export type AppOp =
  | { op: 'cursor'; cursor: AppCursor | null }
  | { op: 'hello' }
  | { op: 'set'; key: string; value: unknown }
  | { op: 'text.pull'; key: string; version: number }
  | { op: 'text.push'; key: string; updates: TextUpdate[]; version: number }
  | { op: 'text.seed'; key: string; text: string }

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isUnit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function textUpdates(raw: unknown): null | TextUpdate[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPDATES) {
    return null
  }

  const updates: TextUpdate[] = []

  for (const item of raw) {
    const update = item as { changes?: unknown; clientID?: unknown }

    if (typeof update?.clientID !== 'string' || !CLIENT_ID_RE.test(update.clientID) || !Array.isArray(update.changes)) {
      return null
    }

    updates.push({ changes: update.changes, clientID: update.clientID })
  }

  return updates
}

type FrameMessage = Record<string, unknown>
type OpParser = (message: FrameMessage, key: null | string) => AppOp | null

/** Parsers for the operations that address one shared value or text by `key`. */
const keyed =
  (parse: (message: FrameMessage, key: string) => AppOp | null): OpParser =>
  (message, key) =>
    key ? parse(message, key) : null

function cursorOp(raw: unknown): AppOp | null {
  if (raw === null) {
    return { cursor: null, op: 'cursor' }
  }

  const cursor = raw as Record<string, unknown> | undefined

  return cursor && isUnit(cursor.x) && isUnit(cursor.y)
    ? { cursor: { x: Math.min(1, Math.max(0, cursor.x)), y: Math.min(1, Math.max(0, cursor.y)) }, op: 'cursor' }
    : null
}

function textPushOp(message: FrameMessage, key: string): AppOp | null {
  const updates = textUpdates(message.updates)

  return updates && isVersion(message.version) ? { key, op: 'text.push', updates, version: message.version } : null
}

const OP_PARSERS: Readonly<Record<string, OpParser>> = {
  cursor: message => cursorOp(message.cursor),
  hello: () => ({ op: 'hello' }),
  set: keyed((message, key) => ('value' in message ? { key, op: 'set', value: message.value } : null)),
  'text.pull': keyed((message, key) =>
    isVersion(message.version) ? { key, op: 'text.pull', version: message.version } : null
  ),
  'text.push': keyed(textPushOp),
  'text.seed': keyed((message, key) =>
    typeof message.text === 'string' && message.text.length <= MAX_SEED_LENGTH
      ? { key, op: 'text.seed', text: message.text }
      : null
  )
}

/** A frame→parent message as an operation, or null unless it is ours, carries
 *  this mount's token and is well formed. Anything inside the frame can post,
 *  so nothing is relayed unchecked (an `op` naming an Object prototype member
 *  included). */
export function appOpFromMessage(data: unknown, token: string): AppOp | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const message = data as FrameMessage

  if (message.type !== APP_MESSAGE_TYPE || message.token !== token || typeof message.op !== 'string') {
    return null
  }

  const parse = Object.hasOwn(OP_PARSERS, message.op) ? OP_PARSERS[message.op] : null
  const key = typeof message.key === 'string' && APP_KEY_RE.test(message.key) ? message.key : null

  return parse ? parse(message, key) : null
}

/** The `/api/apps` frame for an operation from the app mounted as `handle`. */
export function serverFrameForOp(op: Exclude<AppOp, { op: 'hello' }>, handle: string): Record<string, unknown> {
  const { op: type, ...rest } = op

  return { ...rest, handle, type }
}
