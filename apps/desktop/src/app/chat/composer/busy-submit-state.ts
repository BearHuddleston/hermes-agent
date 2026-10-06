import type { BusyInputMode } from '@/store/busy-input-mode'

export type ComposerBusyAction = 'interrupt' | 'steer' | 'queue' | 'stop'

export interface BusySubmitInputs {
  attachmentCount: number
  blockingPrompt: boolean
  busy: boolean
  busyInputMode: BusyInputMode | null
  compacting: boolean
  hasComposerPayload: boolean
  hasSteerHandler: boolean
  isSteerableText: boolean
  /** A shared chat's turn sent by someone else: queue behind it, never steer or stop it. */
  turnHeldByOther: boolean
}

export interface BusySubmitState {
  busyAction: ComposerBusyAction
  canSteer: boolean
  canSubmit: boolean
}

/** The Send button's gate plus the busy-turn routing (steer / queue / stop). */
export function deriveBusySubmitState({
  attachmentCount,
  blockingPrompt,
  busy,
  busyInputMode,
  compacting,
  hasComposerPayload,
  hasSteerHandler,
  isSteerableText,
  turnHeldByOther
}: BusySubmitInputs): BusySubmitState {
  // Someone else's turn: an empty composer cannot stop it, and text only queues, so the
  // busy-input policy (still loading while null) does not hold Send back.
  const canSubmit = turnHeldByOther
    ? hasComposerPayload
    : (busy || hasComposerPayload) &&
      !(busy && isSteerableText && attachmentCount === 0 && !compacting && !blockingPrompt && busyInputMode === null)

  // Steer only makes sense mid-turn, text-only (the gateway can't carry images
  // into a tool result) and never for a slash command (those execute inline).
  // A blocking prompt (approval/sudo/secret) also rules it out: the tool batch
  // is parked on the user, so a steer can't reach the model — text queues.
  // Compaction does not: the gateway holds the correction until it finishes.
  const canSteer =
    busy && !blockingPrompt && !turnHeldByOther && hasSteerHandler && attachmentCount === 0 && isSteerableText

  // Ordinary busy Send follows backend policy; attachments queue and empty stops.
  const busyAction: ComposerBusyAction = canSteer
    ? (busyInputMode ?? 'interrupt')
    : compacting || hasComposerPayload
      ? 'queue'
      : 'stop'

  return { busyAction, canSteer, canSubmit }
}
