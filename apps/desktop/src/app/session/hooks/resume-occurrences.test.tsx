import type { GatewayEvent } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getLatestSessionMessages } from '@/hermes'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { resetInFlightTurnJournalStateForTests } from '@/lib/inflight-turn-journal'
import { $activeGatewayProfile } from '@/store/profile'
import {
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setMessages,
  setSelectedStoredSessionId,
  setSessions
} from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'
import type { SessionMessage, SessionResumeResult } from '@/types/hermes'

import { useMessageStream } from './use-message-stream'
import { useSessionActions } from './use-session-actions'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

const storedId = 'resume-occurrences'
const runtimeId = 'resume-runtime'
const prompt = 'Inspect both phases'
const commentary = 'Checking the phase.'
const tail = 'The result is still growing.'
const noop = async () => undefined
const user: SessionMessage = { id: 1, role: 'user', content: prompt, timestamp: 1 }

function history(comments: string[]): SessionMessage[] {
  return [
    { ...user },
    ...comments.flatMap((content, index): SessionMessage[] => [
      {
        id: 2 + index * 2,
        role: 'assistant',
        content,
        timestamp: 2 + index * 2,
        tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }]
      },
      { id: 3 + index * 2, role: 'tool', content: 'fixture', tool_call_id: `call-${index}`, timestamp: 3 + index * 2 }
    ])
  ]
}

