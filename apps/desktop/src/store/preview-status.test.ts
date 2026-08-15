import { beforeEach, describe, expect, it } from 'vitest'

import {
  $previewStatusBySession,
  clearPreviewArtifacts,
  dismissPreviewArtifact,
  recordPreviewArtifact,
  recordPreviewSessionProfile
} from './preview-status'

beforeEach(() => {
  $previewStatusBySession.set({})
  clearPreviewArtifacts('s1')
})

describe('recordPreviewArtifact', () => {
  it('appends new targets newest-last and is idempotent', () => {
    recordPreviewArtifact('s1', '/a/index.html', '/work')
    recordPreviewArtifact('s1', '/a/about.html', '/work')
    recordPreviewArtifact('s1', '/a/index.html', '/work')

    expect($previewStatusBySession.get().s1.map(i => i.id)).toEqual(['/a/index.html', '/a/about.html'])
  })

  it('stamps artifacts with the first locally observed session profile', () => {
    recordPreviewSessionProfile('s1', 'grace-profile', 'grace-ssh')
    recordPreviewSessionProfile('s1', 'different-profile', 'different-connection')
    recordPreviewArtifact('s1', 'http://127.0.0.1:8765/report.html', '/work')

    expect($previewStatusBySession.get().s1[0]).toMatchObject({ connectionId: 'grace-ssh', profile: 'grace-profile' })
  })

  it('caps the list and derives a label', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      recordPreviewArtifact('s1', `/a/p${n}.html`, '/work')
    }

    const list = $previewStatusBySession.get().s1
    expect(list).toHaveLength(4)
    expect(list[0].id).toBe('/a/p2.html')
    expect(list[3].label).toBe('p5.html')
  })

  it('dismiss and clear remove rows', () => {
    recordPreviewArtifact('s1', '/a/index.html', '/work')
    recordPreviewArtifact('s1', '/a/about.html', '/work')
    dismissPreviewArtifact('s1', '/a/index.html')
    expect($previewStatusBySession.get().s1.map(i => i.id)).toEqual(['/a/about.html'])

    clearPreviewArtifacts('s1')
    expect($previewStatusBySession.get().s1).toBeUndefined()
  })
})
