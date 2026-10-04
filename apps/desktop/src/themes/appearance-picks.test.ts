import { beforeEach, expect, it, vi } from 'vitest'

import { beginAppearancePick, confirmAppearance, settleAppearancePick } from './appearance-picks'

beforeEach(() => window.localStorage.clear())

it.each(['theme', 'theme_mode'] as const)('settles independent writers against saved %s, in either order', async field => {
  vi.resetModules()
  const peer = await import('./appearance-picks')

  for (const profile of ['default', 'alpha']) {
    for (const firstSucceeds of [false, true]) {
      for (const reverse of [false, true]) {
        const owner = `A::${profile}`
        const [base, first, second] = field === 'theme' ? ['ember', 'mono', 'everforest'] : ['light', 'dark', 'system']
        confirmAppearance(profile, field, owner, base)
        const a = beginAppearancePick(profile, field, owner, base, first)
        const b = peer.beginAppearancePick(profile, field, owner, first, second)
        let cache: string | null = second

        const settleA = () => { cache = settleAppearancePick(a, firstSucceeds, cache) ?? cache }

        const settleB = () => { cache = peer.settleAppearancePick(b, false, cache) ?? cache }

        if (reverse) { settleB(); settleA() } else { settleA(); settleB() }
        expect(cache).toBe(firstSucceeds ? first : base)
      }
    }
  }
})

it('does not overwrite a different gateway or a newer authoritative read', () => {
  confirmAppearance('default', 'theme', 'A::default', 'ember')
  const old = beginAppearancePick('default', 'theme', 'A::default', 'ember', 'mono')
  confirmAppearance('default', 'theme', 'B::default', 'everforest')
  expect(settleAppearancePick(old, false, 'everforest')).toBeUndefined()
  confirmAppearance('default', 'theme', 'A::default', 'everforest')
  expect(settleAppearancePick(old, true, 'everforest')).toBeUndefined()
})

it.each(['theme', 'theme_mode'] as const)('profile lifecycle only discards its own %s writes', async field => {
  const { setApiRequestConnection } = await import('@/api/client')
  const { dropTilesForProfile, migrateTilesForProfile } = await import('@/store/session-states')
  const [base, preview] = field === 'theme' ? ['ember', 'mono'] : ['light', 'dark']
  setApiRequestConnection('A')

  try {
    for (const cleanup of [
      () => dropTilesForProfile('alpha', { connectionId: 'A', profile: 'alpha' }),
      () => dropTilesForProfile('alpha'),
      () => migrateTilesForProfile('alpha', 'renamed'),
      () => migrateTilesForProfile('before', 'alpha')
    ]) {
      confirmAppearance('alpha', field, 'B::alpha', base)
      const pending = beginAppearancePick('alpha', field, 'B::alpha', base, preview)
      cleanup()
      expect(settleAppearancePick(pending, false, preview)).toBe(base)
    }

    confirmAppearance('alpha', field, 'B::alpha', base)
    const retired = beginAppearancePick('alpha', field, 'B::alpha', base, preview)
    dropTilesForProfile('alpha', { connectionId: 'B', profile: 'alpha' })
    expect(settleAppearancePick(retired, false, preview)).toBeUndefined()
  } finally { setApiRequestConnection(null) }
})
