import { describe, expect, it } from 'vitest'

import { type SharedTurn, turnHolder } from './shared-turns'

const ALICE = 'nous:usr_alice'
const BOB = 'nous:usr_bob'
const bobCard = { color: '#2563eb', id: BOB, name: 'Bob' }
const bobsTurn: SharedTurn = { chatOwner: ALICE, control: 'sender', owner: bobCard }
const peers = (...users: string[]) => users.map(user => ({ color: '#000', name: user.slice(-3), user }))

// The window-side mirror of tui_gateway/shared_turns.py::_may_act_on_turn: a
// locked window must be exactly one the gateway would refuse.
describe('turnHolder', () => {
  it('locks a third person out of a turn they did not send', () => {
    expect(turnHolder(bobsTurn, 'nous:usr_carol', peers(BOB, ALICE))).toEqual(bobCard)
  })

  it("lets the sender act, and the chat's creator only once the sender has left", () => {
    expect(turnHolder(bobsTurn, BOB, peers(ALICE))).toBeNull()
    expect(turnHolder(bobsTurn, ALICE, peers(BOB))).toEqual(bobCard)
    expect(turnHolder(bobsTurn, ALICE, peers())).toBeNull()
  })

  it('never locks a window with no sign-in, an idle chat, or turn_control: anyone', () => {
    expect(turnHolder(bobsTurn, null, peers(BOB))).toBeNull()
    expect(turnHolder({ ...bobsTurn, owner: null, chatOwner: null }, ALICE, peers(BOB))).toBeNull()
    expect(turnHolder({ ...bobsTurn, control: 'anyone' }, 'nous:usr_carol', peers(BOB))).toBeNull()
  })

  it("hands a turn nobody signed in sent (a goal follow-up) to the chat's creator", () => {
    const followUp: SharedTurn = { chatOwner: ALICE, control: 'sender', owner: null }

    expect(turnHolder(followUp, ALICE, peers(BOB))).toBeNull()
    expect(turnHolder(followUp, BOB, peers(ALICE))?.id).toBe(ALICE)
  })
})
