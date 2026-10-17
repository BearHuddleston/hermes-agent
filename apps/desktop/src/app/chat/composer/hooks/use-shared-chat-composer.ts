import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { useTurnHolder } from '@/app/chat/presence/turn-holder'
import { useI18n } from '@/i18n'
import type { MessageSender } from '@/lib/chat-messages'
import { presenceRoom } from '@/lib/presence-client'
import { type ChatLock, chatLock } from '@/store/sharing'

interface SharedChatComposer {
  /** The composer's own `disabled`, plus a viewer's or removed person's lock on sending. */
  disabled: boolean
  lock: ChatLock
  /** Who holds the running turn when it is not this window's to steer or stop; null otherwise. */
  turnHolder: MessageSender | null
}

/**
 * A shared chat's hold on this composer. A viewer follows the chat but cannot send, and neither can
 * someone whose access was just removed (hermes_cli/web_sharing.py enforces both); a turn someone
 * else sent is queued behind, never steered or stopped (tui_gateway/shared_turns.py).
 */
export function useSharedChatComposer(
  disabled: boolean,
  profile: null | string | undefined,
  queueSessionKey: null | string | undefined,
  sessionId: null | string | undefined
): SharedChatComposer {
  const turnHolder = useTurnHolder(sessionId)

  const lock = useStore(
    useMemo(() => chatLock(presenceRoom(profile, queueSessionKey || sessionId)), [profile, queueSessionKey, sessionId])
  )

  return { disabled: disabled || lock !== null, lock, turnHolder }
}

/** Why a shared chat's composer is locked, or whose turn is running; otherwise the `resting` placeholder. */
export function useSharedChatPlaceholder(
  resting: string,
  lock: ChatLock,
  turnHolder: MessageSender | null,
  busy: boolean
): string {
  const { t } = useI18n()

  if (lock) {
    return lock === 'removed' ? t.sharing.accessRemoved : t.sharing.viewerComposer
  }

  return turnHolder && busy ? t.presence.turnRunning(turnHolder.name || t.presence.chatCreator) : resting
}
