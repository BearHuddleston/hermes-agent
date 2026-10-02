import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboardText } from './copy-button'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  })
}

afterEach(() => {
  Reflect.deleteProperty(desktopWindow, 'hermesDesktop')
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

describe('writeClipboardText', () => {
  it('uses the native clipboard first and does not double-write through the bridge', async () => {
    const nativeWrite = vi.fn().mockResolvedValue(undefined)
    const bridgeWrite = vi.fn().mockResolvedValue(true)
    installClipboard(nativeWrite)
    desktopWindow.hermesDesktop = { writeClipboard: bridgeWrite } as unknown as Window['hermesDesktop']

    await writeClipboardText('payload')

    expect(nativeWrite).toHaveBeenCalledWith('payload')
    expect(bridgeWrite).not.toHaveBeenCalled()
  })

  it('falls back to the bridge only when the native write rejects', async () => {
    const nativeWrite = vi.fn().mockRejectedValue(new Error('permission denied'))
    const bridgeWrite = vi.fn().mockResolvedValue(true)
    installClipboard(nativeWrite)
    desktopWindow.hermesDesktop = { writeClipboard: bridgeWrite } as unknown as Window['hermesDesktop']

    await writeClipboardText('payload')

    expect(nativeWrite).toHaveBeenCalledWith('payload')
    expect(bridgeWrite).toHaveBeenCalledWith('payload')
  })

  it('reports an unavailable bridge as a failed copy', async () => {
    const bridgeWrite = vi.fn().mockResolvedValue(false)
    desktopWindow.hermesDesktop = { writeClipboard: bridgeWrite } as unknown as Window['hermesDesktop']

    await expect(writeClipboardText('payload')).rejects.toThrow('Clipboard write is unavailable')
  })
})
