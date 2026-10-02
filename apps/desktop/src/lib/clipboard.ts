// Keeps the browser-native clipboard write on the original user gesture. If
// Chromium rejects it after focus moved (for example from a portaled Radix
// dropdown), the Electron IPC path is the fallback and remains unconditional.

export function installClipboardShim() {
  const ipc = window.hermesDesktop?.writeClipboard

  if (!ipc || !navigator.clipboard) {
    return
  }

  const native = navigator.clipboard.writeText?.bind(navigator.clipboard)

  const writeText = async (text: string) => {
    if (!native) {
      const copied = await ipc(text)

      if (!copied) {
        throw new Error('Clipboard write is unavailable')
      }

      return
    }

    try {
      await native(text)
    } catch {
      const copied = await ipc(text)

      if (!copied) {
        throw new Error('Clipboard write is unavailable')
      }
    }
  }

  try {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText, writable: true })
  } catch {
    // Browser refused override; primitives keep using the native API.
  }
}