function mount(snapshot: SessionResumeResult) {
  const requestGateway = vi.fn().mockResolvedValue(snapshot)

  const hook = renderHook(() => {
    const busyRef = useRef(false)
    const creatingSessionRef = useRef(false)
    const queryClient = useRef(new QueryClient()).current

    const cache = useSessionStateCache({
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      setMessages,
      setBusy,
      setAwaitingResponse
    })

    const actions = useSessionActions({
      ...cache,
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      creatingSessionRef,
      getRouteToken: () => 'A',
      getRoutedStoredSessionId: () => null,
      navigate: vi.fn(),
      requestGateway
    })

    const stream = useMessageStream({
      ...cache,
      queryClient,
      hydrateFromStoredSession: noop,
      refreshHermesConfig: noop,
      refreshSessions: noop
    })

    return { cache, actions, stream }
  })

  return { ...hook, requestGateway }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  clearAllSessionStates()
  resetInFlightTurnJournalStateForTests()
  _resetSessionOwnerHintsForTests()
  $activeGatewayProfile.set('default')
  setConnection(null)
  setMessages([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setBusy(false)
  setAwaitingResponse(false)
  setSessions([
    {
      id: storedId,
      title: storedId,
      source: 'desktop',
      message_count: 5,
      tool_call_count: 2,
      is_active: false,
      started_at: 1,
      last_active: 1,
      ended_at: null,
      model: null,
      preview: null,
      input_tokens: 0,
      output_tokens: 0
    }
  ])
  vi.mocked(getLatestSessionMessages).mockReset()
})
afterEach(() => {
  cleanup()
  clearAllSessionStates()
  resetInFlightTurnJournalStateForTests()
  localStorage.clear()
  setSessions([])
  setMessages([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setBusy(false)
  setAwaitingResponse(false)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([
  ['cold', true, 'equal'],
  ['sparse', true, 'equal'],
  ['warm', true, 'equal'],
  ['warm', false, 'equal'],
  ['warm', false, 'snapshot-ahead'],
  ['warm', false, 'local-ahead'],
  ['cold', false, 'missing-ids'],
  ['warm', false, 'delta-during-history']
] as const)(
  'reconciles ordered tool-round occurrences, not assistant ordinals (%s, repeated: %s, %s)',
  async (cacheKind, repeated, race) => {
    // Equal commentary is intentional; the producer suppresses its second interim,
    // not its second delta. Distinct commentary exercises the other live row shape.
    const comments = [commentary, repeated ? commentary : 'Checking another phase.']

    const snapshot: SessionResumeResult = {
      session_id: runtimeId,
      resumed: storedId,
      messages: [],
      message_count: 0,
      running: true,
      inflight: {
        user: prompt,
        assistant: [...comments, race === 'local-ahead' ? tail.slice(0, 10) : tail].join('\n\n'),
        streaming: true
      }
    }

    const { result } = mount(snapshot)

    if (cacheKind !== 'cold') {
      act(() => {
        result.current.cache.activeSessionIdRef.current = runtimeId
        result.current.cache.selectedStoredSessionIdRef.current = storedId
        result.current.cache.updateSessionState(
          runtimeId,
          state => ({ ...state, messages: toChatMessages([user]) }),
          storedId
        )
      })
    }

    if (cacheKind === 'warm') {
      const send = (type: GatewayEvent['type'], payload: GatewayEvent['payload'] = {}) =>
        act(() => result.current.stream.handleGatewayEvent({ session_id: runtimeId, type, payload }))

      send('message.start')
      comments.forEach((text, index) => {
        send('message.delta', { text: `${index ? '\n\n' : ''}${text}` })

        if (!index || !repeated) {
          send('message.interim', { text, already_streamed: true })
        }

        send('tool.start', { name: 'read_file', tool_id: `call-${index}`, args: {} })
        send('tool.complete', { name: 'read_file', tool_id: `call-${index}`, result: 'fixture' })
      })
      send('message.delta', { text: `\n\n${race === 'snapshot-ahead' ? 'The res' : tail}` })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
    }

    const durable = history(comments)

    if (race === 'missing-ids') {
      durable.forEach(row => {
        delete row.id
      })
    }

    let release!: () => void

    const held = new Promise<Awaited<ReturnType<typeof getLatestSessionMessages>>>(resolve => {
      release = () => resolve({ session_id: storedId, messages: durable })
    })

    vi.mocked(getLatestSessionMessages).mockReturnValue(held)
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.actions.resumeSession(storedId, true)
    })

    if (race === 'delta-during-history') {
      expect(getLatestSessionMessages).toHaveBeenCalled()
      act(() =>
        result.current.stream.handleGatewayEvent({
          session_id: runtimeId,
          type: 'message.delta',
          payload: { text: ' More.' }
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150)
      })
    }

    await act(async () => {
      release()
      await pending
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    const rows = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!.messages

    const displayed = rows
      .filter(row => row.role === 'assistant')
      .map(chatMessageText)
      .join('\n\n')
      .replace(/\s+/g, '')

    // Missing row identity cannot prove coverage: prefer a duplicate over silently
    // consuming an accepted live occurrence. The live tail must still be visible.
    if (race === 'missing-ids') {
      expect(displayed).toContain(tail.replace(/\s+/g, ''))
    } else {
      expect(displayed).toBe(
        [...comments, tail, race === 'delta-during-history' ? ' More.' : ''].join('').replace(/\s+/g, '')
      )
    }

    expect(
      rows.flatMap(row => row.parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])))
    ).toEqual(comments.map((_, index) => `call-${index}`))

    if (race !== 'missing-ids') {
      // Activation feeds its previous projection back into the warm cache.
      // Replaying an unchanged snapshot must not create another occurrence.
      for (let resume = 0; resume < 2; resume++) {
        await act(async () => {
          await result.current.actions.resumeSession(storedId, true)
        })
        const repeatedRows = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!.messages

        expect(repeatedRows.filter(row => row.role === 'assistant').map(chatMessageText)).toEqual(
          rows.filter(row => row.role === 'assistant').map(chatMessageText)
        )
        expect(
          repeatedRows.flatMap(row => row.parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])))
        ).toEqual(comments.map((_, index) => `call-${index}`))
        expect(new Set(repeatedRows.map(row => row.id)).size).toBe(repeatedRows.length)
      }
    }
  }
)

