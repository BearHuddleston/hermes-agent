/**
 * One `/api/apps` socket per window, shared by every chat app on screen
 * (hermes_cli/web_apps.py). Each mounted app gets a handle; its frame's
 * operations go out stamped with that handle and the server's frames for it
 * come back to its listener. Lossy like presence: a dropped socket reconnects
 * with backoff and every open app re-opens, getting a fresh snapshot.
 */

import type { AppOp } from '@/app/apps/protocol'
import { serverFrameForOp } from '@/app/apps/protocol'
import { resolveSiblingWsUrl } from '@/lib/sibling-ws-url'

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 15_000
/** Frames an app gets when the socket cannot carry it (refused, dropped, no route). */
const OFFLINE = { type: 'offline' } as const

export type AppServerFrame = Record<string, unknown> & { type: string }

export interface AppMount {
  profile: null | string
  sessionId: string
  file: string
  onFrame: (frame: AppServerFrame) => void
}

export interface SharedApp {
  close: () => void
  relay: (op: Exclude<AppOp, { op: 'hello' }>) => void
}

class AppsConnection {
  private socket: null | WebSocket = null
  private connecting = false
  private retryMs = RETRY_MIN_MS
  private retryTimer: null | number = null
  private profile: null | string = null
  private nextHandle = 0
  private readonly mounts = new Map<string, AppMount>()

  open(mount: AppMount): SharedApp {
    const handle = `a${++this.nextHandle}`

    if (this.mounts.size > 0 && mount.profile !== this.profile) {
      // One socket serves one profile route; an app of another profile runs locally.
      mount.onFrame(OFFLINE)

      return { close: () => {}, relay: () => {} }
    }

    this.profile = mount.profile
    this.mounts.set(handle, mount)

    if (this.ready()) {
      this.sendOpen(handle, mount)
    } else {
      this.connect()
    }

    return {
      close: () => {
        if (!this.mounts.delete(handle)) {
          return
        }

        this.send({ handle, type: 'close' })

        if (this.mounts.size === 0) {
          this.socket?.close()
        }
      },
      relay: op => {
        if (this.mounts.has(handle)) {
          this.send(serverFrameForOp(op, handle))
        }
      }
    }
  }

  private ready() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private send(frame: Record<string, unknown>) {
    if (this.ready()) {
      this.socket!.send(JSON.stringify(frame))
    }
  }

  private sendOpen(handle: string, mount: AppMount) {
    this.send({ file: mount.file, handle, profile: mount.profile, session_id: mount.sessionId, type: 'open' })
  }

  private connect() {
    if (this.connecting || this.socket || this.retryTimer !== null || this.mounts.size === 0) {
      return
    }

    this.connecting = true
    const profile = this.profile

    void resolveSiblingWsUrl({ profile }, '/api/apps')
      .then(url => {
        this.connecting = false

        if (this.mounts.size > 0) {
          this.attach(new WebSocket(url))
        }
      })
      .catch(() => {
        this.connecting = false
        this.goOffline()
        this.scheduleRetry()
      })
  }

  private attach(socket: WebSocket) {
    this.socket = socket

    socket.onopen = () => {
      this.retryMs = RETRY_MIN_MS

      for (const [handle, mount] of this.mounts) {
        this.sendOpen(handle, mount)
      }
    }

    socket.onmessage = event => {
      let frame: AppServerFrame

      try {
        frame = JSON.parse(String(event.data)) as AppServerFrame
      } catch {
        return
      }

      const mount = typeof frame.handle === 'string' ? this.mounts.get(frame.handle) : undefined

      if (!mount) {
        return
      }

      if (frame.type === 'error' && OPEN_REFUSALS.has(String(frame.code))) {
        // This app cannot be shared (no saved chat yet, not shared with us, gone): it runs locally.
        mount.onFrame(OFFLINE)

        return
      }

      mount.onFrame(frame)
    }

    socket.onclose = () => {
      if (this.socket !== socket) {
        return
      }

      this.socket = null
      this.goOffline()

      if (this.mounts.size > 0) {
        this.scheduleRetry()
      }
    }
  }

  private goOffline() {
    for (const mount of this.mounts.values()) {
      mount.onFrame(OFFLINE)
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
      this.connect()
    }, delay)
  }
}

const OPEN_REFUSALS = new Set(['not_found', 'not_shared', 'unavailable', 'app_full', 'too_many_apps', 'bad_frame'])

let connection: AppsConnection | null = null

/** Open a chat app on the window's shared socket. */
export function openSharedApp(mount: AppMount): SharedApp {
  connection ??= new AppsConnection()

  return connection.open(mount)
}
