/** `/api/sharing/*` (hermes_cli/web_routers/sharing.py): owners, people and per-chat access lists. */

import { hermesApi } from './client'

export type ChatRole = 'owner' | 'participant' | 'viewer'
export type ShareRole = Exclude<ChatRole, 'owner'>

export interface SharingPerson {
  principal: string
  name: string
  /** Short account hint, e.g. `nous …a1b2`. */
  label: string
  color: string
}

export interface SharingMe {
  principal: null | string
  person: null | SharingPerson
  /** True once the agent has an owner: from then on everyone else sees only what is shared with them. */
  sharing: boolean
  owner: boolean
  can_claim: boolean
}

export interface ChatAccess {
  chat: string
  role: ChatRole
  can_share: boolean
  creator: null | SharingPerson
  people: (SharingPerson & { role: ShareRole })[]
}

export interface KnownPerson extends SharingPerson {
  last_seen: number
  owner: boolean
}

export const getSharingMe = () => hermesApi<SharingMe>({ path: '/api/sharing/me' })

export const claimAgent = () => hermesApi<{ owner: boolean }>({ method: 'POST', path: '/api/sharing/claim' })

export const listPeople = () => hermesApi<{ people: KnownPerson[] }>({ path: '/api/sharing/people' })

function chatQuery(sessionId: string, profile: null | string): string {
  const params = new URLSearchParams({ session_id: sessionId })

  if (profile) {
    params.set('profile', profile)
  }

  return params.toString()
}

export const getChatAccess = (sessionId: string, profile: null | string) =>
  hermesApi<ChatAccess>({ path: `/api/sharing/chat?${chatQuery(sessionId, profile)}` })

export const setChatAccess = (sessionId: string, profile: null | string, principal: string, role: null | ShareRole) =>
  hermesApi<{ role: null | ShareRole }>({
    body: { principal, profile, role, session_id: sessionId },
    method: 'PUT',
    path: '/api/sharing/chat'
  })

/** The `detail` of a refused request (`"403: {\"detail\": …}"`), else the error text. */
export function sharingErrorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const body = text.replace(/^\d{3}:\s*/, '')

  try {
    const parsed = JSON.parse(body) as { detail?: unknown }

    return typeof parsed.detail === 'string' ? parsed.detail : body
  } catch {
    return body
  }
}
