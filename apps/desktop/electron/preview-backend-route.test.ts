import assert from 'node:assert/strict'

import { test } from 'vitest'

import { classifyPreviewBackendRoute } from './preview-backend-route'

test('requires explicit locally stamped profile provenance for loopback previews', () => {
  assert.equal(
    classifyPreviewBackendRoute({
      globalMode: 'local',
      hasEnvRemote: false,
      hasProfileRemote: false,
      hasProfileSsh: false,
      sourceProfile: ''
    }),
    'untrusted'
  )
})

test('mirrors backend precedence when classifying a stamped preview source', () => {
  const base = { hasEnvRemote: false, sourceProfile: 'work' }

  assert.equal(
    classifyPreviewBackendRoute({ ...base, globalMode: 'ssh', hasProfileRemote: false, hasProfileSsh: true }),
    'ssh'
  )
  assert.equal(
    classifyPreviewBackendRoute({ ...base, globalMode: 'ssh', hasProfileRemote: true, hasProfileSsh: false }),
    'remote'
  )
  assert.equal(
    classifyPreviewBackendRoute({
      ...base,
      globalMode: 'local',
      hasEnvRemote: true,
      hasProfileRemote: false,
      hasProfileSsh: false
    }),
    'remote'
  )
  assert.equal(
    classifyPreviewBackendRoute({ ...base, globalMode: 'ssh', hasProfileRemote: false, hasProfileSsh: false }),
    'ssh'
  )
  assert.equal(
    classifyPreviewBackendRoute({ ...base, globalMode: 'cloud', hasProfileRemote: false, hasProfileSsh: false }),
    'remote'
  )
  assert.equal(
    classifyPreviewBackendRoute({ ...base, globalMode: 'local', hasProfileRemote: false, hasProfileSsh: false }),
    'local'
  )
})


test('binds registry preview routing to the exact stamped connection', () => {
  const base = {
    globalMode: 'local',
    hasEnvRemote: false,
    hasProfileRemote: false,
    hasProfileSsh: false,
    sourceConnectionId: 'grace-ssh',
    sourceProfile: 'work'
  }

  assert.equal(classifyPreviewBackendRoute({ ...base, registryConnectionKind: 'ssh' }), 'ssh')
  assert.equal(classifyPreviewBackendRoute({ ...base, registryConnectionKind: 'remote' }), 'remote')
  assert.equal(classifyPreviewBackendRoute({ ...base, registryConnectionKind: 'local' }), 'local')
  assert.equal(classifyPreviewBackendRoute({ ...base, registryConnectionKind: null }), 'untrusted')
})
