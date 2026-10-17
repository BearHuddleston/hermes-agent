/**
 * Relay between chat apps' sandboxed frames and `/api/apps`, one per frame token.
 *
 * Module-level rather than per component: a frame kept across a remount of its message
 * (components/assistant-ui/kept-frames.ts) keeps its relay and its place on the server. The frame's
 * runtime says `hello` once it listens (again after every srcdoc reload); each hello opens the app afresh,
 * so the frame starts from a snapshot. Every other message is checked against the frame's token and
 * relayed as one of the few operations the server accepts.
 */

import { type AppServerFrame, openSharedApp, type SharedApp } from '@/lib/apps-client'

import { APP_IN_MESSAGE_TYPE, APP_MESSAGE_TYPE, appOpFromMessage } from './protocol'

export interface AppTarget {
  /** False for pages that do not use the runtime: nothing is opened. */
  enabled: boolean
  /** Absolute path of the app's HTML file. */
  file: null | string
  profile: null | string
  /** Stored session id of the chat the app belongs to; null for a chat not saved yet. */
  sessionId: null | string
}

interface Relay {
  token: string
  target: AppTarget
  frame: null | Window
  app: null | SharedApp
}

const relays = new Map<string, Relay>()
let listening = false

const sameTarget = (a: AppTarget, b: AppTarget) =>
  a.enabled === b.enabled && a.file === b.file && a.profile === b.profile && a.sessionId === b.sessionId

function open(relay: Relay): void {
  relay.app?.close()
  relay.app = null
  const { enabled, file, profile, sessionId } = relay.target

  if (!enabled || !file || !relay.frame) {
    return
  }

  const toFrame = (frame: AppServerFrame) =>
    relay.frame?.postMessage({ frame, token: relay.token, type: APP_IN_MESSAGE_TYPE }, '*')

  if (sessionId) {
    relay.app = openSharedApp({ file, onFrame: toFrame, profile, sessionId })
  } else {
    toFrame({ type: 'offline' }) // a chat not saved yet: the app runs for this window alone
  }
}

function onMessage(event: MessageEvent): void {
  const data = event.data as { token?: unknown; type?: unknown } | null

  if (data?.type !== APP_MESSAGE_TYPE || typeof data.token !== 'string') {
    return
  }

  const relay = relays.get(data.token)
  const op = relay ? appOpFromMessage(event.data, relay.token) : null

  if (!relay || !op) {
    return
  }

  if (op.op === 'hello') {
    relay.frame = event.source as null | Window
    open(relay)
  } else if (event.source === relay.frame) {
    relay.app?.relay(op)
  }
}

/** Start relaying for the frame behind `token`, or point its relay at a new target (a chat saved later). */
export function bindAppRelay(token: string, target: AppTarget): void {
  if (!listening) {
    window.addEventListener('message', onMessage)
    listening = true
  }

  const relay = relays.get(token)

  if (!relay) {
    relays.set(token, { app: null, frame: null, target, token })
  } else if (!sameTarget(relay.target, target)) {
    relay.target = target
    open(relay)
  }
}

export function disposeAppRelay(token: string): void {
  relays.get(token)?.app?.close()
  relays.delete(token)
}
