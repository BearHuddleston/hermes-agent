/** Fit the browser app to the visible area when a keyboard leaves layout height
 * unchanged. `interactive-widget=resizes-content` handles supporting browsers;
 * VisualViewport covers the others. Pan/zoom stays with the browser: a pinch
 * must not turn its smaller visible area into a smaller application layout.
 */
export function installBrowserViewport(): () => void {
  const viewport = window.visualViewport
  const root = document.getElementById('root')

  if (!viewport || !root || document.documentElement.dataset.hermesDesktopHost !== 'browser') {
    return () => {}
  }

  let frame = 0

  const reset = () => {
    root.removeAttribute('data-browser-viewport')
    root.style.removeProperty('--browser-viewport-height')
    root.style.removeProperty('--browser-viewport-top')
  }

  const update = () => {
    frame = 0

    // Keep the last unzoomed layout during pinch/pan, including with an open
    // keyboard. No focus(), scrollIntoView(), or browser zoom changes here.
    if (Math.abs(viewport.scale - 1) > 0.01 || !Number.isFinite(viewport.height) || viewport.height <= 0) {
      return
    }

    const top = Math.max(0, viewport.offsetTop)

    if (Math.abs(viewport.height - window.innerHeight) < 1 && top < 1) {
      reset()

      return
    }

    // Hermes' UI scale is CSS zoom on <html>, separate from pinch zoom.
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
    root.style.setProperty('--browser-viewport-height', `${viewport.height / zoom}px`)
    root.style.setProperty('--browser-viewport-top', `${top / zoom}px`)
    root.setAttribute('data-browser-viewport', '')
  }

  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(update)
    }
  }

  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  update()

  return () => {
    cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    reset()
  }
}
