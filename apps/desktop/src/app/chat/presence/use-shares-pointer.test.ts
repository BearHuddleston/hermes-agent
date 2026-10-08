import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSharesPointer } from './use-shares-pointer'

function deviceReports(touch: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: () => {},
    matches: touch,
    media: query,
    removeEventListener: () => {}
  }))
}

function input(type: 'pointerdown' | 'pointermove', pointerType: string) {
  act(() => {
    document.dispatchEvent(Object.assign(new Event(type), { pointerType }))
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('useSharesPointer', () => {
  it('follows the device before any input', () => {
    deviceReports(true)
    expect(renderHook(() => useSharesPointer()).result.current).toBe(false)
    deviceReports(false)
    expect(renderHook(() => useSharesPointer()).result.current).toBe(true)
  })

  it('lets the last input win over what the device reports', () => {
    // A browser that reports no hover-capable device, driven with a mouse (and a tablet with a trackpad).
    deviceReports(true)
    const { result } = renderHook(() => useSharesPointer())

    input('pointermove', 'mouse')
    expect(result.current).toBe(true)

    // The same window touched: share the message being read, not a pointer.
    input('pointerdown', 'touch')
    expect(result.current).toBe(false)

    input('pointermove', 'pen')
    expect(result.current).toBe(true)
  })
})
