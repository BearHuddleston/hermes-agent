export type PreviewBackendRoute = 'local' | 'remote' | 'ssh' | 'untrusted'

export interface PreviewBackendRouteInput {
  globalMode: string
  hasEnvRemote: boolean
  hasProfileRemote: boolean
  hasProfileSsh: boolean
  registryConnectionKind?: 'cloud' | 'local' | 'remote' | 'ssh' | null
  sourceConnectionId?: string
  sourceProfile: string
}

/** Mirror backend precedence without treating missing provenance as client-local. */
export function classifyPreviewBackendRoute({
  globalMode,
  hasEnvRemote,
  hasProfileRemote,
  hasProfileSsh,
  registryConnectionKind,
  sourceConnectionId,
  sourceProfile
}: PreviewBackendRouteInput): PreviewBackendRoute {
  if (!String(sourceProfile || '').trim()) {
    return 'untrusted'
  }

  if (String(sourceConnectionId || '').trim()) {
    if (registryConnectionKind === 'ssh') {
      return 'ssh'
    }

    if (registryConnectionKind === 'remote' || registryConnectionKind === 'cloud') {
      return 'remote'
    }

    return registryConnectionKind === 'local' ? 'local' : 'untrusted'
  }

  if (hasProfileSsh) {
    return 'ssh'
  }

  if (hasProfileRemote || hasEnvRemote) {
    return 'remote'
  }

  if (globalMode === 'ssh') {
    return 'ssh'
  }

  if (globalMode === 'remote' || globalMode === 'cloud') {
    return 'remote'
  }

  return 'local'
}
