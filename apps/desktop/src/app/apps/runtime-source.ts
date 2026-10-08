/**
 * Source of the multiplayer runtime (frame-runtime.ts), loaded on first use:
 * only chat apps that call `hermes.state` / `hermes.text` / `hermes.presence`
 * pay for it, and the renderer's own bundle never carries it.
 */

let source: null | Promise<string> = null
let loaded: null | string = null

export function loadAppRuntime(): Promise<string> {
  source ??= import('virtual:hermes-app-runtime').then(module => (loaded = module.default))

  return source
}

/** The runtime once loaded, so a remounted frame rebuilds the same page in its first render. */
export const loadedAppRuntime = (): null | string => loaded

/** The scripts that start the runtime in a frame: its mount token, then the runtime itself. */
export function appRuntimeScripts(token: string, runtime: string): string {
  const config = JSON.stringify({ token }).replace(/</g, '\\u003c')

  return `<script>window.__HERMES_APP__=${config}</script><script>${runtime}</script>`
}
