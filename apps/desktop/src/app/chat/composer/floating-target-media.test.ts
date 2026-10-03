// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

import { registerFloatingComposer } from './floating-target'

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  unregister = undefined
  globalThis.document.body.innerHTML = ''
  globalThis.window.getSelection()?.removeAllRanges()
})

it.each(['audio', 'video'])('leaves native %s focus and subsequent pointer movement with the media controls', tag => {
  const surface = globalThis.document.createElement('div')
  surface.dataset.chatSurface = ''
  surface.dataset.composerSurfaceId = 'media-owner'
  const media = globalThis.document.createElement(tag)
  media.tabIndex = 0
  const host = globalThis.document.createElement('div')
  host.dataset.composerOwner = 'media-owner'
  const editor = globalThis.document.createElement('div')
  editor.dataset.slot = 'composer-rich-input'
  editor.tabIndex = 0
  host.append(editor)
  surface.append(media, host)
  globalThis.document.body.append(surface)
  unregister = registerFloatingComposer('media-owner', { groupId: 'media-group', target: 'main' })
  const focusin = vi.fn()
  surface.addEventListener('focusin', focusin)

  editor.focus()
  focusin.mockClear()
  media.focus()
  expect(globalThis.document.activeElement).toBe(media)
  expect(focusin).toHaveBeenCalledTimes(1)
  media.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons: 0, clientX: 52, clientY: 63 }))
  expect(globalThis.document.activeElement).toBe(media)
})
