import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { IMarker } from '@xterm/xterm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { markRightPanePerf } from '@/debug/right-pane-events'
import { triggerHaptic } from '@/lib/haptics'
import { isComposerChord } from '@/lib/keybinds/chords'
import { $previewTarget } from '@/store/preview'
import { useTheme } from '@/themes/context'

import { $terminalInjection } from '../store'

import { observeActiveTerminalResize } from './active-resize'
import { makeTerminalReader, registerTerminalReader } from './buffer'
import { mirrorSelection } from './clipboard'
import { trackTerminalCwd } from './cwd-tracking'
import { terminalLinkHandler, terminalWebLinksAddon } from './links'
import {
  keepEscapeSequences,
  mergeReviveSnapshot,
  PERSISTENT_SESSION_SCROLLBACK,
  resolveLiveSnapshotWindow,
  stripEscapeSequences,
  stripInitialPromptGap
} from './revive-snapshot'
import { resolveSurfaceColor, terminalSelectionAnchor, terminalSelectionLabel, terminalTheme } from './selection'
import { bindTerminalDrop } from './terminal-drop'
import { prepareTerminalFontFamily } from './terminal-font'
import { bindTerminalActivity, bindTerminalClipboard } from './terminal-input-bindings'
import { $terminals, markTerminalPersistent, removeExitedTerminal, updateTerminalReviveBuffer } from './terminals'
import { useTerminalFontController } from './use-terminal-font'

// Leading-edge throttle window for capturing history. The first output after an
// idle gap persists almost immediately (so `cmd; quit` is on disk before the
// renderer tears down), then at most once per window while output streams.
const SNAPSHOT_THROTTLE_MS = 750

// Status line written when a persistent PTY stream ends, keyed by exit signal.
const TERMINAL_EXIT_MESSAGES: Record<string, string> = {
  disconnected: 'Terminal disconnected. Press Enter to reconnect to the same shell.',
  expired: 'Terminal expired or exited. Press Enter to create a new shell.',
  superseded: 'Terminal is attached in another window. Press Enter to take it back.',
  denied: 'Terminal access denied. Check your sign-in and profile, then press Enter to retry.',
  capacity: 'Terminal capacity reached. Close another terminal, then press Enter to retry.'
}

// True once the page/app is tearing down (Cmd+Q, Alt+F4, window close, reload).
// App quit kills the PTYs from the main process, which fires onExit in the
// renderer — but React skips effect cleanups on teardown, so the per-instance
// `disposed` flag never flips. Without this guard those teardown exits would call
// closeTerminal() and wipe the persisted terminal list right before relaunch
// reads it. A real `exit`/Ctrl-D still closes the tab (flag stays false).
let appTearingDown = false

if (typeof window !== 'undefined') {
  const markTearingDown = () => {
    appTearingDown = true
  }

  window.addEventListener('pagehide', markTearingDown)
  window.addEventListener('beforeunload', markTearingDown)
  window.addEventListener('pageshow', () => { appTearingDown = false })
}

type TerminalStatus = 'closed' | 'open' | 'starting' | 'reconnecting'

// ⌘/Ctrl+L is a global shortcut, so a text selection in the file preview pane
// lands in this handler with no xterm selection. Label those with the previewed
// file's name instead of the shell, so the composer ref reads as a file quote
// rather than a bogus "zsh:N lines".
function previewSelectionLabel(): string {
  const target = $previewTarget.get()
  const source = target?.path || target?.url || ''

  return source.split(/[\\/]/).filter(Boolean).pop() || target?.label?.trim() || ''
}

interface UseTerminalSessionOptions {
  /** Renderer-side terminal id (the tab handle), used to key the agent reader. */
  id: string
  cwd: string
  /** Only the active tab is visible, owns the agent reader, and runs injections. */
  active: boolean
  onAddSelectionToChat: (text: string, label?: string) => void
  /** Last observed shell cwd from the previous session; the fresh PTY starts
   *  here (falling back to `cwd`) so a prior `cd` survives a relaunch. */
  restoreCwd?: string
  /** Serialized scrollback from the previous session, replayed once on mount. */
  reviveBuffer?: string
  /** Reports the resolved shell name once the PTY is live (for the tab label). */
  onShell?: (shell: string) => void
}

