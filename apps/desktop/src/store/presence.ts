import { atom } from 'nanostores'

import type { PresenceCursor } from '@/lib/presence-anchor'

/** One other window in the same chat. `user` is the server-verified principal. */
export interface PresencePeer {
  id: string
  user: string
  /** Account hint, e.g. `nous …a1b2`. */
  label: string
  name: string
  color: string
  cursor: null | PresenceCursor
  typing: boolean
  /** Local receipt time of the last update, for the typing TTL. */
  seenAt: number
}

export interface PresenceSelf {
  id: string
  user: string
  label: string
  name: string
  color: string
}

/** The loopback operator: a single-user host with no login. */
export const LOCAL_PRESENCE_USER = 'local:operator'

/** A peer still typing after this long without an update stopped (a crashed window never says so). */
export const PEER_TYPING_TTL_MS = 6_000

export const $presenceSelf = atom<null | PresenceSelf>(null)
export const $presencePeers = atom<PresencePeer[]>([])

export interface PresenceUser {
  user: string
  label: string
  name: string
  color: string
  typing: boolean
  windows: number
}

/** Peers folded to one entry per person (a person may have several windows open). */
export function presenceUsers(peers: readonly PresencePeer[], now = Date.now()): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>()

  for (const peer of peers) {
    const typing = peer.typing && now - peer.seenAt < PEER_TYPING_TTL_MS
    const existing = byUser.get(peer.user)

    if (existing) {
      existing.windows += 1
      existing.typing ||= typing
    } else {
      byUser.set(peer.user, { color: peer.color, label: peer.label, name: peer.name, typing, user: peer.user, windows: 1 })
    }
  }

  return [...byUser.values()]
}
