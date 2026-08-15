import assert from 'node:assert/strict'

import { test } from 'vitest'

import { leaseForwardedPreviewSession } from './forwarded-preview-session'

test('isolates a forwarded preview and revokes it at the tunnel deadline', async () => {
  let beforeRequest: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined
  let permissionCheck: (() => boolean) | undefined

  let permissionRequest:
    ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined

  let willDownload: ((event: { preventDefault: () => void }) => void) | undefined
  let devicePermission: (() => boolean) | undefined
  let displayMediaRequest: ((request: unknown, callback: (streams: object) => void) => void) | undefined
  let expire: (() => void) | undefined
  let closeCalls = 0

  const lease = leaseForwardedPreviewSession(
    {
      closeAllConnections: async () => {
        closeCalls += 1
      },
      on: (_event, handler) => {
        willDownload = handler
      },
      setDevicePermissionHandler: handler => {
        devicePermission = handler
      },
      setDisplayMediaRequestHandler: handler => {
        displayMediaRequest = handler
      },
      setPermissionCheckHandler: handler => {
        permissionCheck = handler
      },
      setPermissionRequestHandler: handler => {
        permissionRequest = handler
      },
      webRequest: {
        onBeforeRequest: (_filter, handler) => {
          beforeRequest = handler
        }
      }
    },
    'http://127.0.0.1:49152/report.html',
    1_000,
    {
      now: () => 999,
      setTimer: callback => {
        expire = callback

        return { unref: () => undefined }
      }
    }
  )

  assert.ok(lease)
  assert.equal(permissionCheck?.(), false)
  let permissionAllowed = true
  permissionRequest?.(null, 'geolocation', allowed => {
    permissionAllowed = allowed
  })
  assert.equal(permissionAllowed, false)
  assert.equal(devicePermission?.(), false)
  let displayStreams: object | undefined
  displayMediaRequest?.({}, streams => {
    displayStreams = streams
  })
  assert.deepEqual(displayStreams, {})
  let downloadPrevented = false
  willDownload?.({ preventDefault: () => (downloadPrevented = true) })
  assert.equal(downloadPrevented, true)

  const cancelled = (url: string) => {
    let result: { cancel: boolean } | undefined
    beforeRequest?.({ url }, value => {
      result = value
    })

    return result?.cancel
  }

  assert.equal(cancelled('http://127.0.0.1:49152/app.js'), false)
  assert.equal(cancelled('ws://127.0.0.1:49152/hmr'), false)
  assert.equal(cancelled('http://127.0.0.1:3000/private'), true)
  assert.equal(cancelled('file:///C:/Users/example/secret.txt'), true)

  expire?.()
  await Promise.resolve()
  assert.equal(cancelled('http://127.0.0.1:49152/app.js'), true)
  assert.equal(closeCalls, 1)
})
