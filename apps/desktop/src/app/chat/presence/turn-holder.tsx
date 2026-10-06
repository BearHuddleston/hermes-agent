import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { useI18n } from '@/i18n'
import type { MessageSender } from '@/lib/chat-messages'
import { cn } from '@/lib/utils'
import { sessionTurnLock } from '@/store/shared-turns'

/**
 * The person holding the running turn of a shared chat when it is not this
 * window's to answer, stop or redirect (`tui_gateway/shared_turns.py`); null
 * otherwise, including every single-user and loopback chat.
 */
export function useTurnHolder(sessionId: null | string | undefined): MessageSender | null {
  return useStore(useMemo(() => sessionTurnLock(sessionId), [sessionId]))
}

/** "Waiting for Bob to answer" in place of the controls the gateway would refuse. */
export function TurnHolderNote({ className, holder }: { className?: string; holder: MessageSender }) {
  const { t } = useI18n()

  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs text-(--ui-text-secondary)', className)}
      data-slot="shared-turn-waiting"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: holder.color }} />
      <span className="truncate">{t.presence.waitingFor(holder.name || t.presence.chatCreator)}</span>
    </span>
  )
}