it.each(['snapshot-ahead', 'history-ahead', 'unpersisted-before-correction'] as const)(
  'uses raw producer offsets and consumes corrections by occurrence (%s)',
  async race => {
    const media = 'An artifact 📄: MEDIA:/workspace/report.pdf'
    const beforeCorrection = race === 'unpersisted-before-correction' ? '\n\nBefore the correction.' : ''
    const correction = prompt // A correction may deliberately repeat the prompt.
    const raw = [media + beforeCorrection, 'Following the correction.'].join('\n\n')

    const snapshot: SessionResumeResult = {
      session_id: runtimeId,
      resumed: storedId,
      messages: [],
      message_count: 0,
      running: true,
      inflight: {
        user: prompt,
        assistant: race === 'history-ahead' ? media : `${raw}\n\n${tail}`,
        corrections: [correction, correction],
        correction_offsets: [Array.from(media + beforeCorrection).length, Array.from(raw).length],
        streaming: true
      }
    }

    // The second accepted equal correction is not yet durable.
    const durable = history([media])
    durable.push({ id: 4, role: 'user', content: correction, display_kind: 'steer', timestamp: 4 })

    if (race === 'history-ahead') {
      durable.push({
        id: 5,
        role: 'assistant',
        content: 'Following the correction.',
        timestamp: 5,
        tool_calls: [{ id: 'later-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
      })
    }

    vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: durable })
    const { result } = mount(snapshot)
    await act(async () => {
      await result.current.actions.resumeSession(storedId, true)
    })
    const rows = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!.messages

    expect(rows.filter(row => row.role === 'user').map(chatMessageText)).toEqual([prompt, correction, correction])

    const texts = rows
      .filter(row => row.role === 'assistant')
      .map(chatMessageText)
      .join('\n')

    expect(texts.match(/An artifact 📄:/g)).toHaveLength(1)
    expect(texts).toContain('Following the correction.')

    if (race === 'snapshot-ahead') {
      expect(texts).toContain(tail)
    }

    if (beforeCorrection) {
      const beforeIndex = rows.findIndex(row => chatMessageText(row).includes(beforeCorrection.trim()))
      const correctionIndex = rows.findIndex(row => row.rowId === 4)
      expect(beforeIndex).toBeLessThan(correctionIndex)
    }
  }
)

it.each([prompt, 'Inspect the next file'])(
  'projects the accepted next-turn queue once across cold and repeated warm resume (%s)',
  async queued => {
    const durable = history([commentary])

    const snapshot: SessionResumeResult = {
      session_id: runtimeId,
      resumed: storedId,
      messages: [],
      message_count: 0,
      running: true,
      inflight: { user: prompt, assistant: `${commentary}\n\n${tail}`, streaming: true },
      queued: { user: queued }
    }

    vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: durable })

    const { result } = mount(snapshot)

    for (let resume = 0; resume < 3; resume++) {
      if (resume === 2) {
        // Later text-only arrivals extend the same backend queue slot.
        snapshot.queued!.user = `${queued}\n\nThen inspect the README`
      }

      await act(async () => {
        await result.current.actions.resumeSession(storedId, true)
      })
      const rows = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!.messages

      expect(rows.filter(row => row.role === 'user').map(chatMessageText)).toEqual([prompt, snapshot.queued!.user])
      expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
      expect(
        rows.flatMap(row => row.parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])))
      ).toEqual(['call-0'])
    }
  }
)

it('settles a retained idle error once across repeated resume and a changed error snapshot', async () => {
  const partial = 'The partial result'

  const snapshot: SessionResumeResult = {
    session_id: runtimeId,
    resumed: storedId,
    messages: [],
    message_count: 0,
    running: false,
    inflight: {
      user: prompt,
      assistant: partial,
      streaming: false,
      status: 'error',
      recoverable: true,
      error: 'Connection reset',
      error_surface: { layer: 'streaming', code: 'stream_drop', retryable: true }
    }
  }

  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: [user] })

  const { result } = mount(snapshot)

  for (let resume = 0; resume < 3; resume++) {
    if (resume === 2) {
      snapshot.inflight!.error = 'Upstream timed out'
      snapshot.inflight!.error_surface = { layer: 'provider', code: 'timeout', retryable: true }
    }

    await act(async () => {
      await result.current.actions.resumeSession(storedId, true)
    })
    const state = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!

    expect(state.messages.filter(row => row.role === 'assistant').map(chatMessageText)).toEqual([partial])
    expect(state.messages.filter(row => row.error)).toHaveLength(1)
    expect(state.messages.at(-1)).toMatchObject({
      error: snapshot.inflight!.error,
      errorSurface: snapshot.inflight!.error_surface,
      pending: false
    })
    expect(new Set(state.messages.map(row => row.id)).size).toBe(state.messages.length)
    expect(state.busy).toBe(false)
    expect(state.awaitingResponse).toBe(false)
  }
})

