const ALLOWED_PREVIEW_HOSTS = new Set(['0.0.0.0', '127.0.0.1', 'localhost'])
const ALLOWED_PREVIEW_PORTS = new Set([3000, 8765])

export const SSH_PREVIEW_FORWARD_LEASE_MS = 15 * 60 * 1000

export interface SshPreviewTarget {
  remotePort: number
  sourceUrl: string
}

export interface SshPreviewForwardDeps {
  cancel: (localPort: number, remotePort: number) => Promise<void>
  closeTransport: () => Promise<void>
  forward: (localPort: number, remotePort: number) => Promise<void>
  isCurrent?: () => boolean
  onClose?: () => void
  pickLocalPort: () => Promise<number>
}

export interface SshPreviewForwardLease {
  close: () => Promise<void>
  expiresAt: number
  localPort: number
  remotePort: number
  rewrittenUrl: string
}

export interface SshPreviewCapability {
  close: () => Promise<void>
  revoke: () => void
}

/** Revoke every partition first, then dispose siblings without awaiting the caller itself. */
export async function revokeSshPreviewCapabilities(
  capabilities: Iterable<SshPreviewCapability>,
  excluded?: SshPreviewCapability
): Promise<void> {
  const snapshot = [...capabilities]

  for (const capability of snapshot) {
    capability.revoke()
  }

  await Promise.allSettled(snapshot.filter(capability => capability !== excluded).map(capability => capability.close()))
}

export async function openSshPreviewForward(
  target: SshPreviewTarget,
  deps: SshPreviewForwardDeps
): Promise<SshPreviewForwardLease | null> {
  const expiresAt = Date.now() + SSH_PREVIEW_FORWARD_LEASE_MS
  const localPort = await deps.pickLocalPort()

  if (deps.isCurrent && !deps.isCurrent()) {
    return null
  }

  try {
    await deps.forward(localPort, target.remotePort)
  } catch (error) {
    try {
      await deps.closeTransport()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `SSH preview forward failed and transport cleanup failed: ${String(error)}`
      )
    }

    throw error
  }

  let closed = false
  let closing: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const close = async () => {
    if (closed) {
      return
    }

    if (closing) {
      return closing
    }

    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    closing = (async () => {
      try {
        await deps.cancel(localPort, target.remotePort)
      } catch {
        await deps.closeTransport()
      }

      closed = true
      deps.onClose?.()
    })()

    try {
      await closing
    } catch (error) {
      scheduleClose(1000)
      throw error
    } finally {
      closing = null
    }
  }

  const scheduleClose = (delay: number) => {
    if (closed || timer) {
      return
    }

    timer = setTimeout(() => {
      timer = null
      void close().catch(() => undefined)
    }, delay)
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }

  if (Date.now() >= expiresAt) {
    await close()

    return null
  }

  const rewritten = new URL(target.sourceUrl)
  rewritten.hostname = '127.0.0.1'
  rewritten.port = String(localPort)
  scheduleClose(expiresAt - Date.now())

  return {
    close,
    expiresAt,
    localPort,
    remotePort: target.remotePort,
    rewrittenUrl: rewritten.toString()
  }
}

export function isLoopbackPreviewTarget(rawTarget: string): boolean {
  try {
    const url = new URL(String(rawTarget || '').trim())

    const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.+$/, '')

    const mappedIpv4 = hostname.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/)
    const mappedLoopback = mappedIpv4 ? Number.parseInt(mappedIpv4[1], 16) >> 8 === 127 : false

    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '0.0.0.0' ||
      hostname === '::' ||
      hostname === '::1' ||
      /^127(?:\.|$)/.test(hostname) ||
      mappedLoopback
    )
  } catch {
    return false
  }
}

export function parseSshPreviewTarget(rawTarget: string): SshPreviewTarget | null {
  try {
    const raw = String(rawTarget || '').trim()
    const authority = raw.match(/^https?:\/\/(0\.0\.0\.0|127\.0\.0\.1|localhost):(3000|8765)(?=$|[/?#])/i)

    if (!authority) {
      return null
    }

    const url = new URL(raw)

    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null
    }

    const hostname = url.hostname.toLowerCase()
    const remotePort = Number(url.port)

    // WHATWG URL canonicalization turns spellings such as 127.1, 2130706433,
    // 0x7f000001, and octal IPv4 into 127.0.0.1. Require the raw authority to
    // use one of the three literal policy spellings before trusting the parsed
    // destination, then verify parsing preserved that exact host and port.
    if (
      authority[1].toLowerCase() !== hostname ||
      Number(authority[2]) !== remotePort ||
      !ALLOWED_PREVIEW_HOSTS.has(hostname) ||
      !ALLOWED_PREVIEW_PORTS.has(remotePort)
    ) {
      return null
    }

    return { remotePort, sourceUrl: url.toString() }
  } catch {
    return null
  }
}
