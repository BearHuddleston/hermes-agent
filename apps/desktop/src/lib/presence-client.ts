/**
 * One `/api/presence` socket per window (POC). Joins the room of the chat on
 * screen, streams this window's pointer anchor and typing flag, and mirrors
 * everyone else in the room into `$presencePeers`.
 *
 * Presence is cosmetic and lossy: a failed connect retries with backoff and
 * never blocks chat. Identity is whatever the server stamped on the socket;
 * the only thing this window chooses is its display name.
 */

import type { PresenceCursor } from '@/lib/presence-anchor'
import { resolveSiblingWsUrl } from '@/lib/sibling-ws-url'
import { persistString, storedString } from '@/lib/storage'
import { $presencePeers, $presenceSelf, type PresencePeer, type PresenceSelf } from '@/store/presence'
import { onAccessChanged } from '@/store/sharing'

const NAME_KEY = 'hermes.webapp.presence.name.v1'
const CURSOR_INTERVAL_MS = 50
const TYPING_IDLE_MS = 4_000
const TYPING_HEARTBEAT_MS = 3_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 15_000

interface PeerState {
  id: string
  user: string
  label: string
  name: string
  color: string
  cursor: null | PresenceCursor
  typing: boolean
}

type PresenceFrame =
  | { type: 'access'; room: string; removed: boolean }
  | { type: 'error'; code: string }
  | { type: 'peers'; room: string; updates: (PeerState | { id: string; gone: true })[] }
  | { type: 'room'; room: string; peers: PeerState[] }
  | { type: 'self'; self: PeerState }

/** Fold one server frame into the peer list (pure; `now` stamps typing freshness). */
export function applyPresenceFrame(
  peers: readonly PresencePeer[],
  frame: PresenceFrame,
  now: number
): { peers: readonly PresencePeer[]; self?: PresenceSelf } {
  if (frame.type === 'self') {
    const { color, id, label, name, user } = frame.self

    return { peers, self: { color, id, label, name, user } }
  }

  if (frame.type === 'room') {
    return { peers: frame.peers.map(peer => ({ ...peer, seenAt: now })) }
  }

  if (frame.type !== 'peers') {
    return { peers }
  }

  const byId = new Map(peers.map(peer => [peer.id, peer]))

  for (const update of frame.updates) {
    if ('gone' in update) {
      byId.delete(update.id)
    } else {
      byId.set(update.id, { ...update, seenAt: now })
    }
  }

  return { peers: [...byId.values()] }
}

class PresenceConnection {
  private socket: null | WebSocket = null
  private connecting = false
  private retryMs = RETRY_MIN_MS
  private retryTimer: null | number = null
  private room: null | string = null
  private profile: null | string = null
  private cursor: null | PresenceCursor = null
  private cursorDirty = false
  private cursorTimer: null | number = null
  private typing = false
  private typingSentAt = 0
  private typingIdleTimer: null | number = null

  join(room: null | string, profile: null | string) {
    if (room === this.room && profile === this.profile) {
      return
    }

    const profileChanged = profile !== this.profile
    this.room = room
    this.profile = profile
    this.cursor = null
    this.stopTyping()
    $presencePeers.set([])

    if (profileChanged && this.socket) {
      // The socket's credential was minted for the previous profile route.
      this.socket.close()

      return
    }

    if (this.open()) {
      this.send({ type: 'join', room })
    } else if (room) {
      this.connect()
    }
  }

  setCursor(cursor: null | PresenceCursor) {
    if (cursor === null && this.cursor === null) {
      return // moving around outside the chat: nothing new to say
    }

    this.cursor = cursor
    this.cursorDirty = true

    if (this.cursorTimer === null) {
      this.flushCursor()
    }
  }

