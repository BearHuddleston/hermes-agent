import { type RefObject, useCallback } from 'react'

import { parkQueuedPrompts } from '@/store/composer-queue'
import { sessionTurnHolder } from '@/store/shared-turns'

/**
 * Halt vs. reach-the-queue: every interrupt lands on onCancel, but only the
 * gestures that MEAN "stop working" (Stop button, Esc) go through this
 * wrapper, which parks the queue first — an explicit halt must not roll
 * straight into the next queued prompt (that read as Stop not working; the
 * queued text also seemed to vanish, since the collapsed panel row was its
 * only trace). Interrupts that exist to advance the queue (send-now-while-
 * busy) call the raw onCancel and keep draining on settle. Parked entries
 * stay in the panel until resumed, sent, edited, or deleted.
 *
 * A shared chat's turn sent by someone else is theirs to stop
 * (tui_gateway/shared_turns.py): the halt leaves both the turn and this
 * window's queue alone.
 */
export function useHaltRun(
  activeQueueSessionKeyRef: RefObject<null | string>,
  onCancel: () => Promise<void> | void,
  sessionId: null | string | undefined
): () => Promise<void> | void {
  return useCallback(() => {
    if (sessionTurnHolder(sessionId)) {
      return
    }

    parkQueuedPrompts(activeQueueSessionKeyRef.current)

    return onCancel()
  }, [activeQueueSessionKeyRef, onCancel, sessionId])
}
