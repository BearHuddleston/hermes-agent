import { describe, expect, it } from 'vitest'

import { APP_MESSAGE_TYPE, appOpFromMessage, serverFrameForOp, usesAppRuntime } from './protocol'

const msg = (fields: Record<string, unknown>) => ({ token: 'tok', type: APP_MESSAGE_TYPE, ...fields })

describe('appOpFromMessage', () => {
  // Anything inside the sandboxed frame can post to the window: only well-formed operations
  // carrying this mount's token reach /api/apps, and they leave with only the fields the server reads.
  it('relays only well-formed operations that carry the mount token', () => {
    expect(appOpFromMessage(msg({ key: 'votes', op: 'set', value: 3 }), 'tok')).toEqual({ key: 'votes', op: 'set', value: 3 })
    expect(appOpFromMessage(msg({ key: 'votes', op: 'set', value: 3 }), 'other')).toBeNull()
    expect(appOpFromMessage({ ...msg({ key: 'votes', op: 'set', value: 3 }), type: 'nope' }, 'tok')).toBeNull()
    expect(appOpFromMessage(msg({ key: '../etc', op: 'set', value: 1 }), 'tok')).toBeNull()
    expect(appOpFromMessage(msg({ key: 'votes', op: 'open', session_id: 'someone-elses-chat' }), 'tok')).toBeNull()
    expect(appOpFromMessage(msg({ key: 'n', op: 'text.push', updates: [], version: 0 }), 'tok')).toBeNull()
    expect(appOpFromMessage(msg({ key: 'n', op: 'text.push', updates: [{ changes: [[0, 'x']], clientID: 'a b' }], version: 0 }), 'tok')).toBeNull()

    const push = appOpFromMessage(
      msg({ extra: 'dropped', key: 'n', op: 'text.push', updates: [{ changes: [[0, 'x']], clientID: 'c1', more: 1 }], version: 2 }),
      'tok'
    )

    expect(push).toEqual({ key: 'n', op: 'text.push', updates: [{ changes: [[0, 'x']], clientID: 'c1' }], version: 2 })
    expect(serverFrameForOp(push as Exclude<typeof push & object, { op: 'hello' }>, 'a1')).toEqual({
      handle: 'a1',
      key: 'n',
      type: 'text.push',
      updates: [{ changes: [[0, 'x']], clientID: 'c1' }],
      version: 2
    })
  })

  it('clamps a pointer into the app and accepts leaving it', () => {
    expect(appOpFromMessage(msg({ cursor: { x: 2, y: -1 }, op: 'cursor' }), 'tok')).toEqual({ cursor: { x: 1, y: 0 }, op: 'cursor' })
    expect(appOpFromMessage(msg({ cursor: null, op: 'cursor' }), 'tok')).toEqual({ cursor: null, op: 'cursor' })
    expect(appOpFromMessage(msg({ cursor: { x: Number.NaN, y: 0 }, op: 'cursor' }), 'tok')).toBeNull()
  })
})

describe('usesAppRuntime', () => {
  it('loads the runtime only for pages that use shared state', () => {
    expect(usesAppRuntime('<textarea data-hermes-text="notes"></textarea>')).toBe(true)
    expect(usesAppRuntime('<script>hermes.state.set("a", 1)</script>')).toBe(true)
    expect(usesAppRuntime('<button data-hermes-send="refresh">Refresh</button>')).toBe(false)
  })
})
