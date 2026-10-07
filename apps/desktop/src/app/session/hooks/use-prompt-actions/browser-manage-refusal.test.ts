import { afterEach, describe, expect, it } from 'vitest'

import { remoteBrowserManageRefusal } from './browser-manage-refusal'

// The Webapp is always a remote connection with no local gateway to switch to,
// so its refusal must not send the user looking for one.
describe('remoteBrowserManageRefusal', () => {
  afterEach(() => document.documentElement.removeAttribute('data-hermes-desktop-host'))

  it('sends native Desktop to a local gateway', () => {
    expect(remoteBrowserManageRefusal('connect')).toContain('local gateway')
  })

  it.each(['connect', 'disconnect'] as const)('names /browser %s and where it runs in the Webapp', action => {
    document.documentElement.dataset.hermesDesktopHost = 'browser'

    const copy = remoteBrowserManageRefusal(action)

    expect(copy).toContain(`/browser ${action}`)
    expect(copy).toContain('Webapp')
    expect(copy).not.toContain('local gateway')
  })
})
