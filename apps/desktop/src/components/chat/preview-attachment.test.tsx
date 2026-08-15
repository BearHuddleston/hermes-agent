import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import { closeRightRail } from '@/store/preview'
import { clearPreviewArtifacts, recordPreviewSessionProfile } from '@/store/preview-status'

import { PreviewAttachment } from './preview-attachment'

afterEach(() => {
  cleanup()
  closeRightRail()
  vi.restoreAllMocks()
})

it('normalizes transcript loopback previews with their owning session profile', async () => {
  const source = 'http://127.0.0.1:8765/report.html'
  const runtimeId = 'runtime-registry-ssh'
  recordPreviewSessionProfile(runtimeId, 'named-remote', 'grace-ssh')

  const normalizePreviewTarget = vi.fn(async () => ({
    kind: 'url' as const,
    label: 'report.html',
    previewPartition: 'hermes-preview-forwarded-test',
    profileValidated: true,
    source,
    transient: true,
    url: 'http://127.0.0.1:49152/report.html'
  }))

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { normalizePreviewTarget }
  })

  render(
    <SessionViewProvider
      value={{
        ...PRIMARY_SESSION_VIEW,
        $cwd: atom('/work'),
        $profile: atom('named-remote'),
        $runtimeId: atom(runtimeId)
      } as never}
    >
      <PreviewAttachment target={source} />
    </SessionViewProvider>
  )

  fireEvent.click(screen.getByRole('button'))

  await waitFor(() => {
    expect(normalizePreviewTarget).toHaveBeenCalledWith(source, '/work', 'named-remote', 'grace-ssh')
  })

  clearPreviewArtifacts(runtimeId)
})
