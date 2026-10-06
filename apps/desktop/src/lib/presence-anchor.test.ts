import { describe, expect, it } from 'vitest'

import {
  fractionsIn,
  pointForCursor,
  pointIn,
  type PresenceRect,
  rectContains,
  viewAnchor
} from '@/lib/presence-anchor'

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

  it("a touch reader's view anchor lands on the message at the middle of its screen, in any window", () => {
    // Turns stacked 0-300, 300-600, 600-900; the 900px viewport's middle (450) is halfway down the middle turn,
    // which is turn 1 counted from the newest.
    const anchor = viewAnchor(layout(900, [300, 300, 300]))

    expect(anchor).toEqual({ kind: 'view', turn: 1, x: 0, y: 0.5 })

    // Another window shows the same turns at other heights (middle turn spans 120-620): halfway down it.
    expect(pointForCursor(layout(800, [120, 500, 200]), null, anchor!)).toEqual({ x: 0, y: 370 })
  })
})

/** A surface holding a thread viewport (0..viewportHeight) with turns of the given heights, laid out top-down. */
function layout(viewportHeight: number, turnHeights: number[]): HTMLElement {
  const rect = (top: number, height: number) =>
    ({
      bottom: top + height,
      height,
      left: 0,
      right: 600,
      top,
      width: 600,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  const surface = document.createElement('div')
  const viewport = document.createElement('div')
  viewport.dataset.slot = 'aui_thread-viewport'
  surface.append(viewport)
  surface.getBoundingClientRect = () => rect(0, viewportHeight)
  viewport.getBoundingClientRect = () => rect(0, viewportHeight)

  let top = 0

  for (const height of turnHeights) {
    const turn = document.createElement('div')
    const turnTop = top
    turn.dataset.slot = 'aui_message-group'
    turn.getBoundingClientRect = () => rect(turnTop, height)
    viewport.append(turn)
    top += height
  }

  return surface
}
