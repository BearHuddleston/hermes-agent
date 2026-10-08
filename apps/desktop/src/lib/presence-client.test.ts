import { describe, expect, it } from 'vitest'

import { applyPresenceFrame, presenceRoom } from '@/lib/presence-client'
import { PEER_TYPING_TTL_MS, type PresencePeer, presenceUsers } from '@/store/presence'

const peer = (id: string, user: string, extra: Partial<PresencePeer> = {}): PresencePeer => ({
  color: 'hsl(1 72% 60%)',
  cursor: null,
  id,
  label: `nous …${user.slice(-4)}`,
  name: user,
  seenAt: 0,
  typing: false,
  user,
  ...extra
})

describe('applyPresenceFrame', () => {
  it('a room snapshot replaces whoever was there before', () => {
    const before = [peer('a', 'nous:alice')]

    const { peers } = applyPresenceFrame(
      before,
      { type: 'room', room: 'default:s2', peers: [{ ...peer('b', 'nous:bob') }] },
      50
    )

    expect(peers.map(p => p.id)).toEqual(['b'])
    expect(peers[0].seenAt).toBe(50)
  })

  it('deltas update one peer in place and drop the ones that left', () => {
    const before = [peer('a', 'nous:alice'), peer('b', 'nous:bob')]

    const { peers } = applyPresenceFrame(
      before,
      {
        type: 'peers',
        room: 'default:s1',
        updates: [{ id: 'a', gone: true }, { ...peer('b', 'nous:bob'), typing: true }]
      },
      80
    )

    expect(peers.map(p => [p.id, p.typing, p.seenAt])).toEqual([['b', true, 80]])
  })

  it('the self frame names this window without touching the peer list', () => {
    const before = [peer('a', 'nous:alice')]
    const next = applyPresenceFrame(before, { type: 'self', self: peer('me', 'nous:me') }, 1)

    expect(next.peers).toBe(before)
    expect(next.self?.user).toBe('nous:me')
  })
})

describe('presenceUsers', () => {
  it('folds several windows of one person into one entry, typing if any window is', () => {
    const users = presenceUsers(
      [
        peer('a1', 'nous:alice'),
        peer('a2', 'nous:alice', { seenAt: 1_000, typing: true }),
        peer('b1', 'nous:bob')
      ],
      1_500
    )

    expect(users.map(u => [u.user, u.windows, u.typing])).toEqual([
      ['nous:alice', 2, true],
      ['nous:bob', 1, false]
    ])
  })

  it('a typing flag older than the TTL no longer counts (a closed laptop never says it stopped)', () => {
    const users = presenceUsers([peer('a', 'nous:alice', { seenAt: 0, typing: true })], PEER_TYPING_TTL_MS + 1)

    expect(users[0].typing).toBe(false)
  })
})

describe('presenceRoom', () => {
  it('keys a chat by profile and durable session id, and has no room without a session', () => {
    expect(presenceRoom('work', 'sess_1')).toBe('work:sess_1')
    expect(presenceRoom(null, 'sess_1')).toBe('default:sess_1')
    expect(presenceRoom('work', '  ')).toBeNull()
  })
})
