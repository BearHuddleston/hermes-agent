import { isWindowsAbsolutePath } from '@/lib/path-compare'

const PREVIEW_MARKDOWN_RE = /\[Preview:[^\]]+\]\((?<href>#preview[:/][^)]+)\)/gi

export function stripPreviewTargets(text: string): string {
  return text.replace(PREVIEW_MARKDOWN_RE, '')
}

export function extractPreviewTargets(text: string): string[] {
  const targets: string[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(PREVIEW_MARKDOWN_RE)) {
    const target = previewTargetFromMarkdownHref(match.groups?.href)

    if (target && !seen.has(target)) {
      seen.add(target)
      targets.push(target)
    }
  }

  return targets
}

export function previewMarkdownHref(target: string): string {
  return `#preview/${encodeURIComponent(target)}`
}

export function previewTargetFromMarkdownHref(href?: string): string | null {
  if (!href?.startsWith('#preview:') && !href?.startsWith('#preview/')) {
    return null
  }

  try {
    return decodeURIComponent(href.slice('#preview'.length + 1))
  } catch {
    return null
  }
}

export function previewName(target: string): string {
  // `new URL('C:\\...')` would read the drive letter as a URL scheme.
  if (isWindowsAbsolutePath(target)) {
    return target.split(/[\\/]/).filter(Boolean).pop() || target
  }

  try {
    const url = new URL(target)

    if (url.protocol === 'file:') {
      return decodeURIComponent(url.pathname).split(/[\\/]/).filter(Boolean).pop() || target
    }

    const file = url.pathname.split('/').filter(Boolean).pop()

    return file || url.host
  } catch {
    return target.split(/[\\/]/).filter(Boolean).pop() || target
  }
}

/** The path a `file:` URL names: a UNC host becomes `//host/...` and a drive
 *  path drops the URL's leading slash. Null when the URL does not parse or
 *  decode, or encodes a separator (`%2f`; `%5c` in a drive or UNC path, while
 *  a POSIX name may hold a literal backslash). */
export function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    const windows = Boolean(url.hostname) || /^\/[a-z]:/i.test(url.pathname)

    // Encoded separators are not legal file-URL path segments.
    if (/%2f/i.test(url.pathname) || (windows && /%5c/i.test(url.pathname))) {
      return null
    }

    const path = decodeURIComponent(url.pathname)

    if (url.hostname) {
      return `//${url.hostname}${path}`
    }

    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

/** File identity only: do not resolve symlinks, guess home, or fold path case. */
export function previewArtifactKey(target: string, cwd: string): string {
  let path = target.trim()

  if (/^https?:\/\//i.test(path)) {
    return path
  }

  if (/^file:\/\//i.test(path)) {
    const filePath = fileUrlToPath(path)

    if (filePath === null) {
      return path
    }

    path = filePath
  }

  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')

  if (windows) {
    path = path.replace(/\\/g, '/')
  }

  if (!/^(?:\/|~\/|[a-z]:\/)/i.test(path) && cwd) {
    path = `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
  }

  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) {
    path = path.replace(/\\/g, '/')
  }

  return path.replace(/\/\.\//g, '/')
}

export function previewDisplayLabel(target: string): string {
  const escaped = previewName(target).replace(/[[\]\\]/g, '\\$&')

  return `Preview: ${escaped}`
}