it.each(['activation', 'history'] as const)(
  'does not revive a turn that completes while warm %s is pending',
  async boundary => {
    for (const scenario of ['settled', 'next-turn', 'whole-turn', 'history-failure']) {
      const snapshot: SessionResumeResult = {
        session_id: runtimeId,
        resumed: storedId,
        messages: [],
        messages_omitted: true,
        message_count: 0,
        running: true,
        turn_started_at: 2,
        inflight: { user: prompt, assistant: commentary, streaming: true }
      }

      const durable = history([commentary])
      durable.push({ id: 4, role: 'assistant', content: 'Finished result.', timestamp: 4 })
      const { result, requestGateway } = mount(snapshot)
      act(() => {
        result.current.cache.activeSessionIdRef.current = runtimeId
        result.current.cache.selectedStoredSessionIdRef.current = storedId
        result.current.cache.updateSessionState(
          runtimeId,
          state => ({ ...state, messages: toChatMessages([user]) }),
          storedId
        )

        if (scenario === 'whole-turn') {
          return
        }

        result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
        result.current.stream.handleGatewayEvent({
          session_id: runtimeId,
          type: 'message.interim',
          payload: { text: commentary }
        })
        result.current.stream.handleGatewayEvent({
          session_id: runtimeId,
          type: 'tool.start',
          payload: { name: 'read_file', tool_id: 'call-0', args: {} }
        })
        result.current.stream.handleGatewayEvent({
          session_id: runtimeId,
          type: 'tool.complete',
          payload: { name: 'read_file', tool_id: 'call-0', result: 'fixture' }
        })
      })

      let release!: () => void

      if (boundary === 'activation') {
        requestGateway.mockReturnValue(
          new Promise<SessionResumeResult>(resolve => {
            release = () => resolve(snapshot)
          })
        )

        if (scenario === 'history-failure') {
          vi.mocked(getLatestSessionMessages).mockRejectedValue(new Error('history unavailable'))
        } else {
          vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: durable })
        }
      } else {
        vi.mocked(getLatestSessionMessages).mockReturnValue(
          new Promise((resolve, reject) => {
            release = () =>
              scenario === 'history-failure'
                ? reject(new Error('history unavailable'))
                : resolve({ session_id: storedId, messages: durable })
          })
        )
      }

      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.actions.resumeSession(storedId, true)
      })
      expect(requestGateway).toHaveBeenCalledWith(
        'session.activate',
        expect.objectContaining({ session_id: runtimeId })
      )

      if (scenario === 'whole-turn') {
        act(() => {
          result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
          result.current.stream.handleGatewayEvent({
            session_id: runtimeId,
            type: 'message.interim',
            payload: { text: commentary }
          })
        })
      }

      act(() =>
        result.current.stream.handleGatewayEvent({
          session_id: runtimeId,
          type: 'message.complete',
          payload: { text: 'Finished result.' }
        })
      )
      expect(result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)?.busy).toBe(false)

      if (scenario === 'next-turn') {
        act(() => {
          result.current.cache.updateSessionState(
            runtimeId,
            state => ({
              ...state,
              messages: [...state.messages, { id: 'user-next', role: 'user', parts: [{ type: 'text', text: prompt }] }]
            }),
            storedId
          )
          result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
          result.current.stream.handleGatewayEvent({
            session_id: runtimeId,
            type: 'message.interim',
            payload: { text: 'New turn progress.' }
          })
        })
      }

      const stateBeforeRelease = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!
      await act(async () => {
        release()
        await pending
      })
      const state = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!
      expect.soft(state.busy, scenario).toBe(stateBeforeRelease.busy)
      expect.soft(state.awaitingResponse, scenario).toBe(stateBeforeRelease.awaitingResponse)
      expect.soft(state.turnStartedAt, scenario).toBe(stateBeforeRelease.turnStartedAt)
      expect.soft(state.turnLive, scenario).toBe(stateBeforeRelease.turnLive)
      expect.soft(state.streamId, scenario).toBe(stateBeforeRelease.streamId)
      expect
        .soft(
          state.messages.some(message => message.pending),
          scenario
        )
        .toBe(stateBeforeRelease.messages.some(message => message.pending))

      const text = state.messages
        .filter(message => message.role === 'assistant')
        .map(chatMessageText)
        .join('\n')

      expect.soft(text.match(/Finished result\./g)).toHaveLength(1)
      expect.soft(text.match(/Checking the phase\./g)).toHaveLength(1)
      expect.soft(text.indexOf(commentary)).toBeLessThan(text.indexOf('Finished result.'))

      if (scenario === 'next-turn') {
        expect.soft(text.match(/New turn progress\./g)).toHaveLength(1)
        expect.soft(state.messages.filter(message => message.role === 'user')).toHaveLength(2)
      }

      cleanup()
    }
  }
)

