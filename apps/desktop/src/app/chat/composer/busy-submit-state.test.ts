import { describe, expect, it } from 'vitest'

import { type BusySubmitInputs, deriveBusySubmitState } from './busy-submit-state'

const busyTurn = (overrides: Partial<BusySubmitInputs> = {}): BusySubmitInputs => ({
  attachmentCount: 0,
  blockingPrompt: false,
  busy: true,
  busyInputMode: 'steer',
  compacting: false,
  hasComposerPayload: true,
  hasSteerHandler: true,
  isSteerableText: true,
  turnHeldByOther: false,
  ...overrides
})

describe('deriveBusySubmitState for a shared chat turn', () => {
  it('steers the sender’s own running turn', () => {
    expect(deriveBusySubmitState(busyTurn())).toEqual({ busyAction: 'steer', canSteer: true, canSubmit: true })
  })

  it('queues text behind a turn someone else sent instead of steering it', () => {
    expect(deriveBusySubmitState(busyTurn({ turnHeldByOther: true }))).toEqual({
      busyAction: 'queue',
      canSteer: false,
      canSubmit: true
    })
  })

  it('lets text queue behind someone else’s turn while the busy-input policy is still loading', () => {
    const own = deriveBusySubmitState(busyTurn({ busyInputMode: null }))
    const other = deriveBusySubmitState(busyTurn({ busyInputMode: null, turnHeldByOther: true }))

    expect(own.canSubmit).toBe(false)
    expect(other).toEqual({ busyAction: 'queue', canSteer: false, canSubmit: true })
  })

  it('never offers Stop for a turn someone else sent', () => {
    const own = deriveBusySubmitState(busyTurn({ hasComposerPayload: false, isSteerableText: false }))

    const other = deriveBusySubmitState(
      busyTurn({ hasComposerPayload: false, isSteerableText: false, turnHeldByOther: true })
    )

    expect(own).toMatchObject({ busyAction: 'stop', canSubmit: true })
    expect(other.canSubmit).toBe(false)
  })
})
