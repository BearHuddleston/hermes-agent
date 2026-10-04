/** Settlement shared by independent windows; the boot cache is only a preview. */
import { readJson, writeJson } from '@/lib/storage'

export type AppearanceField = 'theme' | 'theme_mode'

interface Picks {
  owner: string
  generation: string
  confirmed: string | null
  preview: { id: string; value: string } | null
}

interface Pick {
  key: string
  owner: string
  generation: string
  id: string
  value: string
}

// IDs identify UI writes only; they are not credentials.
const uniqueId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const fallback = new Map<string, Picks>()

const keyFor = (profile: string, field: AppearanceField) =>
  `hermes-desktop-appearance-picks-v1:${JSON.stringify([profile, field])}`

function read(key: string): Picks | null {
  const value = readJson<Picks>(key) ?? fallback.get(key)

  return value && typeof value.owner === 'string' && typeof value.generation === 'string' &&
    (value.confirmed === null || typeof value.confirmed === 'string') &&
    (value.preview === null || (typeof value.preview?.id === 'string' && typeof value.preview.value === 'string'))
    ? value : null
}

function write(key: string, value: Picks): void {
  writeJson(key, value)

  // Preserve local rollback when storage is unavailable; successful storage
  // always wins, so clearing it cannot revive old per-window state.
  if (readJson(key) === null) { fallback.set(key, value) } else { fallback.delete(key) }
}

export function confirmAppearance(profile: string, field: AppearanceField, owner: string, value: string): void {
  write(keyFor(profile, field), { owner, generation: uniqueId(), confirmed: value, preview: null })
}

export function beginAppearancePick(profile: string, field: AppearanceField, owner: string, previous: string | null, value: string): Pick {
  const key = keyFor(profile, field)
  const prior = read(key)

  const picks: Picks = prior?.owner === owner ? prior : {
    owner, generation: uniqueId(), confirmed: previous, preview: null
  }

  const id = uniqueId()
  picks.preview = { id, value }
  write(key, picks)

  return { key, owner, generation: picks.generation, id, value }
}

/** undefined means another owner/read or an untracked peer owns the cache. */
export function settleAppearancePick(pick: Pick, saved: boolean, cached: string | null): string | null | undefined {
  const picks = read(pick.key)

  if (!picks || picks.owner !== pick.owner || picks.generation !== pick.generation ||
    cached !== (picks.preview?.value ?? picks.confirmed)) { return undefined }

  if (saved) { picks.confirmed = pick.value }

  if (picks.preview?.id === pick.id) { picks.preview = null }
  write(pick.key, picks)

  // An earlier success is the fallback, not permission to replace a peer's
  // pending preview. Once that preview fails, every window uses this value.
  return picks.preview ? undefined : picks.confirmed
}

/** Coordination is discarded on delete/rename; in-flight writes must not follow a name. */
export function clearAppearancePicks(profile: string): void {
  for (const field of ['theme', 'theme_mode'] as const) {
    const key = keyFor(profile, field)
    fallback.delete(key)
    writeJson(key, null)
  }
}
