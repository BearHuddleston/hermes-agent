import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { cursorAtPoint, pointForCursor, viewAnchor } from '@/lib/presence-anchor'
import { presenceJoin, presenceNoteInput, presenceSetCursor } from '@/lib/presence-client'
import { $presencePeers, PEER_TYPING_TTL_MS, type PresencePeer, presenceUsers } from '@/store/presence'

import { PresenceAvatars } from './presence-avatars'
import { useSharesPointer } from './use-shares-pointer'

interface PresenceLayerProps {
  /** `data-composer-owner` of this surface's composer. */
  composerOwner: string
  profile: null | string
  /** `presenceRoom(profile, lineageRootSessionId)`; null leaves the room. */
  room: null | string
}

/**
 * Co-presence for the primary chat surface of a browser-hosted window:
 * broadcasts this window's pointer and typing, paints everyone else's.
 * Must render inside the `[data-chat-surface]` element it decorates.
 */
export function PresenceLayer({ composerOwner, profile, room }: PresenceLayerProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [surface, setSurface] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setSurface(anchorRef.current?.closest<HTMLElement>('[data-chat-surface]') ?? null)
  }, [])

  useEffect(() => presenceJoin(room, profile), [profile, room])
  // Leaving the chat surface entirely (unmount) leaves the room.
  useEffect(() => () => presenceJoin(null, null), [])

  // A finger has no hover position worth sharing: a touch window shares the message it is reading.
  const sharesPointer = useSharesPointer()

  usePointerBroadcast(surface, composerOwner, Boolean(room) && sharesPointer)
  useViewBroadcast(surface, Boolean(room) && !sharesPointer)
  useTypingBroadcast(composerOwner, Boolean(room))

  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 overflow-hidden"
      data-slot="presence-layer"
      ref={anchorRef}
    >
      {/* The Webapp's tab strip replaces the chat header, so the roster floats on the surface itself. */}
      {room && (
        <div className="absolute right-3 top-[calc(var(--titlebar-height,0px)+0.5rem)]">
          <PresenceAvatars />
        </div>
      )}
      {surface && <PeerCursors composerOwner={composerOwner} surface={surface} />}
      <TypingIndicator />
    </div>
  )
}

function usePointerBroadcast(surface: HTMLElement | null, composerOwner: string, enabled: boolean) {
  useEffect(() => {
    if (!surface || !enabled) {
      return undefined
    }

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        return // a finger has no hover position worth sharing
      }

      presenceSetCursor(
        cursorAtPoint(surface, composerOwner, event.clientX, event.clientY, event.target as Element | null)
      )
    }

    const onLeave = () => presenceSetCursor(null)

    // The floating composer can portal out of the surface: listen on the document, filter by geometry.
    document.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onLeave)

    return () => {
      document.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
      presenceSetCursor(null)
    }
  }, [composerOwner, enabled, surface])
}

/** Touch windows: the turn in the middle of the transcript, re-sent as the reader scrolls. */
function useViewBroadcast(surface: HTMLElement | null, enabled: boolean) {
  useEffect(() => {
    if (!surface || !enabled) {
      return undefined
    }

    let frame = 0

    const share = () => {
      frame = 0
      presenceSetCursor(viewAnchor(surface))
    }

    const onScroll = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(share)
      }
    }

    share()
    // Capture on the surface: scroll does not bubble, and the transcript viewport is replaced on a chat switch.
    surface.addEventListener('scroll', onScroll, { capture: true, passive: true })

    return () => {
      surface.removeEventListener('scroll', onScroll, { capture: true })
      window.cancelAnimationFrame(frame)
      presenceSetCursor(null)
    }
  }, [enabled, surface])
}

function useTypingBroadcast(composerOwner: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    const editorOf = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>(`[data-composer-owner="${CSS.escape(composerOwner)}"] [contenteditable="true"]`)
        : null

    const onInput = (event: Event) => {
      const editor = editorOf(event.target)

      if (editor) {
        presenceNoteInput(Boolean(editor.textContent?.trim()))
      }
    }

    // Sending clears the editor without an input event.
    const onKeyDown = (event: KeyboardEvent) => {
      const editor = editorOf(event.target)

      if (editor && event.key === 'Enter' && !event.shiftKey) {
        window.setTimeout(() => presenceNoteInput(Boolean(editor.textContent?.trim())), 80)
      }
    }

    document.addEventListener('input', onInput, true)
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('keydown', onKeyDown, true)
      presenceNoteInput(false)
    }
  }, [composerOwner, enabled])
}

/** How long a still pointer keeps its name label before it fades and stops covering the text under it. */
const LABEL_IDLE_MS = 1_600

