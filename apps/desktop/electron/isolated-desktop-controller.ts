import { type ExecFileException, execFile as nodeExecFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  assertIsolatedManifestMatches,
  isolatedInstanceSpecFromSsh,
  type IsolatedSshConnection
} from './isolated-desktop-instance'

interface ConnectionsRegistryLike {
  connections?: IsolatedSshConnection[]
}

interface FileSystemLike {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: BufferEncoding): string
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => unknown

export interface IsolatedDesktopControllerOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  execFile?: ExecFileLike
  fs?: FileSystemLike
  log: (message: string) => void
  platform?: NodeJS.Platform | string
  readConnectionsRegistry: () => ConnectionsRegistryLike
  resolveHermesHome: () => string
}

export interface IsolatedDesktopController {
  launchByName(name: string, remainder?: string): Promise<void>
  openConnection(id: string): Promise<{ instanceName: string; launched: true; ok: true }>
  resolveCanonicalHermesRoot(): string
  resolveLocalHermesCli(): null | string
}

/**
 * Main-process orchestration for isolated Desktop shells.
 *
 * Dependencies are injected so route selection, CLI resolution, and error
 * propagation can be tested without booting Electron. The controller owns no
 * renderer or Electron state; main.ts only registers IPC and forwards links.
 */
export function createIsolatedDesktopController(
  options: IsolatedDesktopControllerOptions
): IsolatedDesktopController {
  const env = options.env ?? process.env
  const execFile = options.execFile ?? nodeExecFile
  const fileSystem = options.fs ?? fs
  const platform = options.platform ?? process.platform

  function resolveCanonicalHermesRoot(): string {
    const home = options.resolveHermesHome()
    const marker = `${path.sep}desktop-instances${path.sep}`
    const idx = home.toLowerCase().lastIndexOf(marker.toLowerCase())

    return idx === -1 ? home : home.slice(0, idx)
  }

  function resolveLocalHermesCli(): null | string {
    const explicit = env.HERMES_DESKTOP_HERMES

    if (explicit && fileSystem.existsSync(explicit)) {
      return explicit
    }

    const root = env.HERMES_DESKTOP_HERMES_ROOT || resolveCanonicalHermesRoot()
    const names = platform === 'win32' ? ['hermes.exe', 'hermes.cmd', 'hermes'] : ['hermes']

    const dirs = [
      path.join(root, 'bin'),
      path.join(root, 'hermes-agent', 'bin'),
      path.join(root, 'venv', 'Scripts'),
      path.join(root, 'venv', 'bin'),
      path.join(root, '.venv', 'Scripts'),
      path.join(root, '.venv', 'bin'),
      ...String(env.PATH || '').split(path.delimiter)
    ]

    for (const dir of dirs) {
      if (!dir) {
        continue
      }

      for (const name of names) {
        const candidate = path.join(dir, name)

        if (fileSystem.existsSync(candidate)) {
          return candidate
        }
      }
    }

    return null
  }

  function runHermesDesktopInstance(args: string[]): Promise<string> {
    const cli = resolveLocalHermesCli()

    if (!cli) {
      throw new Error('The local hermes CLI was not found. Isolated Desktop actions need the shared Hermes install.')
    }

    return new Promise((resolve, reject) => {
      execFile(cli, ['desktop', 'instance', ...args], { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message || '').trim()))

          return
        }

        resolve(String(stdout || ''))
      })
    })
  }

  async function launchByName(name: string, remainder?: string): Promise<void> {
    try {
      const args = ['launch', name]

      if (remainder) {
        args.push('--deep-link', remainder)
      }

      await runHermesDesktopInstance(args)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)

      options.log(`[isolated-instance] launch ${name} failed: ${detail}`)
      throw cause
    }

    if (remainder) {
      options.log(`[isolated-instance] forwarded deep link remainder to ${name}`)
    }
  }

  async function openConnection(id: string): Promise<{ instanceName: string; launched: true; ok: true }> {
    const registry = options.readConnectionsRegistry()
    const connection = (registry.connections || []).find(item => item.id === id)

    if (!connection) {
      throw new Error('That connection was not found.')
    }

    const spec = isolatedInstanceSpecFromSsh(connection)
    const manifestPath = path.join(resolveCanonicalHermesRoot(), 'desktop-instances', spec.name, 'instance.json')

    if (fileSystem.existsSync(manifestPath)) {
      const raw = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'))

      assertIsolatedManifestMatches(
        {
          connectionId: String(raw.connection_id || ''),
          dialIdentity: JSON.stringify({
            host: String(raw.ssh_host || ''),
            keyPath: String(raw.ssh_key_path || ''),
            port: Number(raw.ssh_port || 22),
            remoteHermesPath: String(raw.remote_hermes_path || ''),
            remoteProfile: String(raw.remote_profile || ''),
            user: String(raw.ssh_user || '')
          })
        },
        spec
      )
    } else {
      const args = [
        'create',
        spec.name,
        '--ssh-host',
        spec.sshHost,
        '--remote-hermes-path',
        spec.remoteHermesPath,
        '--remote-profile',
        spec.remoteProfile,
        '--display-name',
        spec.displayName,
        '--connection-id',
        spec.connectionId,
        '--ssh-port',
        String(spec.sshPort)
      ]

      if (spec.sshUser) {
        args.push('--ssh-user', spec.sshUser)
      }

      if (spec.sshKeyPath) {
        args.push('--ssh-key-path', spec.sshKeyPath)
      }

      await runHermesDesktopInstance(args)
    }

    await launchByName(spec.name)

    return { instanceName: spec.name, launched: true, ok: true }
  }

  return {
    launchByName,
    openConnection,
    resolveCanonicalHermesRoot,
    resolveLocalHermesCli
  }
}
