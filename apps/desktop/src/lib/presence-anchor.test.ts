import { describe, expect, it } from 'vitest'

import { fractionsIn, pointIn, type PresenceRect, rectContains } from '@/lib/presence-anchor'

describe('presence anchors', () => {
  it('a pointer over the same message lands on the same spot in a window of another size', () => {
    const wide: PresenceRect = { height: 120, left: 300, top: 400, width: 800 }
    const narrow: PresenceRect = { height: 260, left: 16, top: 90, width: 360 }

    const anchor = fractionsIn(wide, 300 + 200, 400 + 30)
    const there = pointIn(narrow, anchor)

    expect(anchor).toEqual({ x: 0.25, y: 0.25 })
    expect(there).toEqual({ x: 16 + 90, y: 90 + 65 })
    expect(rectContains(narrow, there.x, there.y)).toBe(true)
  })

  it('fractions clamp to the element so an anchor can never point outside it', () => {
    const rect: PresenceRect = { height: 100, left: 0, top: 0, width: 100 }

    expect(fractionsIn(rect, -40, 250)).toEqual({ x: 0, y: 1 })
    expect(fractionsIn({ ...rect, width: 0 }, 10, 10)).toEqual({ x: 0, y: 0.1 })
  })
})
