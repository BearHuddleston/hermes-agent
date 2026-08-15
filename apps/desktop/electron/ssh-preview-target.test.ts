import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
  isLoopbackPreviewTarget,
  openSshPreviewForward,
  parseSshPreviewTarget,
  revokeSshPreviewCapabilities
} from './ssh-preview-target'

test('accepts the reported remote loopback preview endpoint', () => {
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/DeepSeek-vs-Qwen38-on-Spark.html')

  assert.deepEqual(target, {
    remotePort: 8765,
    sourceUrl: 'http://127.0.0.1:8765/DeepSeek-vs-Qwen38-on-Spark.html'
  })
})

test('accepts only the narrow loopback aliases and preview ports', () => {
  assert.deepEqual(parseSshPreviewTarget('http://localhost:3000/'), {
    remotePort: 3000,
    sourceUrl: 'http://localhost:3000/'
  })
  assert.deepEqual(parseSshPreviewTarget('http://0.0.0.0:8765/'), {
    remotePort: 8765,
    sourceUrl: 'http://0.0.0.0:8765/'
  })
})

test('rejects credential-bearing preview URLs', () => {
  assert.equal(parseSshPreviewTarget('http://user:password@127.0.0.1:8765/report.html'), null)
})

test('rejects alternate IPv4 spellings that canonicalize to loopback', () => {
  for (const host of ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.000.000.001']) {
    const raw = `http://${host}:8765/report.html`

    assert.equal(isLoopbackPreviewTarget(raw), true)
    assert.equal(parseSshPreviewTarget(raw), null)
  }
})

test('detects unsupported loopback-looking targets so they fail closed', () => {
  assert.equal(isLoopbackPreviewTarget('http://127.0.0.2:8765/'), true)
  assert.equal(isLoopbackPreviewTarget('http://admin.localhost:8765/'), true)
  assert.equal(isLoopbackPreviewTarget('http://[::1]:8765/'), true)
  assert.equal(isLoopbackPreviewTarget('http://[::ffff:127.0.0.1]:8765/'), true)
  assert.equal(isLoopbackPreviewTarget('https://example.com/'), false)
})

test('forwards a validated SSH preview without a second authorization prompt', async () => {
  let forwarded = false
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html')!

  const lease = await openSshPreviewForward(target, {
    cancel: async () => undefined,
    closeTransport: async () => undefined,
    forward: async () => {
      forwarded = true
    },
    pickLocalPort: async () => 49152
  })

  assert.ok(lease)
  assert.equal(forwarded, true)
  await lease.close()
})

test('closes the owning transport when forward materialization fails', async () => {
  let transportCloses = 0
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html')!

  await assert.rejects(
    openSshPreviewForward(target, {
      cancel: async () => undefined,
      closeTransport: async () => {
        transportCloses += 1
      },
      forward: async () => {
        throw new Error('forward setup failed')
      },
      pickLocalPort: async () => 49152
    }),
    /forward setup failed/
  )
  assert.equal(transportCloses, 1)
})

test('does not forward after the selected SSH transport is replaced', async () => {
  let forwarded = false
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html')!

  const lease = await openSshPreviewForward(target, {
    cancel: async () => undefined,
    closeTransport: async () => undefined,
    forward: async () => {
      forwarded = true
    },
    isCurrent: () => false,
    pickLocalPort: async () => 49152
  })

  assert.equal(lease, null)
  assert.equal(forwarded, false)
})

test('opens one disposable tunnel and expires it after fifteen minutes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const forwarded: Array<[number, number]> = []
  const cancelled: Array<[number, number]> = []
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html?view=full')!

  const lease = await openSshPreviewForward(target, {
    cancel: async (localPort, remotePort) => {
      cancelled.push([localPort, remotePort])
    },
    closeTransport: async () => undefined,
    forward: async (localPort, remotePort) => {
      forwarded.push([localPort, remotePort])
    },
    pickLocalPort: async () => 49152
  })

  assert.ok(lease)
  assert.deepEqual(forwarded, [[49152, 8765]])
  assert.equal(lease.rewrittenUrl, 'http://127.0.0.1:49152/report.html?view=full')
  assert.equal(lease.expiresAt, 15 * 60 * 1000)

  await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
  assert.deepEqual(cancelled, [[49152, 8765]])
  vi.useRealTimers()
})

test('closes the owning transport when tunnel cancellation fails', async () => {
  let transportCloses = 0
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html')!

  const lease = await openSshPreviewForward(target, {
    cancel: async () => {
      throw new Error('cancel failed')
    },
    closeTransport: async () => {
      transportCloses += 1
    },
    forward: async () => undefined,
    pickLocalPort: async () => 49153
  })

  assert.ok(lease)
  await lease.close()
  assert.equal(transportCloses, 1)
})

test('reports disposal once so transport state can forget the capability', async () => {
  let disposed = 0
  const target = parseSshPreviewTarget('http://127.0.0.1:8765/report.html')!

  const lease = await openSshPreviewForward(target, {
    cancel: async () => undefined,
    closeTransport: async () => undefined,
    forward: async () => undefined,
    onClose: () => {
      disposed += 1
    },
    pickLocalPort: async () => 49154
  })

  assert.ok(lease)
  await lease.close()
  await lease.close()
  assert.equal(disposed, 1)
})

test('retries cleanup until the expired listener or its transport closes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)

  try {
    let closeAttempts = 0
    let disposed = 0

    const lease = await openSshPreviewForward(
      { remotePort: 8765, sourceUrl: 'http://127.0.0.1:8765/report.html' },
      {
        cancel: async () => {
          throw new Error('cancel failed')
        },
        closeTransport: async () => {
          closeAttempts += 1

          if (closeAttempts === 1) {
            throw new Error('transport close failed')
          }
        },
        forward: async () => undefined,
        onClose: () => {
          disposed += 1
        },
        pickLocalPort: async () => 49152
      }
    )

    assert.ok(lease)
    await assert.rejects(lease.close(), /transport close failed/)
    assert.equal(disposed, 0)

    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(closeAttempts, 2)
    assert.equal(disposed, 1)
  } finally {
    vi.useRealTimers()
  }
})

test('revokes every sibling capability before shared transport teardown', async () => {
  const events: string[] = []

  const current = {
    close: async () => {
      events.push('close:current')
    },
    revoke: () => {
      events.push('revoke:current')
    }
  }

  const sibling = {
    close: async () => {
      events.push('close:sibling')
    },
    revoke: () => {
      events.push('revoke:sibling')
    }
  }

  await revokeSshPreviewCapabilities(new Set([current, sibling]), current)

  assert.deepEqual(events, ['revoke:current', 'revoke:sibling', 'close:sibling'])
})
