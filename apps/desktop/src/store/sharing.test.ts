import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type ChatAccess } from '@/api/sharing'

const room = 'default:20261007_000000_abcdef'

function access(role: ChatAccess['role']): ChatAccess {
  return { chat: room, role, can_share: role === 'owner', creator: null, people: [] }
}

// What the server answers when the window re-reads its role.
const served = vi.hoisted(() => ({ role: 'viewer' as ChatAccess['role'] }))

vi.mock('@/api/sharing', () => ({
  getChatAccess: vi.fn(async () => access(served.role)),
  getSharingMe: vi.fn(async () => null)
}))

const { $accessRemoved, $chatAccess, chatLock, onAccessChanged } = await import('./sharing')

describe('chatLock', () => {
  beforeEach(() => {
    $chatAccess.set({})
    $accessRemoved.set(new Set())
  })

  it('locks a viewer and leaves participants and owners free to send', () => {
    const lock = chatLock(room)

    $chatAccess.set({ [room]: access('viewer') })
    expect(lock.get()).toBe('viewer')

    $chatAccess.set({ [room]: access('participant') })
    expect(lock.get()).toBeNull()

    $chatAccess.set({ [room]: access('owner') })
    expect(lock.get()).toBeNull()
  })

  it('says the access was removed, not that the person can still view, when the owner takes it away', () => {
    $chatAccess.set({ [room]: access('participant') })
    onAccessChanged(room, true)

    expect(chatLock(room).get()).toBe('removed')
  })

  it('follows the role the server reports once the owner shares the chat again', async () => {
    const lock = chatLock(room)

    onAccessChanged(room, true)
    served.role = 'participant'
    onAccessChanged(room, false)

    await vi.waitFor(() => expect($chatAccess.get()[room]?.role).toBe('participant'))
    expect(lock.get()).toBeNull()
  })
})
