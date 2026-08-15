import assert from 'node:assert/strict'

import { test } from 'vitest'

import { refreshSshOwner, SshOwnerRegistry } from './ssh-owner-registry'

test('retains a failed teardown owner outside the active routing map until retry succeeds', async () => {
  const registry = new SshOwnerRegistry<object>()
  const owner = {}
  let attempts = 0
  registry.set('', owner)

  await assert.rejects(
    registry.teardown('', owner, async () => {
      attempts += 1
      throw new Error('transport still alive')
    }),
    /transport still alive/
  )

  assert.equal(registry.get(''), undefined, 'closing owner cannot authorize new work')
  assert.equal(registry.size, 1, 'failed owner remains visible to quit cleanup')
  assert.deepEqual([...registry.keys()], [''])

  await registry.teardown('', owner, async () => {
    attempts += 1
  })

  assert.equal(attempts, 2)
  assert.equal(registry.size, 0)
})

test('teardown is scoped to the exact captured owner', async () => {
  const registry = new SshOwnerRegistry<object>()
  const current = {}
  const stale = {}
  let cleaned = false
  registry.set('', current)

  const claimed = await registry.teardown('', stale, async () => {
    cleaned = true
  })

  assert.equal(claimed, false)
  assert.equal(cleaned, false)
  assert.equal(registry.get(''), current)
})

test('same-transport refresh preserves the owner identity captured by preview capabilities', () => {
  const registry = new SshOwnerRegistry<{
    ssh: object
    fingerprint: string
    previewForwards: Set<object>
  }>()

  const ssh = {}
  const previewForwards = new Set<object>([{}])
  const capturedOwner = { ssh, fingerprint: 'old', previewForwards }
  registry.set('work', capturedOwner)

  const refreshed = refreshSshOwner(registry, 'work', {
    ssh,
    fingerprint: 'new',
    previewForwards
  })

  assert.equal(refreshed, capturedOwner)
  assert.equal(registry.get('work'), capturedOwner)
  assert.equal(capturedOwner.fingerprint, 'new')
  assert.equal(capturedOwner.previewForwards, previewForwards)
})

test('force cleanup includes owners retained after a failed normal teardown', async () => {
  const registry = new SshOwnerRegistry<object>()
  const owner = {}
  registry.set('work', owner)

  await assert.rejects(registry.teardown('work', owner, async () => Promise.reject(new Error('stuck'))))

  const forced: object[] = []
  await registry.forceCleanup(async state => {
    forced.push(state)
  })

  assert.deepEqual(forced, [owner])
  assert.equal(registry.size, 0)
})
