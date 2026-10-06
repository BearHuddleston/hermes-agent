import { atom, computed, type ReadableAtom } from 'nanostores'

import { type ChatAccess, getChatAccess, getSharingMe, type SharingMe } from '@/api/sharing'

/**
 * Who this window is on a shared agent, and its role in each chat it opened
 * (hermes_cli/web_sharing.py). The server enforces every role; these mirrors
 * only keep the window from offering what it would refuse.
 */
export const $sharingMe = atom<null | SharingMe>(null)

/** Access lists by chat room (`<profile>:<lineage root>`); null when the chat is not shared with us. */
export const $chatAccess = atom<Record<string, ChatAccess | null>>({})

export async function refreshSharingMe(): Promise<null | SharingMe> {
  try {
    const me = await getSharingMe()
    $sharingMe.set(me)

    return me
  } catch {
    return $sharingMe.get() // an older backend has no sharing routes: nothing is restricted
  }
}

const inflight = new Map<string, Promise<ChatAccess | null>>()

export function refreshChatAccess(room: string): Promise<ChatAccess | null> {
  const pending = inflight.get(room)

  if (pending) {
    return pending
  }

  const separator = room.indexOf(':')
  const profile = room.slice(0, separator)
  const sessionId = room.slice(separator + 1)

  const request = getChatAccess(sessionId, profile)
    .catch(() => null)
    .then(access => {
      $chatAccess.set({ ...$chatAccess.get(), [room]: access })

      return access
    })
    .finally(() => inflight.delete(room))

  inflight.set(room, request)

  return request
}

/** Rooms whose owner took this person's access away while a window had them open. */
export const $accessRemoved = atom<ReadonlySet<string>>(new Set())

/** The presence socket says the owner changed this person's access to `room`: re-read the role. */
export function onAccessChanged(room: string, removed: boolean): void {
  if (removed) {
    $accessRemoved.set(new Set([...$accessRemoved.get(), room]))
    $chatAccess.set({ ...$chatAccess.get(), [room]: null })

    return
  }

  if ($accessRemoved.get().has(room)) {
    const next = new Set($accessRemoved.get())
    next.delete(room)
    $accessRemoved.set(next)
  }

  void refreshChatAccess(room)
}

const readOnlyByRoom = new Map<string, ReadableAtom<boolean>>()

/** True when this window may follow the chat but not send to it: a viewer, or someone whose access was
 *  just removed. Unknown counts as allowed (the server still refuses what it must). */
export function chatReadOnly(room: null | string): ReadableAtom<boolean> {
  const key = room ?? ''
  let store = readOnlyByRoom.get(key)

  if (!store) {
    store = computed(
      [$chatAccess, $accessRemoved],
      (access, removed) => Boolean(key) && (access[key]?.role === 'viewer' || removed.has(key))
    )
    readOnlyByRoom.set(key, store)
  }

  return store
}