it.each([true, false])('keeps cold history and completion when message.start was received: %s', async receivedStart => {
  for (const boundary of ['resume', 'history']) {
    const snapshot: SessionResumeResult = {
      session_id: runtimeId,
      resumed: storedId,
      messages: [],
      messages_omitted: true,
      message_count: 0,
      running: true,
      turn_started_at: 2,
      inflight: { user: prompt, assistant: commentary, streaming: true }
    }

    const durable = history([commentary])
    durable.push({ id: 4, role: 'assistant', content: 'Finished result.', timestamp: 4 })
    const { result, requestGateway } = mount(snapshot)
    let release!: () => void

    if (boundary === 'resume') {
      requestGateway.mockReturnValue(
        new Promise<SessionResumeResult>(resolve => {
          release = () => resolve(snapshot)
        })
      )
      vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: durable })
    } else {
      vi.mocked(getLatestSessionMessages).mockReturnValue(
        new Promise(resolve => {
          release = () => resolve({ session_id: storedId, messages: durable })
        })
      )
    }

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.actions.resumeSession(storedId, true)
    })
    expect(requestGateway).toHaveBeenCalledWith('session.resume', expect.objectContaining({ session_id: storedId }))
    act(() => {
      // A cold viewer can join an already-running turn without ever receiving
      // its start event or owning a local prompt row.
      if (receivedStart) {
        result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
      }

      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'message.interim',
        payload: { text: commentary }
      })
      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'tool.start',
        payload: { name: 'read_file', tool_id: 'call-0', args: {} }
      })
      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'tool.complete',
        payload: { name: 'read_file', tool_id: 'call-0', result: 'fixture' }
      })
      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'message.complete',
        payload: { text: 'Finished result.' }
      })
    })
    expect(result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)?.busy).toBe(false)
    await act(async () => {
      release()
      await pending
    })
    const state = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!
    expect.soft(state.busy, boundary).toBe(false)
    expect.soft(state.awaitingResponse, boundary).toBe(false)
    expect.soft(state.turnStartedAt, boundary).toBeNull()
    expect
      .soft(state.messages.filter(message => message.role === 'user').map(chatMessageText), boundary)
      .toEqual([prompt])
    expect
      .soft(
        state.messages.some(message => message.pending),
        boundary
      )
      .toBe(false)

    const text = state.messages
      .filter(message => message.role === 'assistant')
      .map(chatMessageText)
      .join('\n')

    expect.soft(text.match(/Finished result\./g), boundary).toHaveLength(1)
    expect.soft(text.match(/Checking the phase\./g), boundary).toHaveLength(1)
    cleanup()
  }
})

