import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  DEFAULT_AUMID,
  isolatedDesktopLaunchEnv,
  isolatedInstanceSpecFromSsh,
  parseInstanceDeepLink,
  resolveAppUserModelId,
  shouldRegisterGlobalShortcuts,
  shouldRegisterProtocolClient,
  slugFromLabel
} from './isolated-desktop-instance'

test('slugFromLabel strips a Hermes prefix', () => {
  assert.equal(slugFromLabel('Hermes Athena'), 'athena')
  assert.equal(slugFromLabel('Work laptop'), 'work-laptop')
})

test('isolatedInstanceSpecFromSsh maps non-secret SSH fields', () => {
  const spec = isolatedInstanceSpecFromSsh({
    host: 'bear-agent',
    kind: 'ssh',
    label: 'Hermes Athena',
    remoteHermesPath: '/opt/hermes/bin/hermes',
    remoteProfile: 'default'
  })

  assert.equal(spec.name, 'athena')
  assert.equal(spec.sshHost, 'bear-agent')
  assert.equal(spec.remoteHermesPath, '/opt/hermes/bin/hermes')
  assert.equal(spec.displayName, 'Hermes Athena')
  assert.equal(spec.aumid, 'com.nousresearch.hermes.instance.athena')
})

test('isolatedInstanceSpecFromSsh rejects shared-shell kinds and relative paths', () => {
  assert.throws(() => isolatedInstanceSpecFromSsh({ kind: 'remote', label: 'box', host: 'x' }), /SSH/)
  assert.throws(
    () => isolatedInstanceSpecFromSsh({ host: 'lab', kind: 'ssh', label: 'box', remoteHermesPath: 'rel' }),
    /absolute/
  )
})

test('parseInstanceDeepLink extracts the slug and remainder', () => {
  const parsed = parseInstanceDeepLink('hermes://instance/grace/blueprint/morning')

  assert.deepEqual(parsed, { instanceName: 'grace', remainder: 'hermes://blueprint/morning' })
  assert.equal(parseInstanceDeepLink('hermes://blueprint/morning'), null)
})

test('isolated launch env disables global hotkey and protocol capture', () => {
  const env = isolatedDesktopLaunchEnv(
    isolatedInstanceSpecFromSsh({
      host: 'grace',
      kind: 'ssh',
      label: 'Hermes Grace',
      remoteHermesPath: '/opt/hermes',
      remoteProfile: 'default'
    }),
    { cwd: '/tmp', hermesHome: '/h', runtimeRoot: '/r', userData: '/u' }
  )

  assert.equal(env.HERMES_DESKTOP_DISABLE_GLOBAL_SHORTCUTS, '1')
  assert.equal(env.HERMES_DESKTOP_SKIP_PROTOCOL_REGISTER, '1')
  assert.equal(shouldRegisterGlobalShortcuts(env), false)
  assert.equal(shouldRegisterProtocolClient(env), false)
  assert.equal(resolveAppUserModelId(env), 'com.nousresearch.hermes.instance.grace')
  assert.equal(shouldRegisterGlobalShortcuts({}), true)
  assert.equal(resolveAppUserModelId({}), DEFAULT_AUMID)
})
