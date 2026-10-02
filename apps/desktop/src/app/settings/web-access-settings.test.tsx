vi.mock('@/store/profile', async (): Promise<object> => {
  const { atom } = await import('nanostores')

  return {
    $activeGatewayProfile: atom<string>('default'),
    $profiles: atom<Array<{ name: string; is_default?: boolean }>>([]),
    normalizeProfileKey: (profile: string | null): string => profile || 'default'
  }
})
vi.mock('@/store/session', async (): Promise<object> => {
  const { atom } = await import('nanostores')

  return { $connection: atom<{ mode?: 'local' | 'remote' } | null>(null) }
})
vi.mock('@/hermes', () => ({
  getActionStatus: vi.fn(),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getWebAccessStatus: vi.fn(),
  listOAuthProviders: vi.fn(async () => ({ providers: [] })),
  removeWebAccessNous: vi.fn(),
  removeWebAccessPassword: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setUpWebAccessNous: vi.fn(),
  setWebAccessPassword: vi.fn(),
  startWebAccess: vi.fn(),
  stopWebAccess: vi.fn()
}))

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WebAccessStatus } from '@/api/webapp-access'
import * as hermes from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $connection as sessionConnection } from '@/store/session'

import { WebAccessSettings } from './web-access-settings'

const mocked = vi.mocked(hermes)
// The mocked atom carries only the field the pane reads.
const $connection = sessionConnection as unknown as WritableAtom<{ mode: 'local' | 'remote' } | null>

const STOPPED: WebAccessStatus = {
  default_port: 9119,
  lan_address: '192.168.1.50',
  nous_client_id: '',
  password_username: '',
  public_url: '',
  running: []
}

function renderPane() {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <WebAccessSettings />
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  queryClient.clear()
  $connection.set({ mode: 'local' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WebAccessSettings', () => {
  it('offers Start only once a sign-in method exists', async () => {
    mocked.getWebAccessStatus.mockResolvedValueOnce(STOPPED)
    const first = renderPane()

    expect((await screen.findByRole('button', { name: /start/i })).hasAttribute('disabled')).toBe(true)
    first.unmount()
    queryClient.clear()

    mocked.getWebAccessStatus.mockResolvedValueOnce({ ...STOPPED, password_username: 'admin' })
    renderPane()

    expect((await screen.findByRole('button', { name: /start/i })).hasAttribute('disabled')).toBe(false)
  })

  it('never reads or exposes this machine through a remote connection', () => {
    $connection.set({ mode: 'remote' })
    renderPane()

    expect(screen.queryByRole('button', { name: /start/i })).toBeNull()
    expect(mocked.getWebAccessStatus).not.toHaveBeenCalled()
  })
})
