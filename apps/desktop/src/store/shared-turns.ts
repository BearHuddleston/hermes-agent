import { atom, computed } from 'nanostores'

import type { GatewayEventPayload, MessageSender } from '@/lib/chat-messages'

import { $presencePeers, $presenceSelf, LOCAL_PRESENCE_USER, type PresencePeer } from './presence'

/**
 * Who holds the running turn of a chat several signed-in people share
 * (`tui_gateway/shared_turns.py`). The gateway enforces it; this mirror only
 * keeps a window from offering controls the gateway would refuse. Keyed by
 * runtime session id, fed by `session.info` and `message.start`.
 */
export interface SharedTurn {
  /** Who sent the running turn; null when idle or nobody signed in sent it. */
  owner: MessageSender | null
  /** Principal that created the chat (`<provider>:<user id>`). */
  chatOwner: null | string
  control: 'anyone' | 'sender'
}

const IDLE: SharedTurn = { chatOwner: null, control: 'sender', owner: null }

export const $sharedTurns = atom<Record<string, SharedTurn>>({})

export function noteSharedTurn(sessionId: string, patch: Partial<SharedTurn>): void {
  const current = $sharedTurns.get()
  const previous = current[sessionId] ?? IDLE
  const next = { ...previous, ...patch }

  const unchanged =
    sessionId in current &&
    next.chatOwner === previous.chatOwner &&
    next.control === previous.control &&
    next.owner?.id === previous.owner?.id &&
    next.owner?.name === previous.owner?.name

  if (!unchanged) {
    $sharedTurns.set({ ...current, [sessionId]: next })
  }
}

/** `message.start`: who holds the turn that just started, when the frame names one (shared chats only). */
export function noteTurnStart(sessionId: string, payload: GatewayEventPayload | undefined): void {
  if (payload && 'owner' in payload) {
    noteSharedTurn(sessionId, { owner: payload.owner ?? null })
  }
}

/** `session.info`: the running turn's owner, the chat's creator and the policy, when the gateway shares them. */
export function noteSessionInfoTurn(sessionId: null | string | undefined, payload: GatewayEventPayload | undefined): void {
  if (!sessionId || !payload || !('turn_control' in payload)) {
    return
  }

  noteSharedTurn(sessionId, {
    chatOwner: payload.chat_owner ?? null,
    control: payload.turn_control === 'anyone' ? 'anyone' : 'sender',
    owner: payload.turn_owner ?? null
  })
}

/** The signed-in principal of this window; null for the loopback operator, which the gateway never gates. */
function selfPrincipal(): null | string {
  const user = $presenceSelf.get()?.user ?? null

  return user === LOCAL_PRESENCE_USER ? null : user
}

/**
 * The person whose turn this window may not act on, or null when it may: the
 * gateway's `_may_act_on_turn` seen from the window. A window with no sign-in
 * (`self` null) is never locked. `peers` names the chat's creator when it holds
 * a turn nobody signed in sent (a goal follow-up, a wake-up).
 */
export function turnHolder(
  turn: SharedTurn | undefined,
  self: null | string,
  peers: readonly Pick<PresencePeer, 'color' | 'name' | 'user'>[]
): MessageSender | null {
  if (!turn || !self || turn.control === 'anyone') {
    return null
  }

  const { chatOwner, owner } = turn

  if (!owner) {
    if (!chatOwner || chatOwner === self) {
      return null
    }

    const creator = peers.find(peer => peer.user === chatOwner)

    return { color: creator?.color ?? '#6b7280', id: chatOwner, name: creator?.name ?? '' }
  }

  const ownerHere = peers.some(peer => peer.user === owner.id)

  return owner.id === self || (self === chatOwner && !ownerHere) ? null : owner
}

/** Non-reactive check for event handlers and submit paths. */
export function sessionTurnHolder(sessionId: null | string | undefined): MessageSender | null {
  return sessionId ? turnHolder($sharedTurns.get()[sessionId], selfPrincipal(), $presencePeers.get()) : null
}

/** Reactive twin for components (composer, approval cards, prompt dialogs). */
export const sessionTurnLock = (sessionId: null | string | undefined) =>
  computed([$sharedTurns, $presenceSelf, $presencePeers], (turns, self, peers) =>
    sessionId
      ? turnHolder(turns[sessionId], self?.user === LOCAL_PRESENCE_USER ? null : (self?.user ?? null), peers)
      : null
  )
