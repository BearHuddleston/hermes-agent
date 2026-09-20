import { afterEach, expect, it, vi } from 'vitest'

import { installBrowserDesktopBridge } from './browser-desktop-bridge'
import { consumeWebappSession, watchWebappLaunchLink } from './browser-launch-session'

const win = window as Window & {
  __HERMES_UI_SURFACE__?: string
  __HERMES_BASE_PATH__?: string
  __HERMES_AUTH_REQUIRED__?: boolean
}

afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'))
  Reflect.deleteProperty(window, 'hermesDesktop')
  delete win.__HERMES_UI_SURFACE__
  delete win.__HERMES_BASE_PATH__
  delete win.__HERMES_AUTH_REQUIRED__
  sessionStorage.clear()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

it('uses one private session for REST, RPC and terminal across reload without losing the profile', async () => {
  const token = 'a'.repeat(43)
  win.__HERMES_UI_SURFACE__ = 'webapp'
  win.__HERMES_BASE_PATH__ = '/one'
  window.history.replaceState(null, '', `/one/?profile=coder#hermes-session=${token}`)
  const urls: URL[] = []

  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    constructor(url: URL) {
      urls.push(new URL(url))
      queueMicrotask(() => this.onmessage?.({ data: '\0HERMES_TERMINAL_META:{"terminalId":"shell","pid":1,"cwd":"/work","shell":"sh","reconnected":false}' }))
    }
    close() {}
  }

  vi.stubGlobal('WebSocket', Socket)
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(installBrowserDesktopBridge()).toBe(true)
  expect(window.location.hash).toBe('')
  expect(window.location.search).toBe('?profile=coder')
  const desktop = window.hermesDesktop!
  await desktop.api({ path: '/api/fs/read-text' })
  expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Hermes-Session-Token')).toBe(token)
  expect((await desktop.getConnection()).token).toBe(token)
  expect(new URL((await desktop.getConnection()).wsUrl).searchParams.get('token')).toBe(token)
  await desktop.terminal.start({ cwd: '/work' })
  expect(urls[0].pathname).toBe('/one/api/pty')
  expect(urls[0].searchParams.get('token')).toBe(token)
  window.dispatchEvent(new Event('beforeunload'))
  Reflect.deleteProperty(window, 'hermesDesktop')
  window.history.replaceState(null, '', '/one/?profile=coder#/settings')
  expect(installBrowserDesktopBridge()).toBe(true)
  expect((await window.hermesDesktop!.getConnection()).token).toBe(token)
  expect(window.location.hash).toBe('#/settings')
  expect(consumeWebappSession('/other')).toBe('')
  expect(Object.values(localStorage)).not.toContain(token)
})

it('fails closed with actionable launch instructions in a fresh tab and ignores local grants under OAuth', async () => {
  win.__HERMES_UI_SURFACE__ = 'webapp'
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(installBrowserDesktopBridge()).toBe(true)
  await expect(window.hermesDesktop!.getConnection()).rejects.toThrow('private launch link')
  await expect(window.hermesDesktop!.api({ path: '/api/fs/read-text' })).rejects.toThrow('private launch link')
  expect(fetchMock).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('beforeunload'))
  Reflect.deleteProperty(window, 'hermesDesktop')
  window.history.replaceState(null, '', `/#hermes-session=${'b'.repeat(43)}`)
  expect(consumeWebappSession('')).toHaveLength(43)
  window.history.replaceState(null, '', '/#hermes-session=invalid')
  expect(consumeWebappSession('')).toBe('')
  expect(consumeWebappSession('')).toBe('')
  win.__HERMES_AUTH_REQUIRED__ = true
  expect(installBrowserDesktopBridge()).toBe(true)
  expect((await window.hermesDesktop!.getConnection()).authMode).toBe('oauth')
  expect((await window.hermesDesktop!.getConnection()).token).toBe('')
})

it('reloads for a pasted launch fragment but not HashRouter navigation', () => {
  const reload = vi.fn()
  watchWebappLaunchLink(reload)
  window.history.replaceState(null, '', '/#/settings')
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(reload).not.toHaveBeenCalled()
  const fragment = `#hermes-session=${'c'.repeat(43)}`
  window.history.replaceState(null, '', `/${fragment}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(reload).toHaveBeenCalledOnce()
  expect(window.location.hash).toBe(fragment)
  window.dispatchEvent(new Event('beforeunload'))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  expect(reload).toHaveBeenCalledOnce()
})
