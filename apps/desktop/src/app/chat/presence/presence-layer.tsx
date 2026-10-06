import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { cursorAtPoint, pointForCursor } from '@/lib/presence-anchor'
import { presenceJoin, presenceNoteInput, presenceSetCursor } from '@/lib/presence-client'
import { $presencePeers, PEER_TYPING_TTL_MS, type PresencePeer, presenceUsers } from '@/store/presence'

import { PresenceAvatars } from './presence-avatars'

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

  usePointerBroadcast(surface, composerOwner, Boolean(room))
  useTypingBroadcast(composerOwner, Boolean(room))

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" data-slot="presence-layer" ref={anchorRef}>
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

function useTypingBroadcast(composerOwner: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    const editorOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(`[data-composer-owner="${CSS.escape(composerOwner)}"] [contenteditable="true"]`) : null

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

/** Peers' pointers, positioned per frame from their anchors so scroll and resize follow without re-rendering. */
function PeerCursors({ composerOwner, surface }: { composerOwner: string; surface: HTMLElement }) {
  const peers = useStore($presencePeers)
  const withCursor = useMemo(() => peers.filter(peer => peer.cursor), [peers])
  const nodes = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!withCursor.length) {
      return undefined
    }

    let frame = 0

    const place = () => {
      for (const peer of withCursor) {
        const node = nodes.current.get(peer.id)
        const point = peer.cursor ? pointForCursor(surface, composerOwner, peer.cursor) : null

        if (node) {
          node.style.opacity = point ? '1' : '0'

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
      {withCursor.map(peer => (
        <div
          className="absolute left-0 top-0 opacity-0 transition-[transform,opacity] duration-100 ease-linear will-change-transform"
          data-presence-cursor={peer.user}
          key={peer.id}
          ref={node => {
            if (node) {
              nodes.current.set(peer.id, node)
            } else {
              nodes.current.delete(peer.id)
            }
          }}
        >
          <PointerGlyph color={peer.color} />
          <span
            className="absolute left-3.5 top-4 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 text-white shadow-sm"
            style={{ backgroundColor: peer.color }}
          >
            {peer.name}
          </span>
        </div>
      ))}
    </>
  )
}

function PointerGlyph({ color }: { color: string }) {
  return (
    <svg aria-hidden className="block size-4 drop-shadow-sm" viewBox="0 0 16 16">
      <path d="M1.5 1.2 14 7.1 8.3 8.6 5.9 14.3z" fill={color} stroke="white" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  )
}

function usePeersTyping(): PresencePeer[] {
  const peers = useStore($presencePeers)
  const [now, setNow] = useState(() => Date.now())
  const typing = useMemo(() => peers.filter(peer => peer.typing && now - peer.seenAt < PEER_TYPING_TTL_MS), [now, peers])

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
          <span className="size-2 rounded-full ring-1 ring-(--ui-bg-elevated)" key={user.user} style={{ backgroundColor: user.color }} />
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
