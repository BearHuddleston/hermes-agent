/**
 * Inline widget frames (`::preview{file=…}`) that survive a remount of the message showing them.
 *
 * A transcript refresh can give a turn new message ids (the optimistic prompt becomes its stored row), and the
 * thread list then remounts the whole turn. A sandboxed frame taken out of the document reloads: the widget
 * loses everything its page held, the caret, and whatever was typed during the reload. So the frame is created
 * outside React. A mount that goes away moves it to a hidden parking spot with `Element.moveBefore` (a
 * state-preserving move: no reload), and the next mount of the same file in the same chat takes it back within
 * GRACE_MS. Browsers without `moveBefore` reload the frame, as before.
 */

const GRACE_MS = 5_000

/** Which mounts may take a frame over: the same file of the same profile, in the same chat. */
export interface FrameKey {
  /** `<profile>|<absolute path>` */
  file: string
  /** Stored session id; empty for a chat not saved yet (a saved chat may take such a frame over). */
  session: string
}

export interface KeptFrame {
  readonly token: string
  readonly frame: HTMLIFrameElement
  key: FrameKey
  mounted: boolean
  /** The page, its framed source and last measured size, so a mount taking the frame over paints it at once. */
  doc: null | string
  srcdoc: null | string
  height: null | number
  width: null | number
  timer: null | ReturnType<typeof setTimeout>
  readonly onDispose: () => void
}

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void }

const kept = new Map<string, KeptFrame>()
let parking: HTMLElement | null = null

const canMove = () => typeof Element !== 'undefined' && typeof (Element.prototype as Movable).moveBefore === 'function'

export const newFrameToken = () => Math.random().toString(36).slice(2)

/** A parked frame showing the same file of the same chat, which a new mount may take over. */
export function adoptableFrame(key: FrameKey): KeptFrame | null {
  for (const entry of kept.values()) {
    const sameChat = entry.key.session === key.session || entry.key.session === ''

    if (!entry.mounted && entry.srcdoc !== null && entry.key.file === key.file && sameChat) {
      return entry
    }
  }

  return null
}

/** The frame behind `token` (created on first claim) now belongs to a mount showing `key`. */
export function claimFrame(key: FrameKey, token: string, onDispose: () => void): KeptFrame {
  let entry = kept.get(token)

  if (!entry) {
    const frame = document.createElement('iframe')
    frame.className = 'absolute inset-0 size-full border-0 bg-transparent'
    frame.setAttribute('loading', 'lazy')
    // Scripts run, but with an opaque origin: no access to the app, its cookies, storage or the bridge.
    frame.setAttribute('sandbox', 'allow-scripts')
    entry = { doc: null, frame, height: null, key, mounted: true, onDispose, srcdoc: null, timer: null, token, width: null }
    kept.set(token, entry)
  }

  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }

  entry.mounted = true
  entry.key = key

  return entry
}

/** Put the frame into `host`, moving it without a reload when it is parked or shown elsewhere. */
export function placeFrame(entry: KeptFrame, host: HTMLElement): void {
  const { frame } = entry

  if (frame.parentNode === host) {
    return
  }

  frame.style.removeProperty('width')
  frame.style.removeProperty('height')

  if (frame.isConnected && canMove()) {
    try {
      ;(host as Movable).moveBefore!(frame, null)

      return
    } catch {
      // Not movable here: insert it, which reloads it.
    }
  }

  host.appendChild(frame)
}

export function setFrameDoc(entry: KeptFrame, srcdoc: string): void {
  if (entry.srcdoc !== srcdoc) {
    entry.srcdoc = srcdoc
    entry.frame.srcdoc = srcdoc
  }
}

/** The mount showing this frame went away: park it for the next mount, or let it go. */
export function releaseFrame(entry: KeptFrame): void {
  entry.mounted = false

  if (!canMove() || !entry.frame.isConnected || entry.srcdoc === null) {
    dispose(entry)

    return
  }

  // Pinned to its current size, so parking does not reflow the page inside.
  const { height, width } = entry.frame.getBoundingClientRect()
  entry.frame.style.width = `${width}px`
  entry.frame.style.height = `${height}px`

  try {
    ;(parkingSpot() as Movable).moveBefore!(entry.frame, null)
  } catch {
    dispose(entry)

    return
  }

  entry.timer = setTimeout(() => dispose(entry), GRACE_MS)
}

function dispose(entry: KeptFrame): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }

  if (kept.get(entry.token) === entry) {
    kept.delete(entry.token)
  }

  entry.frame.remove()
  entry.onDispose()
}

function parkingSpot(): HTMLElement {
  if (!parking?.isConnected) {
    parking = document.createElement('div')
    parking.setAttribute('aria-hidden', 'true')
    parking.dataset.slot = 'kept-frames'
    parking.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none'
    document.body.appendChild(parking)
  }

  return parking
}