it.each(['activation', 'history'] as const)(
  'recovers a missed edit completion while warm %s settles',
  async boundary => {
    const snapshot: SessionResumeResult = {
      session_id: runtimeId,
      resumed: storedId,
      messages: [],
      messages_omitted: true,
      message_count: 0,
      running: true,
      turn_started_at: 2,
      inflight: { user: prompt, streaming: true }
    }

    const { result, requestGateway } = mount(snapshot)
    act(() => {
      result.current.cache.activeSessionIdRef.current = runtimeId
      result.current.cache.selectedStoredSessionIdRef.current = storedId
      result.current.cache.updateSessionState(
        runtimeId,
        state => ({ ...state, messages: toChatMessages([user]) }),
        storedId
      )
      result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'tool.start',
        payload: { name: 'patch', tool_id: 'edit-call', args: { path: 'publish.py' } }
      })
    })
    const inlineDiff = '--- a/publish.py\n+++ b/publish.py\n@@ -1 +1 @@\n-old\n+new'

    const durable: SessionMessage[] = [
      user,
      {
        id: 2,
        role: 'assistant',
        content: '',
        timestamp: 2,
        tool_calls: [
          { id: 'edit-call', type: 'function', function: { name: 'patch', arguments: '{"path":"publish.py"}' } }
        ]
      },
      {
        id: 3,
        role: 'tool',
        tool_call_id: 'edit-call',
        tool_name: 'patch',
        content: JSON.stringify({ success: true, diff: inlineDiff, files_modified: ['publish.py'] }),
        timestamp: 3
      },
      { id: 4, role: 'assistant', content: 'Finished result.', timestamp: 4 }
    ]

    let release!: () => void

    if (boundary === 'activation') {
      requestGateway.mockReturnValue(
        new Promise(resolve => {
          release = () => resolve(snapshot)
        })
      )
      vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: storedId, messages: durable })
    } else {
      vi.mocked(getLatestSessionMessages).mockReturnValue(
        new Promise(resolve => {
          release = () => resolve({ session_id: storedId, messages: durable })
        })
      )
    }

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.actions.resumeSession(storedId, true)
    })
    // tool.complete was lost before reattachment, but the terminal frame arrives.
    act(() =>
      result.current.stream.handleGatewayEvent({
        session_id: runtimeId,
        type: 'message.complete',
        payload: { text: 'Finished result.' }
      })
    )
    await act(async () => {
      release()
      await pending
    })
    const state = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!
    const tools = state.messages.flatMap(message => message.parts).filter(part => part.type === 'tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      toolCallId: 'edit-call',
      result: { success: true, diff: inlineDiff, files_modified: ['publish.py'] }
    })
    expect(
      state.messages
        .map(chatMessageText)
        .join('\n')
        .match(/Finished result\./g)
    ).toHaveLength(1)
    expect(state.busy).toBe(false)
  }
)

it('does not duplicate an optimistic prompt when its turn completes while warm history is pending', async () => {
  const snapshot: SessionResumeResult = {
    session_id: runtimeId,
    resumed: storedId,
    messages: [],
    messages_omitted: true,
    message_count: 0,
    running: true,
    turn_started_at: 2,
    inflight: { user: prompt, assistant: commentary, streaming: true }
  }

  const durable = history([commentary])
  durable.push({ id: 4, role: 'assistant', content: 'Finished result.', timestamp: 4 })
  const { result } = mount(snapshot)
  act(() => {
    result.current.cache.activeSessionIdRef.current = runtimeId
    result.current.cache.selectedStoredSessionIdRef.current = storedId
    // Accepted but not yet acknowledged: synthetic ID and no durable rowId.
    result.current.cache.updateSessionState(
      runtimeId,
      state => ({
        ...state,
        messages: [{ id: 'user-1790000000', role: 'user', parts: [{ type: 'text', text: prompt }] }]
      }),
      storedId
    )
    result.current.stream.handleGatewayEvent({ session_id: runtimeId, type: 'message.start', payload: {} })
    result.current.stream.handleGatewayEvent({
      session_id: runtimeId,
      type: 'message.interim',
      payload: { text: commentary }
    })
    result.current.stream.handleGatewayEvent({
      session_id: runtimeId,
      type: 'tool.start',
      payload: { name: 'read_file', tool_id: 'call-0', args: {} }
    })
    result.current.stream.handleGatewayEvent({
      session_id: runtimeId,
      type: 'tool.complete',
      payload: { name: 'read_file', tool_id: 'call-0', result: 'fixture' }
    })
  })

  let release!: () => void
  vi.mocked(getLatestSessionMessages).mockReturnValue(
    new Promise(resolve => {
      release = () => resolve({ session_id: storedId, messages: durable })
    })
  )

  let pending!: Promise<void>
  await act(async () => {
    pending = result.current.actions.resumeSession(storedId, true)
  })
  act(() =>
    result.current.stream.handleGatewayEvent({
      session_id: runtimeId,
      type: 'message.complete',
      payload: { text: 'Finished result.' }
    })
  )
  await act(async () => {
    release()
    await pending
  })

  const state = result.current.cache.sessionStateByRuntimeIdRef.current.get(runtimeId)!
  expect(state.messages.filter(message => message.role === 'user').map(chatMessageText)).toEqual([prompt])

  const text = state.messages
    .filter(message => message.role === 'assistant')
    .map(chatMessageText)
    .join('\n')

  expect(text.match(/Finished result\./g)).toHaveLength(1)
  expect(text.match(/Checking the phase\./g)).toHaveLength(1)
})
