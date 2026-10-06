import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptableFrame, claimFrame, placeFrame, releaseFrame, setFrameDoc } from './kept-frames'

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void }

const file = 'default|/work/board.html'

function shown(session: string, onDispose = vi.fn()) {
  const host = document.createElement('span')
  document.body.appendChild(host)
  const entry = claimFrame({ file, session }, Math.random().toString(36).slice(2), onDispose)
  setFrameDoc(entry, '<p>board</p>')
  placeFrame(entry, host)

  return { entry, host, onDispose }
}

describe('kept inline frames', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    // jsdom has no state-preserving move; a plain move stands in for it.
    ;(Element.prototype as Movable).moveBefore = function (this: Element, node: Node, child: Node | null) {
      this.insertBefore(node, child)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(Element.prototype, 'moveBefore')
    document.body.replaceChildren()
  })

  it('hands a remounted message the same frame element', () => {
    const { entry, host } = shown('s1')
    releaseFrame(entry)
    host.remove()

    const again = adoptableFrame({ file, session: 's1' })
    expect(again?.frame).toBe(entry.frame)

    const next = document.createElement('span')
    document.body.appendChild(next)
    placeFrame(claimFrame({ file, session: 's1' }, again!.token, again!.onDispose), next)
    expect(next.firstChild).toBe(entry.frame)
  })

  it('never hands a frame to another chat, and lets an unclaimed one go', () => {
    const { entry, onDispose } = shown('s1')
    releaseFrame(entry)

    expect(adoptableFrame({ file, session: 's2' })).toBeNull()
    vi.advanceTimersByTime(10_000)
    expect(adoptableFrame({ file, session: 's1' })).toBeNull()
    expect(entry.frame.isConnected).toBe(false)
    expect(onDispose).toHaveBeenCalledOnce()
  })

  it('lets a chat that was just saved take over the frame it showed unsaved', () => {
    const { entry } = shown('')
    releaseFrame(entry)

    expect(adoptableFrame({ file, session: 's1' })?.frame).toBe(entry.frame)
  })
})