  noteInput(hasText: boolean) {
    if (!hasText) {
      this.stopTyping()

      return
    }

    const now = Date.now()

    if (!this.typing || now - this.typingSentAt > TYPING_HEARTBEAT_MS) {
      this.typing = true
      this.typingSentAt = now
      this.send({ type: 'typing', typing: true })
    }

    if (this.typingIdleTimer !== null) {
      window.clearTimeout(this.typingIdleTimer)
    }

    this.typingIdleTimer = window.setTimeout(() => this.stopTyping(), TYPING_IDLE_MS)
  }

  rename(name: string) {
    const clean = name.trim().slice(0, 40)

    if (!clean) {
      return
    }

    persistString(NAME_KEY, clean)
    this.send({ type: 'name', name: clean })
  }

  private stopTyping() {
    if (this.typingIdleTimer !== null) {
      window.clearTimeout(this.typingIdleTimer)
      this.typingIdleTimer = null
    }

    if (this.typing) {
      this.typing = false
      this.send({ type: 'typing', typing: false })
    }
  }

  private flushCursor() {
    this.cursorTimer = null

    if (!this.cursorDirty) {
      return
    }

    this.cursorDirty = false
    this.send({ type: 'cursor', cursor: this.cursor })
    this.cursorTimer = window.setTimeout(() => this.flushCursor(), CURSOR_INTERVAL_MS)
  }

  private open() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private send(frame: Record<string, unknown>) {
    if (this.open()) {
      this.socket!.send(JSON.stringify(frame))
    }
  }

  private connect() {
    if (this.connecting || this.socket || this.retryTimer !== null) {
      return
    }

    this.connecting = true
    const profile = this.profile

    void resolveSiblingWsUrl({ profile }, '/api/presence')
      .then(url => {
        this.connecting = false

        if (profile !== this.profile || !this.room) {
          return this.room ? this.connect() : undefined
        }

        this.attach(new WebSocket(url))
      })
      .catch(() => {
        this.connecting = false
        this.scheduleRetry()
      })
  }

  private attach(socket: WebSocket) {
    this.socket = socket

    socket.onopen = () => {
      this.retryMs = RETRY_MIN_MS
      const name = storedString(NAME_KEY)

      if (name) {
        this.send({ type: 'name', name })
      }

      this.send({ type: 'join', room: this.room })

      if (this.cursor) {
        this.setCursor(this.cursor)
      }
    }

    socket.onmessage = event => {
      let frame: PresenceFrame

      try {
        frame = JSON.parse(String(event.data)) as PresenceFrame
      } catch {
        return
      }

      if (frame.type === 'access') {
        // The chat's owner changed this person's role (or removed them): re-read it.
        onAccessChanged(frame.room, frame.removed)

        return
      }

      const next = applyPresenceFrame($presencePeers.get(), frame, Date.now())

      if (next.self) {
        $presenceSelf.set(next.self)
      }

      if (next.peers !== $presencePeers.get()) {
        $presencePeers.set([...next.peers])
      }
    }

    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null
        $presencePeers.set([])

        if (this.room) {
          this.scheduleRetry()
        }
      }
    }
  }

  private scheduleRetry() {
    if (this.retryTimer !== null) {
      return
    }

    const delay = this.retryMs
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null

      if (this.room) {
        this.connect()
      }
    }, delay)
  }
}

let connection: null | PresenceConnection = null

function presence(): PresenceConnection {
  connection ??= new PresenceConnection()

  return connection
}

export const presenceJoin = (room: null | string, profile: null | string) => presence().join(room, profile)
export const presenceSetCursor = (cursor: null | PresenceCursor) => presence().setCursor(cursor)
export const presenceNoteInput = (hasText: boolean) => presence().noteInput(hasText)
export const presenceRename = (name: string) => presence().rename(name)

/** Room key for a chat: profile plus the durable (lineage-root) session id. */
export function presenceRoom(profile: null | string | undefined, sessionKey: null | string | undefined): null | string {
  const session = (sessionKey ?? '').trim()

  return session ? `${(profile ?? '').trim() || 'default'}:${session}` : null
}
