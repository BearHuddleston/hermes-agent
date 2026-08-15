import { atom } from 'nanostores'

import { previewName } from '@/lib/preview-targets'

/**
 * Session-scoped feed of previewable artifacts (HTML files, localhost dev URLs)
 * a tool produced. Surfaced as compact links in the composer status stack —
 * NOT auto-opened and NOT a bulky inline card. Click opens the rail preview or
 * the browser; both are manual.
 *
 * Fed from the tool row itself (see tool-fallback.tsx) using the same detected
 * target the inline card used, so detection parity is exact.
 */
export interface PreviewArtifact {
  /** Immutable locally stamped registry connection that produced this artifact. */
  connectionId?: string
  /** cwd captured at detection so a relative path still resolves on click. */
  cwd: string
  /** Dedupe key + display id (the raw target). */
  id: string
  label: string
  /** Immutable locally stamped gateway profile that produced this artifact. */
  profile?: string
  target: string
}

const MAX_PER_SESSION = 4
export interface PreviewSessionSource {
  connectionId?: string
  profile: string
}

const previewSourceBySession = new Map<string, PreviewSessionSource>()

export const $previewStatusBySession = atom<Record<string, PreviewArtifact[]>>({})

export function previewSessionSource(sid: string): PreviewSessionSource | undefined {
  return previewSourceBySession.get(sid.trim())
}

export function recordPreviewSessionProfile(sid: string, profile: string, connectionId = '') {
  const sessionId = sid.trim()
  const sourceProfile = profile.trim()
  const sourceConnectionId = connectionId.trim()

  if (sessionId && sourceProfile && !previewSourceBySession.has(sessionId)) {
    previewSourceBySession.set(sessionId, {
      connectionId: sourceConnectionId || undefined,
      profile: sourceProfile
    })
  }
}

const writePreviews = (sid: string, items: PreviewArtifact[]) => {
  const current = $previewStatusBySession.get()

  if (items.length === 0) {
    if (!current[sid]) {
      return
    }

    const next = { ...current }
    delete next[sid]
    $previewStatusBySession.set(next)

    return
  }

  $previewStatusBySession.set({ ...current, [sid]: items })
}

/**
 * Record a detected artifact, newest last, capped. Idempotent: a target already
 * in the list keeps its slot (the tool row re-registers on every render, so this
 * must not churn the atom or reorder rows).
 */
export function recordPreviewArtifact(sid: string, target: string, cwd: string) {
  const raw = target.trim()

  if (!sid || !raw) {
    return
  }

  const list = $previewStatusBySession.get()[sid] ?? []
  const source = previewSourceBySession.get(sid)
  const existingIndex = list.findIndex(item => item.id === raw)

  if (existingIndex >= 0) {
    if (source && !list[existingIndex].profile) {
      const next = [...list]
      next[existingIndex] = { ...next[existingIndex], ...source }
      writePreviews(sid, next)
    }

    return
  }

  writePreviews(sid, [...list, { ...source, cwd, id: raw, label: previewName(raw), target: raw }].slice(-MAX_PER_SESSION))
}

export function dismissPreviewArtifact(sid: string, id: string) {
  const list = $previewStatusBySession.get()[sid]

  if (list) {
    writePreviews(
      sid,
      list.filter(item => item.id !== id)
    )
  }
}

export function clearPreviewArtifacts(sid: string) {
  previewSourceBySession.delete(sid)
  writePreviews(sid, [])
}