/** Peers' pointers, positioned per frame from their anchors so scroll and resize follow without re-rendering. */
function PeerCursors({ composerOwner, surface }: { composerOwner: string; surface: HTMLElement }) {
  const { t } = useI18n()
  const peers = useStore($presencePeers)
  const withCursor = useMemo(() => peers.filter(peer => peer.cursor), [peers])
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const moved = useRef(new Map<string, { at: number; key: string }>())

  useEffect(() => {
    if (!withCursor.length) {
      return undefined
    }

    let frame = 0

    const place = () => {
      const now = performance.now()

      for (const peer of withCursor) {
        const node = nodes.current.get(peer.id)
        const point = peer.cursor ? pointForCursor(surface, composerOwner, peer.cursor) : null
        const key = JSON.stringify(peer.cursor)
        const last = moved.current.get(peer.id)

        if (last?.key !== key) {
          moved.current.set(peer.id, { at: now, key })
        }

        if (node) {
          node.style.opacity = point ? '1' : '0'
          node.dataset.idle = now - (moved.current.get(peer.id)?.at ?? now) > LABEL_IDLE_MS ? 'true' : 'false'

          if (point) {
            node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
          }
        }
      }

      frame = window.requestAnimationFrame(place)
    }

    place()

    return () => window.cancelAnimationFrame(frame)
  }, [composerOwner, surface, withCursor])

  return (
    <>
      {withCursor.map(peer =>
        peer.cursor?.kind === 'view' ? (
          // A touch reader: a dot in the gutter beside the message they are on. Its label shows
          // while they scroll and fades once they settle, so it never sits on the text for long.
          <div
            className="group/peer absolute left-0 top-0 opacity-0 transition-[transform,opacity] duration-200 ease-out will-change-transform"
            data-presence-view={peer.user}
            key={peer.id}
            ref={node => void (node ? nodes.current.set(peer.id, node) : nodes.current.delete(peer.id))}
          >
            <span
              className="absolute right-1 top-0 size-2.5 -translate-y-1/2 rounded-full ring-2 ring-(--ui-chat-surface-background)"
              style={{ backgroundColor: peer.color }}
            />
            <span
              className="absolute left-0 top-0 -translate-y-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 text-white shadow-sm transition-opacity duration-300 group-data-[idle=true]/peer:opacity-0"
              style={{ backgroundColor: peer.color }}
            >
              {t.presence.viewingHere(peer.name)}
            </span>
          </div>
        ) : (
          <div
            className="group/peer absolute left-0 top-0 opacity-0 transition-[transform,opacity] duration-100 ease-linear will-change-transform"
            data-presence-cursor={peer.user}
            key={peer.id}
            ref={node => void (node ? nodes.current.set(peer.id, node) : nodes.current.delete(peer.id))}
          >
            <PointerGlyph color={peer.color} />
            <span
              className="absolute left-3.5 top-4 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 text-white shadow-sm transition-opacity duration-300 group-data-[idle=true]/peer:opacity-0"
              style={{ backgroundColor: peer.color }}
            >
              {peer.name}
            </span>
          </div>
        )
      )}
    </>
  )
}

function PointerGlyph({ color }: { color: string }) {
  return (
    <svg aria-hidden className="block size-4 drop-shadow-sm" viewBox="0 0 16 16">
      <path
        d="M1.5 1.2 14 7.1 8.3 8.6 5.9 14.3z"
        fill={color}
        stroke="white"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function usePeersTyping(): PresencePeer[] {
  const peers = useStore($presencePeers)
  const [now, setNow] = useState(() => Date.now())

  const typing = useMemo(
    () => peers.filter(peer => peer.typing && now - peer.seenAt < PEER_TYPING_TTL_MS),
    [now, peers]
  )

  // Re-check the TTL while anyone is typing: a closed laptop never sends "stopped".
  useEffect(() => {
    setNow(Date.now())

    if (!peers.some(peer => peer.typing)) {
      return undefined
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1_000)

    return () => window.clearInterval(timer)
  }, [peers])

  return typing
}

function TypingIndicator() {
  const { t } = useI18n()
  const typing = presenceUsers(usePeersTyping())

  if (!typing.length) {
    return null
  }

  const label =
    typing.length === 1
      ? t.presence.typingOne(typing[0].name)
      : typing.length === 2
        ? t.presence.typingTwo(typing[0].name, typing[1].name)
        : t.presence.typingMany(typing.length)

  return (
    <div
      aria-live="polite"
      className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-(--ui-bg-elevated) px-2.5 py-1 text-xs text-(--ui-text-secondary) shadow-sm"
      data-slot="presence-typing"
      style={{ bottom: 'calc(var(--composer-measured-height, 6rem) + 0.5rem)' }}
    >
      <span className="flex -space-x-1">
        {typing.slice(0, 3).map(user => (
          <span
            className="size-2 rounded-full ring-1 ring-(--ui-bg-elevated)"
            key={user.user}
            style={{ backgroundColor: user.color }}
          />
        ))}
      </span>
      <span>{label}</span>
      <span aria-hidden className="presence-typing-dots inline-flex gap-0.5">
        <span className="size-1 animate-pulse rounded-full bg-current" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
      </span>
    </div>
  )
}
