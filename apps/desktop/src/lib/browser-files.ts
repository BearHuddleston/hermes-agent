import type { HermesApiRequest } from '@/global'
import { translateNow } from '@/i18n'
import { fetchBrowserImage } from '@/lib/browser-image-download'
import { authenticatedEndpointUrl, type BrowserBootstrap } from '@/lib/browser-transport'
import { notifyError } from '@/store/notifications'

function queryPath(route: string, values: Record<string, boolean | null | string | undefined>) {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) {query.set(key, String(value))}
  }

  return `${route}?${query.toString()}`
}

interface BrowserFilesOptions {
  api: <T>(request: HermesApiRequest) => Promise<T>
  bootstrap: BrowserBootstrap
  currentProfile: () => string | null
  /** Blob URLs handed to the page; the installer revokes them on unload. */
  objectUrls: Set<string>
  requireConnection: (connectionId?: string | null) => void
}

/** Server files reach the page through /api/fs reads and authenticated download/stream URLs. */
export function createBrowserFilesBridge({
  api,
  bootstrap,
  currentProfile,
  objectUrls,
  requireConnection
}: BrowserFilesOptions): Pick<
  Window['hermesDesktop'],
  | 'getGatewayFileStreamUrl'
  | 'readDir'
  | 'readFileDataUrl'
  | 'readFileDataUrlForAttach'
  | 'readFileText'
  | 'saveGatewayFile'
  | 'saveImageFromUrl'
> {
  const fsGet = <T>(route: string, path: string) =>
    api<T>({ path: queryPath(`/api/fs/${route}`, { path }), profile: currentProfile() })

  const readDataUrl = async (path: string) => (await fsGet<{ dataUrl: string }>('read-data-url', path)).dataUrl

  const downloadUrl = async (url: string, filename = '') => {
    const target = new URL(url, window.location.href)
    let downloadHref = target.href

    // Cross-origin anchors ignore download and navigate the current tab.
    // Fetch without Hermes credentials; CORS denial must not fall back to navigation.
    if (target.origin !== window.location.origin && !['blob:', 'data:'].includes(target.protocol)) {
      downloadHref = URL.createObjectURL(await fetchBrowserImage(target))
      objectUrls.add(downloadHref)
      window.setTimeout(() => {
        URL.revokeObjectURL(downloadHref)
        objectUrls.delete(downloadHref)
      }, 60_000)
    }

    const anchor = document.createElement('a')
    anchor.href = downloadHref
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()

    return true
  }

  return {
    getGatewayFileStreamUrl: async payload => {
      requireConnection(payload.connectionId)

      return authenticatedEndpointUrl(
        bootstrap,
        queryPath('/api/files/stream', { path: payload.path }),
        payload.profile ?? currentProfile()
      ).href
    },
    readDir: (path: string) =>
      fsGet<Awaited<ReturnType<Window['hermesDesktop']['readDir']>>>('list', path),
    readFileDataUrl: readDataUrl,
    readFileDataUrlForAttach: readDataUrl,
    readFileText: (path: string) =>
      fsGet<Awaited<ReturnType<Window['hermesDesktop']['readFileText']>>>('read-text', path),
    saveGatewayFile: async payload => {
      requireConnection(payload.connectionId)
      const path = queryPath('/api/files/download', { path: payload.path, session_id: payload.sessionId })
      const profile = payload.profile ?? currentProfile()

      // Validate before handing the transfer to the browser so missing or
      // denied files surface in the chat without navigating away. HEAD keeps
      // large downloads out of renderer memory.
      await api({ method: 'HEAD', path, profile })

      return {
        saved: await downloadUrl(authenticatedEndpointUrl(bootstrap, path, profile).href, payload.suggestedName)
      }
    },
    saveImageFromUrl: async (url: string) => {
      try {
        return await downloadUrl(url)
      } catch (error) {
        // Context-menu consumers fire and forget; surface failures here.
        notifyError(error, translateNow('fileMenu.downloadFailed'))

        return false
      }
    }
  }
}
