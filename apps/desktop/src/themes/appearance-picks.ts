/** Settlement shared by independent windows; the boot cache is only a preview. */
import { readJson, writeJson } from '@/lib/storage'

export type AppearanceField = 'theme' | 'theme_mode'

interface Picks {
  owner: string
  generation: string
  confirmed: string | null
  preview: { id: string; value: string } | null
  /** The last save that landed, and the window that settled it. */
  saved?: { id: string; window: string } | null
}

interface Pick {
  key: string
  owner: string
  generation: string
  id: string
  value: string
  /** `saved.id` when this pick began. */
  saved: string | null
}

export interface Settlement {
  /** What every window paints now; undefined leaves the cache alone. */
  value?: string | null
  /** This save landed, but another window's save or read raced it: only a fresh read knows the backend's order. */
  reconcile: boolean
}

/** Another window began a pick or landed a save in this slot. */
export interface PeerPickChange {
  profile: string
  field: AppearanceField
  owner: string
  /** A new pick, which supersedes this window's pending one. */
  picked: boolean
}

// IDs identify UI writes only; they are not credentials.
const uniqueId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const fallback = new Map<string, Picks>()
// This window's saves for an owner land in pick order (one queue); another window's are unordered.
const thisWindow = uniqueId()
const KEY_PREFIX = 'hermes-desktop-appearance-picks-v1:'

const keyFor = (profile: string, field: AppearanceField) => `${KEY_PREFIX}${JSON.stringify([profile, field])}`

function read(key: string): Picks | null {
  const value = readJson<Picks>(key) ?? fallback.get(key)

  return value && typeof value.owner === 'string' && typeof value.generation === 'string' &&
    (value.confirmed === null || typeof value.confirmed === 'string') &&
    (value.preview === null || (typeof value.preview?.id === 'string' && typeof value.preview.value === 'string')) &&
    (!value.saved || (typeof value.saved.id === 'string' && typeof value.saved.window === 'string'))
    ? value : null
}

function write(key: string, value: Picks): void {
  writeJson(key, value)

  // Preserve local rollback when storage is unavailable; successful storage
  // always wins, so clearing it cannot revive old per-window state.
  if (readJson(key) === null) { fallback.set(key, value) } else { fallback.delete(key) }
}

export function confirmAppearance(profile: string, field: AppearanceField, owner: string, value: string): void {
  write(keyFor(profile, field), { owner, generation: uniqueId(), confirmed: value, preview: null, saved: null })
}

export function beginAppearancePick(profile: string, field: AppearanceField, owner: string, previous: string | null, value: string): Pick {
  const key = keyFor(profile, field)
  const prior = read(key)

  const picks: Picks = prior?.owner === owner ? prior : {
    owner, generation: uniqueId(), confirmed: previous, preview: null, saved: null
  }

  const id = uniqueId()
  picks.preview = { id, value }
  write(key, picks)

  return { key, owner, generation: picks.generation, id, value, saved: picks.saved?.id ?? null }
}

/**
 * A save's `{ ok }` says it landed, not when. Since this pick began, a
 * confirmed read (new generation) or another window's landed save leaves the
 * order unknown: such a save repaints nothing, moves `confirmed` only when it
 * is what this slot already paints, and asks for a fresh read. A failed save
 * changed nothing to re-read. Every landed save is recorded, so other
 * windows' pending picks and older reads learn of it. Another owner's slot is
 * not ours to settle.
 */
export function settleAppearancePick(pick: Pick, saved: boolean, cached: string | null): Settlement {
  const picks = read(pick.key)

  if (!picks || picks.owner !== pick.owner) { return { reconcile: false } }

  const unordered = picks.generation !== pick.generation ||
    (!!picks.saved && picks.saved.id !== pick.saved && picks.saved.window !== thisWindow)

  // Otherwise a newer read or an untracked peer owns the cache.
  const tracked = picks.generation === pick.generation && cached === (picks.preview?.value ?? picks.confirmed)

  if (saved) {
    if (tracked && (!unordered || picks.preview?.id === pick.id)) { picks.confirmed = pick.value }
    picks.saved = { id: uniqueId(), window: thisWindow }
  }

  if (tracked && picks.preview?.id === pick.id) { picks.preview = null }

  if (saved || tracked) { write(pick.key, picks) }

  const reconcile = saved && unordered

  // An earlier success is the fallback, not permission to replace a peer's
  // pending preview. Once that preview fails, every window uses this value.
  return { value: !tracked || picks.preview || reconcile ? undefined : picks.confirmed, reconcile }
}

/**
 * Another window's pick or landed save, even one that left the cached value as
 * it was: a read begun before it no longer speaks for the backend. A confirmed
 * read is neither; whatever it changes reaches peers through the cache.
 */
export function peerPickChange(event: StorageEvent): PeerPickChange | null {
  const parse = (raw: null | string): unknown => {
    try { return JSON.parse(raw ?? 'null') } catch { return null }
  }

  const slot = event.key?.startsWith(KEY_PREFIX) ? parse(event.key.slice(KEY_PREFIX.length)) : null

  // Peers write every key (session drafts, plain strings); only a slot's values are parsed.
  if (!Array.isArray(slot) || typeof slot[0] !== 'string' || (slot[1] !== 'theme' && slot[1] !== 'theme_mode')) {
    return null
  }

  const [before, after] = [event.oldValue, event.newValue].map(raw => parse(raw) as Partial<Picks> | null)

  if (typeof after?.owner !== 'string') {
    return null
  }

  const picked = !!after.preview?.id && after.preview.id !== before?.preview?.id
  const saved = !!after.saved?.id && after.saved.id !== before?.saved?.id

  return picked || saved ? { profile: slot[0], field: slot[1], owner: after.owner, picked } : null
}

/** Coordination is discarded on delete/rename; in-flight writes must not follow a name. */
export function clearAppearancePicks(profile: string, owner: string): void {
  for (const field of ['theme', 'theme_mode'] as const) {
    const key = keyFor(profile, field)

    if (read(key)?.owner !== owner) { continue }
    fallback.delete(key)
    writeJson(key, null)
  }
}
