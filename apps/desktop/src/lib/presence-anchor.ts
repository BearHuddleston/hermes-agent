/**
 * Pointer anchors for co-presence. Two windows of the same chat differ in
 * width, scroll position and loaded history, so a raw x/y would land on the
 * wrong message. An anchor names WHAT the pointer is over instead:
 *
 * - `turn`: a transcript turn counted from the newest (0), plus the pointer's
 *   fraction of that turn's box. Counting from the end keeps two windows in
 *   agreement when one has paged in more history.
 * - `composer`: a fraction of the composer box.
 * - `viewport`: a fraction of the thread viewport (space between turns).
 *
 * The geometry is pure (rects in, anchors/points out) so it is testable
 * without layout; the DOM readers below resolve only the one element needed.
 */

export interface PresenceRect {
  left: number
  top: number
  width: number
  height: number
}

export type PresenceCursor =
  | { kind: 'composer'; x: number; y: number }
  | { kind: 'turn'; turn: number; x: number; y: number }
  | { kind: 'viewport'; x: number; y: number }

export const MAX_TURN_FROM_END = 999

export const rectContains = (rect: PresenceRect, x: number, y: number) =>
  x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height

const fraction = (value: number, start: number, size: number) =>
  size > 0 ? Math.round(Math.min(1, Math.max(0, (value - start) / size)) * 10_000) / 10_000 : 0

/** The pointer's position inside `rect` as fractions of its size. */
export const fractionsIn = (rect: PresenceRect, x: number, y: number) => ({
  x: fraction(x, rect.left, rect.width),
  y: fraction(y, rect.top, rect.height)
})

/** Client-space point for an anchor's fractions inside `target`. */
export const pointIn = (target: PresenceRect, cursor: Pick<PresenceCursor, 'x' | 'y'>) => ({
  x: target.left + cursor.x * target.width,
  y: target.top + cursor.y * target.height
})

const TURN_SELECTOR = '[data-slot="aui_message-group"]'
const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]'

const rectOf = (element: Element | null): null | PresenceRect => {
  if (!element) {
    return null
  }

  const { left, top, width, height } = element.getBoundingClientRect()

  return width > 0 || height > 0 ? { left, top, width, height } : null
}

function composerRoot(composerOwner: null | string): Element | null {
  return composerOwner
    ? document.querySelector(`[data-composer-owner="${CSS.escape(composerOwner)}"] [data-slot="composer-root"]`)
    : null
}

/** The anchor under a client-space point on `surface`, or null when it is off the chat. */
export function cursorAtPoint(
  surface: HTMLElement,
  composerOwner: null | string,
  x: number,
  y: number,
  target: Element | null
): null | PresenceCursor {
  const composer = rectOf(composerRoot(composerOwner))

  if (composer && rectContains(composer, x, y)) {
    return { kind: 'composer', ...fractionsIn(composer, x, y) }
  }

  const viewportElement = surface.querySelector(VIEWPORT_SELECTOR)
  const viewport = rectOf(viewportElement)

  if (!viewportElement || !viewport || !rectContains(viewport, x, y)) {
    return null
  }

  const turnElement = target?.closest(TURN_SELECTOR)
  const turnRect = turnElement && viewportElement.contains(turnElement) ? rectOf(turnElement) : null

  if (turnElement && turnRect) {
    const turns = [...viewportElement.querySelectorAll(TURN_SELECTOR)]
    const fromEnd = turns.length - 1 - turns.indexOf(turnElement)

    if (fromEnd >= 0 && fromEnd <= MAX_TURN_FROM_END) {
      return { kind: 'turn', turn: fromEnd, ...fractionsIn(turnRect, x, y) }
    }
  }

  return { kind: 'viewport', ...fractionsIn(viewport, x, y) }
}

/** Where a peer's anchor lands on `surface` (surface-relative px), or null when its target is not visible here. */
export function pointForCursor(
  surface: HTMLElement,
  composerOwner: null | string,
  cursor: PresenceCursor
): null | { x: number; y: number } {
  const surfaceRect = rectOf(surface)

  if (!surfaceRect) {
    return null
  }

  const viewportElement = surface.querySelector(VIEWPORT_SELECTOR)
  let target: null | PresenceRect

  if (cursor.kind === 'composer') {
    target = rectOf(composerRoot(composerOwner))
  } else if (cursor.kind === 'viewport') {
    target = rectOf(viewportElement)
  } else {
    const turns = viewportElement?.querySelectorAll(TURN_SELECTOR)
    target = turns ? rectOf(turns[turns.length - 1 - cursor.turn] ?? null) : null
  }

  if (!target) {
    return null
  }

  const point = pointIn(target, cursor)

  // A turn scrolled out of the viewport has no visible spot to point at.
  if (cursor.kind === 'turn') {
    const viewport = rectOf(viewportElement)

    if (!viewport || point.y < viewport.top || point.y > viewport.top + viewport.height) {
      return null
    }
  }

  return { x: point.x - surfaceRect.left, y: point.y - surfaceRect.top }
}
