import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { createIsolatedDesktopController } from './isolated-desktop-controller'

const connection = {
  id: 'grace-id',
  kind: 'ssh',
  label: 'Hermes Grace',
  host: 'grace.example',
  user: 'alice',
  port: 2222,
  keyPath: '/keys/alice',
  remoteHermesPath: '/opt/hermes/bin/hermes',
  remoteProfile: 'default'
}

function controller(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = []
  const logs: string[] = []
  const root = path.join(path.sep, 'home', 'bear', '.hermes')
  const cli = path.join(root, 'bin', 'hermes')

  const options = {
    env: { PATH: '' },
    execFile: (_file, args, _options, callback) => {
      calls.push(args)
      callback(null, '', '')
    },
    fs: {
      existsSync: candidate => candidate === cli,
      readFileSync: () => {
        throw new Error('unexpected read')
      }
    },
    log: message => logs.push(message),
    platform: 'linux',
    readConnectionsRegistry: () => ({ connections: [connection] }),
    resolveHermesHome: () => root,
    ...overrides
  }

  return { calls, controller: createIsolatedDesktopController(options), logs, root }
}

test('controller creates and launches an isolated shell from the exact SSH row', async () => {
  const state = controller()
  const result = await state.controller.openConnection('grace-id')

  assert.deepEqual(result, { instanceName: 'grace', launched: true, ok: true })
  assert.deepEqual(state.calls, [
    [
      'desktop',
      'instance',
      'create',
      'grace',
      '--ssh-host',
      'grace.example',
      '--remote-hermes-path',
      '/opt/hermes/bin/hermes',
      '--remote-profile',
      'default',
      '--display-name',
      'Hermes Grace',
      '--connection-id',
      'grace-id',
      '--ssh-port',
      '2222',
      '--ssh-user',
      'alice',
      '--ssh-key-path',
      '/keys/alice'
    ],
    ['desktop', 'instance', 'launch', 'grace']
  ])
})

test('controller rejects a stale manifest before invoking the CLI', async () => {
  const root = path.join(path.sep, 'home', 'bear', '.hermes')
  const cli = path.join(root, 'bin', 'hermes')
  const manifest = path.join(root, 'desktop-instances', 'grace', 'instance.json')

  const state = controller({
    fs: {
      existsSync: candidate => candidate === cli || candidate === manifest,
      readFileSync: candidate => {
        assert.equal(candidate, manifest)

        return JSON.stringify({
          connection_id: 'grace-id',
          ssh_host: 'edited.example',
          ssh_user: 'alice',
          ssh_port: 2222,
          ssh_key_path: '/keys/alice',
          remote_hermes_path: '/opt/hermes/bin/hermes',
          remote_profile: 'default'
        })
      }
    }
  })

  await assert.rejects(state.controller.openConnection('grace-id'), /no longer matches/)
  assert.deepEqual(state.calls, [])
})

test('controller logs launch failures and leaves propagation to its caller', async () => {
  const state = controller({
    execFile: (_file, _args, _options, callback) => {
      callback(new Error('exit 1'), '', 'route mismatch')
    }
  })

  await assert.rejects(state.controller.launchByName('grace', 'hermes://chat/1'), /route mismatch/)
  assert.deepEqual(state.logs, ['[isolated-instance] launch grace failed: route mismatch'])
})

test('controller recovers the shared root from an isolated HERMES_HOME', () => {
  const shared = path.join(path.sep, 'home', 'bear', '.hermes')

  const state = controller({
    resolveHermesHome: () => path.join(shared, 'desktop-instances', 'grace', 'home')
  })

  assert.equal(state.controller.resolveCanonicalHermesRoot(), shared)
})
