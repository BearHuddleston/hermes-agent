interface ForwardedPreviewSession {
  closeAllConnections: () => Promise<void>
  on: (event: 'will-download', handler: (event: { preventDefault: () => void }) => void) => unknown
  setDevicePermissionHandler?: (handler: () => boolean) => void
  setDisplayMediaRequestHandler?: (
    handler: (request: unknown, callback: (streams: Record<string, never>) => void) => void
  ) => void
  setPermissionCheckHandler: (handler: () => boolean) => void
  setPermissionRequestHandler: (
    handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void
  ) => void
  webRequest: {
    onBeforeRequest: (
      filter: { urls: string[] },
      handler: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void
    ) => void
  }
}

interface LeaseOptions {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> | { unref?: () => void }
}

function networkOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    const protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol

    if (protocol !== 'http:' && protocol !== 'https:') {
      return null
    }

    return `${protocol}//${url.hostname.toLowerCase()}:${url.port || (protocol === 'https:' ? '443' : '80')}`
  } catch {
    return null
  }
}

export function leaseForwardedPreviewSession(
  previewSession: ForwardedPreviewSession,
  forwardedUrl: string,
  expiresAt: number,
  options: LeaseOptions = {}
): { revoke: () => void } | null {
  const allowedOrigin = networkOrigin(forwardedUrl)
  const remainingMs = expiresAt - (options.now ?? Date.now)()

  if (!allowedOrigin || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null
  }

  let revoked = false
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  previewSession.setDevicePermissionHandler?.(() => false)
  previewSession.setDisplayMediaRequestHandler?.((_request, callback) => callback({}))
  previewSession.on('will-download', event => event.preventDefault())
  previewSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = details.url
    const allowed = url.startsWith('data:') || url.startsWith('about:') || networkOrigin(url) === allowedOrigin
    callback({ cancel: revoked || !allowed })
  })

  const revoke = () => {
    if (revoked) {
      return
    }

    revoked = true
    void previewSession.closeAllConnections()
  }

  const timer = (options.setTimer ?? setTimeout)(revoke, remainingMs)

  ;(timer as { unref?: () => void }).unref?.()

  return { revoke }
}