// Bind the palette to the live skin surface so the terminal blends with the app
// (and the contrast clamp has a real background to work against).
function withSurface(theme: ReturnType<typeof terminalTheme>) {
  const surface = resolveSurfaceColor(theme.background ?? '#ffffff')

  return { ...theme, background: surface, cursorAccent: surface }
}

export function useTerminalSession({
  id,
  cwd,
  active,
  onAddSelectionToChat,
  restoreCwd,
  reviveBuffer,
  onShell
}: UseTerminalSessionOptions) {
  // Key off renderedMode (the painted surface type), not resolvedMode (the
  // clicked switch) — a skin can keep a light surface in "dark" mode, and we
  // must match the surface or the ANSI palette inverts against it. themeName
  // re-resolves the canvas surface on skin switches (same mode, new tint).
  const { renderedMode, theme, themeName } = useTheme()
  // Adopt the skin's ANSI palette when it ships one (imported VS Code themes do),
  // matched to the painted variant; built-in skins carry none, so the terminal
  // keeps its VS Code defaults. withSurface still owns the background, so this
  // never touches transparency.
  const ansiPalette = renderedMode === 'dark' ? (theme.darkTerminal ?? theme.terminal) : theme.terminal
  const activeTheme = useMemo(() => terminalTheme(renderedMode, ansiPalette), [renderedMode, ansiPalette])
  const initialThemeRef = useRef(activeTheme)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // Snapshot the revive buffer once: live snapshots feed updateTerminalReviveBuffer
  // and would otherwise re-arm replay on every store-driven re-render.
  const initialReviveBufferRef = useRef(reviveBuffer)
  // The cwd to boot the fresh PTY in — the last dir the prior session observed
  // (survives a `cd`), captured once so store-driven re-renders don't move it.
  const initialRestoreCwdRef = useRef(restoreCwd)
  // Latest cwd seen this session; de-dupes redundant store writes.
  const lastObservedCwdRef = useRef<string | null>(null)
  // Whether the user ever fed input into this session (keystrokes, paste,
  // drag-and-drop paths, or an injected command). Gates idle-buffer handling in
  // persistSnapshot so an untouched tab never re-saves an accumulating snapshot.
  const hasSessionActivityRef = useRef(false)
  const initialActiveRef = useRef(active)
  const shellNameRef = useRef('shell')
  const selectionLabelRef = useRef('')
  const selectionRef = useRef('')
  const onAddSelectionToChatRef = useRef(onAddSelectionToChat)
  const onShellRef = useRef(onShell)
  // Re-fit on activation: a tab hidden via display:none has a 0×0 host, so its
  // last fit is stale by the time it's shown again.
  const fitRef = useRef<((visible: boolean) => void) | null>(null)
  const initialActiveFitRef = useRef(false)
  const { latestFontFamilyRef, mountedRef } = useTerminalFontController({ fitRef, termRef, webglRef })
  const [status, setStatus] = useState<TerminalStatus>('starting')
  const [selection, setSelection] = useState('')
  const [selectionStyle, setSelectionStyle] = useState<CSSProperties | null>(null)
  const [shellName, setShellName] = useState('shell')

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    onAddSelectionToChatRef.current = onAddSelectionToChat
    onShellRef.current = onShell
  }, [onAddSelectionToChat, onShell])

  // Live selection at call time. A redraw-heavy TUI (spinners, clocks) outruns
  // onSelectionChange, so trust xterm directly — fall back to the native
  // selection — rather than the cached ref / React state.
  const readSelection = useCallback(
    () => termRef.current?.getSelection() || window.getSelection()?.toString() || '',
    []
  )

  const addSelectionToChat = useCallback(() => {
    const termSelection = (termRef.current?.getSelection() || selectionRef.current).trim()
    const selectedText = termSelection || window.getSelection()?.toString() || ''
    const trimmed = selectedText.trim()

    if (!trimmed) {
      return
    }

    // Terminal selection → shell-anchored label; anything else came from the
    // preview pane sharing this global shortcut → label it with the file.
    const label = termSelection
      ? selectionLabelRef.current ||
        (termRef.current ? terminalSelectionLabel(termRef.current, shellNameRef.current, selectedText) : 'selection')
      : previewSelectionLabel() || 'selection'

    onAddSelectionToChatRef.current(trimmed, label)
    termRef.current?.clearSelection()
    selectionRef.current = ''
    selectionLabelRef.current = ''
    setSelection('')
    setSelectionStyle(null)
    triggerHaptic('selection')
  }, [])

  // Always listen — gating on the React selection state misses selections the
  // TUI redraw races. Only swallow ⌘/Ctrl+L when there's text to send, else it
  // must reach the shell as clear-screen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isComposerChord(event) || !readSelection().trim()) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      addSelectionToChat()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [addSelectionToChat, readSelection])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const host = hostRef.current
    const terminalApi = window.hermesDesktop?.terminal

    if (!host || !terminalApi) {
      setStatus('closed')

      return
    }

    let disposed = false
    let persistent = Boolean($terminals.get().find(term => term.id === id)?.persistent)
    let resumeOnly = persistent
    let replayWrites = 0
    let retrySession: (() => void) | null = null
    const cleanup: Array<() => void> = []
    let lastSentSize: { cols: number; rows: number } | null = null

    const term = new Terminal({
      allowProposedApi: true,
      // ⌥-drag is our force-selection gesture (below), and xterm's default
      // alt-click-moves-cursor claims the same click, emitting one cursor
      // left/right escape per column of travel — shells that don't consume them
      // echo the raw `^[[D` burst into the buffer. One gesture, one meaning.
      altClickMovesCursor: false,
      // Opaque canvas = WebGL's crisp fast-path. allowTransparency instead bakes
      // glyphs as grayscale-alpha for compositing over a see-through canvas, which
      // reads soft on every platform; VS Code keeps it off and our surface
      // (--ui-bg-chrome) is opaque anyway, so withSurface paints it solid.
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: latestFontFamilyRef.current,
      fontSize: 11,
      // VS Code's terminal renders 'normal'/'bold' (400/700); we were using Medium
      // (500) as the base, which reads a touch heavy at this size.
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      letterSpacing: 0,
      lineHeight: 1.12,
      // OSC 8 hyperlinks (gh, cargo, npm, ls --hyperlink) activate through this
      // handler; without it xterm shows a raw confirm() and then a window.open
      // Electron denies.
      linkHandler: terminalLinkHandler,
      // Full-screen TUIs (hermes --tui, vim) grab the mouse, so a plain drag
      // can't select — ⌥-drag (macOS) / Shift-drag (else) forces a native
      // selection over mouse-mode apps, which ⌘/Ctrl+L then sends to chat.
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      // VS Code/Cursor's secret sauce: terminal.integrated.minimumContrastRatio
      // defaults to 4.5 there. xterm defaults to 1 (off), which paints the raw
      // saturated ANSI palette — vivid green/cyan on white reads as candy.
      // Clamping to 4.5:1 darkens/lightens foregrounds against the background
      // at render time, matching the muted ink-like look of their terminal.
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      theme: withSurface(initialThemeRef.current)
    })

    const fit = new FitAddon()
    const serialize = new SerializeAddon()

    termRef.current = term
    term.loadAddon(fit)
    term.loadAddon(serialize)
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(terminalWebLinksAddon())
    term.unicode.activeVersion = '11'

    // Replay last session's scrollback before the fresh shell boots. The process
    // is NOT revived — a new shell starts one line below the restored history.
    // A marker at that boundary lets persistence append only new PTY output;
    // prior history is never reparsed or rewritten based on text heuristics.
    const initialReviveBuffer = initialReviveBufferRef.current ?? ''
    let liveStartMarker: IMarker | undefined
    let markHistoryReady: () => void = () => undefined

    const historyReady = new Promise<void>(resolve => {
      markHistoryReady = resolve
    })

    const markLiveStart = () => {
      liveStartMarker = term.registerMarker(0)
      markHistoryReady()
    }

    // Browser capability is negotiated by start metadata. Delay local history
    // until then, otherwise the server replay would duplicate it.
    let historyRestored = false

    const restoreHistory = () => {
      if (historyRestored) {return}
      historyRestored = true

      if (initialReviveBuffer && !persistent) {
        ++replayWrites
        term.write(initialReviveBuffer)
        term.write('\r\n', () => { --replayWrites; markLiveStart() })
      } else {
        markLiveStart()
      }
    }

    if (!terminalApi.detach) {restoreHistory()}

    cleanup.push(() => liveStartMarker?.dispose())

    const cwdTracker = trackTerminalCwd(id, {
      getSessionId: () => sessionIdRef.current,
      lastObservedCwdRef,
      term,
      terminalApi
    })

    cleanup.push(cwdTracker.dispose)

    // Capture the buffer on a leading-edge throttle and persist synchronously via
    // the store. No unload hook: by the time the user quits, a recent snapshot is
    // already on disk (the prior beforeunload-based attempt lost the last output).
    let snapshotTimer = 0
    let lastSnapshotAt = 0

    const persistSnapshot = () => {
      if (disposed || persistent) {
        return
      }

      lastSnapshotAt = Date.now()

      // No user input this session: never re-serialize. The live buffer now holds
      // replayed history plus fresh boot output, and re-saving that is exactly
      // what grew idle tabs by one prompt per relaunch (#61572). Preserve the
      // prior snapshot byte-for-byte; legacy text is ambiguous and must not be
      // auto-deleted merely because it resembles a prompt.
      if (!hasSessionActivityRef.current) {
        return
      }

      try {
        if (term.buffer.active.type !== 'normal' || !liveStartMarker) {
          return
        }

        const normal = term.buffer.normal
        const cursorLine = normal.baseY + normal.cursorY
        let lastContentLine = normal.length - 1

        while (lastContentLine > cursorLine && !normal.getLine(lastContentLine)?.translateToString(true)) {
          lastContentLine -= 1
        }

        // `normal.length` includes blank viewport rows below the cursor. A range
        // budget based on that capacity can start after the cursor and serialize
        // nothing (for example after a tall resize). The cursor is the live end;
        // if real content exists below it, provenance is uncertain and falls back.
        const end = cursorLine

        const liveWindow = resolveLiveSnapshotWindow(
          liveStartMarker.line,
          end,
          cursorLine,
          PERSISTENT_SESSION_SCROLLBACK,
          term.markers.includes(liveStartMarker) && lastContentLine <= cursorLine
        )

        let restored = initialReviveBuffer
        let live: string
        let nextSnapshot: string

        if (liveWindow) {
          // Once live output alone exceeds the replay budget, the restored prefix
          // has scrolled out and should no longer be carried into future sessions.
          if (!liveWindow.keepRestored) {
            restored = ''
          }

          live = serialize.serialize({ excludeAltBuffer: true, range: { end, start: liveWindow.start } })
          nextSnapshot = mergeReviveSnapshot(restored, live, shellNameRef.current, liveWindow.keepRestored)
        } else {
          // A reset, clear-screen, or scrollback trim can invalidate the logical
          // boundary. The current normal buffer is then authoritative, but its
          // restored/live provenance is unknown, so persist it without text-based
          // greeting or prompt cleanup rather than risk deleting real output.
          live = serialize.serialize({ excludeAltBuffer: true, scrollback: PERSISTENT_SESSION_SCROLLBACK })
          nextSnapshot = live
        }

        updateTerminalReviveBuffer(id, nextSnapshot)
      } catch {
        // Best-effort restore: never let serialization break a live terminal.
      }

      // A user command may have `cd`'d; refresh the persisted cwd (throttled).
      cwdTracker.probe()
    }

    const scheduleSnapshot = () => {
      if (snapshotTimer) {
        return
      }

      const elapsed = Date.now() - lastSnapshotAt

      if (elapsed >= SNAPSHOT_THROTTLE_MS) {
        persistSnapshot()

        return
      }

      snapshotTimer = window.setTimeout(() => {
        snapshotTimer = 0
        persistSnapshot()
      }, SNAPSHOT_THROTTLE_MS - elapsed)
    }

    cleanup.push(() => {
      if (snapshotTimer) {
        window.clearTimeout(snapshotTimer)
      }
    })

    const markActivity = () => {
      hasSessionActivityRef.current = true
    }

    cleanup.push(
      bindTerminalDrop(host, {
        getSessionId: () => sessionIdRef.current,
        getShellName: () => shellNameRef.current,
        markActivity,
        term,
        terminalApi
      })
    )

    // While armed, strip leading blank rows so the first prompt lands at the
    // very top (no starship `add_newline` gap). Do this only on renderer output:
    // never inject Ctrl-L or other cleanup keystrokes into the user's shell.
    let stripLeading = true

    const armedWrite = (data: string, onParsed: () => void) => {
      if (!stripLeading) {
        term.write(data, onParsed)

        return
      }

      const next = stripInitialPromptGap(data)
      const visible = stripEscapeSequences(next).replace(/[\s%]/g, '')

      if (!visible) {
        // Spacer / lone clear-screen / zsh `%` marker: apply control codes but
        // drop the blank text and stay armed so the prompt still lands at top.
        const controls = keepEscapeSequences(next)

        if (controls) {
          term.write(controls, onParsed)
        }

        return
      }

      stripLeading = false
      term.write(next, onParsed)
    }

    const fitAndResize = (visible: boolean) => {
      if (disposed || !host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
        return
      }

      try {
        fit.fit()
        markRightPanePerf(visible ? 'terminal-fit-active' : 'terminal-fit-hidden', id)
      } catch {
        return
      }

      const sessionId = sessionIdRef.current

      if (sessionId && (lastSentSize?.cols !== term.cols || lastSentSize?.rows !== term.rows)) {
        lastSentSize = { cols: term.cols, rows: term.rows }
        void terminalApi.resize(sessionId, { cols: term.cols, rows: term.rows })
      }
    }

    fitRef.current = fitAndResize

    cleanup.push(bindTerminalActivity(term, host, markActivity))

    const dataDisposable = term.onData(data => {
      if (replayWrites) {return}
      const id = sessionIdRef.current

      if (!id && retrySession && data === '\r') {
        const retry = retrySession
        retrySession = null
        setStatus('starting')
        retry()

        return
      }

      if (id) {
        void terminalApi.write(id, data)
      }
    })

    cleanup.push(() => dataDisposable.dispose())

    const selectionDisposable = term.onSelectionChange(() => {
      const next = term.getSelection()
      selectionRef.current = next
      selectionLabelRef.current = next.trim() ? terminalSelectionLabel(term, shellNameRef.current, next) : ''
      // Mirror into xterm's helper textarea so the OS sees a real selection —
      // that's what makes the Edit menu, ⌘C, and right-click Copy work over a
      // canvas that has no DOM selection of its own.
      mirrorSelection(host, next)
      setSelection(next)
      setSelectionStyle(next.trim() ? terminalSelectionAnchor(host) : null)
    })

    cleanup.push(() => selectionDisposable.dispose())

    cleanup.push(bindTerminalClipboard(term, host, markActivity))

    let cleanupAttempt: (() => void) | null = null

    const startSession = () => {
      cleanupAttempt?.()
      let current = true
      let attemptSessionId: string | null = null

      const releaseSession = (sid: string) => persistent && terminalApi.detach
        ? terminalApi.detach(sid) : terminalApi.dispose(sid)

      const subscriptions: Array<() => void> = []

      const release = () => {
        current = false
        subscriptions.splice(0).forEach(unsubscribe => unsubscribe())

        if (attemptSessionId) {
          const sid = attemptSessionId
          attemptSessionId = null

          if (sessionIdRef.current === sid) {
            sessionIdRef.current = null
          }

          void releaseSession(sid)
        }
      }

      cleanupAttempt = release

      void terminalApi
        // Prefer the last observed cwd so retry/relaunch stays in the same directory.
        .start({ cols: term.cols, cwd: lastObservedCwdRef.current || initialRestoreCwdRef.current || cwd, rows: term.rows, restoreKey: id, resumeOnly })
        .then(async session => {
          persistent = Boolean(session.persistent)
          resumeOnly = persistent

          if (persistent) {markTerminalPersistent(id)}

          if (disposed || !current) {
            void releaseSession(session.id)

            return
          }

          restoreHistory()
          attemptSessionId = session.id
          sessionIdRef.current = session.id
          lastSentSize = { cols: term.cols, rows: term.rows }
          shellNameRef.current = session.shell || 'shell'
          setShellName(session.shell || 'shell')
          onShellRef.current?.(session.shell || 'shell')

          const initial = term.hasSelection() ? term.getSelection() : ''
          selectionRef.current = initial
          selectionLabelRef.current = initial ? terminalSelectionLabel(term, shellNameRef.current, initial) : ''

          subscriptions.push(
            terminalApi.onData(session.id, (data, options) => {
              if (!current || disposed) {return}

              if (options?.replay) {
                ++replayWrites
                term.write(data, () => { --replayWrites })
              } else if (persistent) {
                term.write(data)
              } else {
                armedWrite(data, scheduleSnapshot)
              }
            }),
            terminalApi.onExit(session.id, exit => {
              if (!current || disposed || appTearingDown) {
                return
              }

              release()

              if (persistent && exit.signal) {
                setStatus('closed')
                resumeOnly = exit.signal !== 'expired'
                retrySession = startSession
                term.write(`\r\n${TERMINAL_EXIT_MESSAGES[exit.signal] || 'Terminal disconnected. Press Enter to reconnect.'}\r\n`)

                return
              }

              if (exit.signal === 'disconnected') {
                setStatus('closed')
                retrySession = startSession
                term.write('\r\nTerminal disconnected. Press Enter to start a new shell; scrollback is preserved.\r\n')

                return
              }

              // Only a current process exit removes the persisted tab.
              removeExitedTerminal(id)
            })
          )

          if (persistent && terminalApi.onState) {
            subscriptions.push(terminalApi.onState(session.id, state => {
              if (!current || disposed || appTearingDown) {return}
              setStatus(state === 'disconnected' ? 'closed' : state)

              if (state === 'reconnecting') {
                term.write('\r\nTerminal disconnected. Reconnecting to the same shell…\r\n')
              }
            }))
          }

          // onExit may replay a buffered exit before returning its unsubscribe.
          if (!current) {
            release()

            return
          }

          const attached = await terminalApi.attach(session.id)

          if (!attached) {
            throw new Error('Terminal session disappeared before its output stream attached')
          }

          if (disposed || !current) {
            return
          }

          if (!persistent) {setStatus('open')}

          window.requestAnimationFrame(() => {
            if (current && !disposed) {
              term.clearSelection()
            }
          })
        })
        .catch(error => {
          if (disposed || !current) {
            return
          }

          release()
          retrySession = startSession
          setStatus('closed')
          const expired = error && typeof error === 'object' && 'signal' in error && error.signal === 'expired'

          if (expired) {
            resumeOnly = false
            term.write(`${TERMINAL_EXIT_MESSAGES.expired}\r\n`)
          } else {
            term.write(`Terminal failed to start: ${error instanceof Error ? error.message : String(error)}. Press Enter to retry.\r\n`)
          }
        })
    }

    // Open + fit + start only once webfonts settle. Fitting with fallback metrics
    // picks the wrong row count, the shell boots at that size, then the real font
    // loads -> refit -> SIGWINCH -> the shell reprints its prompt lower, leaving
    // stale blank rows (and a stray selection) above it.
    const mount = () => {
      if (disposed || !host.isConnected) {
        return
      }

      term.open(host)
      mountedRef.current = true
      term.focus()

      // WebGL renderer matches the dashboard ChatPage path; xterm's default DOM
      // renderer paints SGR via CSS classes that visibly mute against our skins.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch (err) {
        console.warn('[hermes-terminal] WebGL unavailable; falling back to DOM', err)
      }

      fitAndResize(initialActiveRef.current)
      initialActiveFitRef.current = initialActiveRef.current
      void (terminalApi.detach ? Promise.resolve() : historyReady).then(() => {
        if (!disposed && host.isConnected) {
          startSession()
        }
      })
    }

    void prepareTerminalFontFamily(
      () => latestFontFamilyRef.current,
      () => !disposed && host.isConnected
    ).then(fontFamily => {
      if (!fontFamily) {
        return
      }

      term.options.fontFamily = fontFamily
      mount()
    })

    return () => {
      disposed = true
      mountedRef.current = false
      cleanupAttempt?.()
      cleanup.forEach(run => run())
      fitRef.current = null

      term.dispose()
      termRef.current = null
      webglRef.current = null
      shellNameRef.current = 'shell'
      selectionRef.current = ''
      selectionLabelRef.current = ''
    }
    // `id` is stable for the instance's life (keyed by tab id), so listing it
    // doesn't re-create the shell — it just satisfies the deps check for the
    // removeExitedTerminal(id) call in onExit.
  }, [addSelectionToChat, cwd, id, latestFontFamilyRef, mountedRef])

  useEffect(() => {
    const term = termRef.current

    if (!term) {
      return
    }

    // Re-resolve the surface in a rAF: ThemeProvider's applyTheme repaints the
    // CSS vars in a sibling effect that runs after this one, so reading now
    // would lag a mode behind. By the next frame the vars are current.
    const raf = requestAnimationFrame(() => {
      term.options.theme = withSurface(activeTheme)
      // The WebGL renderer caches glyph colors in a texture atlas, so a
      // light/dark switch leaves already-drawn cells stale until the atlas is
      // cleared. No-op for the DOM fallback.
      webglRef.current?.clearTextureAtlas()
    })

    return () => cancelAnimationFrame(raf)
  }, [activeTheme, themeName])

  // Expose this terminal's buffer to the agent's `read_terminal` tool, keyed by
  // id. The tab selection (setActiveTerminalId) decides which one it reads, so
  // every live terminal stays registered regardless of visibility.
  useEffect(() => {
    if (status !== 'open') {
      return
    }

    const term = termRef.current

    return term ? registerTerminalReader(id, makeTerminalReader(term)) : undefined
  }, [id, status])

  // Only the active terminal observes its host. Every terminal stays mounted
  // (PTY + scrollback preserved), but hidden tabs do no FitAddon/layout work.
  // Re-activation owns one fit + atlas rebuild + redraw.
  // eslint-disable-next-line no-restricted-syntax -- lifecycle flag prevents a duplicate first-mount fit
  useEffect(() => {
    if (!active || status !== 'open') {
      if (!active) {
        initialActiveFitRef.current = false
      }

      return
    }

    const host = hostRef.current

    if (!host) {
      return
    }

    const fitOnActivate = !initialActiveFitRef.current
    initialActiveFitRef.current = false

    return observeActiveTerminalResize(host, {
      fitOnActivate,
      onFit: () => fitRef.current?.(true),
      onActivate: () => {
        const term = termRef.current

        webglRef.current?.clearTextureAtlas()
        term?.refresh(0, term.rows - 1)
        term?.focus()
      }
    })
  }, [active, status])

  // Flush a queued command (e.g. a provider-disconnect) into the live session.
  // Only the active tab runs it (so a broadcast doesn't fan out to every shell);
  // the subscribe fires immediately, so a command set before this pane mounted
  // runs as soon as the session is ready. Cleared after writing so a later
  // remount can't replay a stale command.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!active || status !== 'open') {
      return
    }

    return $terminalInjection.subscribe(command => {
      const sessionId = sessionIdRef.current

      if (!command || !sessionId) {
        return
      }

      hasSessionActivityRef.current = true
      void window.hermesDesktop?.terminal?.write(sessionId, `${command}\r`)
      $terminalInjection.set(null)
      termRef.current?.focus()
    })
  }, [active, status])

  return {
    addSelectionToChat,
    hostRef,
    selection,
    selectionStyle,
    shellName,
    status
  }
}
