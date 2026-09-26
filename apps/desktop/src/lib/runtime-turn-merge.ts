import { type ChatMessage, chatMessageText, normalizeWs as normalizedText } from '@/lib/chat-messages'
import { withoutCoveredAssistantPrefix } from '@/lib/chat-messages/coverage'
import {
  assistantHasRecoverableContent,
  coveredHumanOccurrences,
  type InFlightRecoveryResult,
  isLiveProjectionRow,
  overlayProjectionRow,
  userMessagesMatch
} from '@/lib/inflight-turn-rows'

function sameRuntimeAnchor(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) {
    return false
  }

  if (left.rowId !== undefined && right.rowId !== undefined) {
    return left.rowId === right.rowId
  }

  return left.timestamp !== undefined && left.timestamp === right.timestamp &&
    normalizedText(chatMessageText(left)) === normalizedText(chatMessageText(right))
}

/** Runtime projections have no guaranteed user row. Their backend identity
 * provides the recovery boundary, including across reused stream ids. */
export function mergeRuntimeTurn(
  baseMessages: ChatMessage[],
  journal: ChatMessage[],
  startedAt: number,
  keepPending: boolean
): InFlightRecoveryResult {
  const boundary = journal.findIndex(message => message.runtimeTurnStartedAt === startedAt)
  const anchor = journal[boundary - 1]
  let tail = journal.slice(boundary)
  let first = baseMessages.findIndex(message => message.runtimeTurnStartedAt === startedAt)
  let last = baseMessages.findLastIndex(message => message.runtimeTurnStartedAt === startedAt)
  const anchorIndex = anchor ? baseMessages.findLastIndex(message => sameRuntimeAnchor(message, anchor)) : -1
  let baseTurn = first < 0 ? [] : baseMessages.slice(first, last + 1)

  const currentRuntimeAssistant = baseMessages.findLastIndex(message =>
    message.role === 'assistant' && message.pending === true && message.runtimeTurnStartedAt === startedAt
  )

  const otherLiveAssistant = baseMessages.findLast((message, index) =>
    message.role === 'assistant' && message.pending === true && message.runtimeTurnStartedAt !== startedAt &&
    (currentRuntimeAssistant < 0 || index > currentRuntimeAssistant)
  )

  const humans = tail.filter(message => message.role === 'user' && message.userOriginated !== false)

  // Raw persisted history does not have renderer runtime markers. Only an
  // exact durable predecessor can prove its suffix; a later human turn or a
  // different marked runtime ends that suffix. Known corrections remain human
  // rows and are consumed in order. Without either identity proof, retain the
  // journal rather than guessing that a global same-text reply committed it.
  let committedCandidates = baseTurn

  if (anchorIndex >= 0 && (first < 0 || anchorIndex < first)) {
    committedCandidates = []
    let correction = 0

    for (const message of baseMessages.slice(anchorIndex + 1)) {
      if (message.runtimeTurnStartedAt !== undefined && message.runtimeTurnStartedAt !== startedAt) {
        break
      }

      if (message.role === 'user' && message.userOriginated !== false) {
        const covered = coveredHumanOccurrences(message, humans, correction)

        if (!covered) {
          break
        }

        correction += covered
      }

      committedCandidates.push(message)
    }

    // Reconcile against this same proven interval, not an empty marked turn.
    // Otherwise partial coverage appends the already durable humans again.
    if (committedCandidates.length) {
      first = anchorIndex + 1
      last = anchorIndex + committedCandidates.length
      baseTurn = committedCandidates
    }
  }

  const durableHumans = committedCandidates.filter(message => message.role === 'user' &&
    message.userOriginated !== false && !message.recovered && message.pending !== true &&
    (message.rowId !== undefined || message.timestamp !== undefined))

  // A receipt for one occurrence cannot cover a later identical correction or
  // queued prompt. Assistant/tool persistence says nothing about these rows.
  let committedHumanCount = 0

  for (const message of durableHumans) {
    const covered = coveredHumanOccurrences(message, humans, committedHumanCount)

    if (!covered) {
      break
    }

    committedHumanCount += covered
  }

  const humansCommitted = committedHumanCount === humans.length

  const committed = committedCandidates.filter(message => message.role === 'assistant' &&
    message.pending !== true && !message.interim && !message.recovered &&
    (!isLiveProjectionRow(message) || message.completedAt !== undefined))

  const committedParts = committed.flatMap(message => message.parts)

  const structureCommitted = tail.every(message => message.parts.every(part => {
    if (part.type === 'tool-call') {
      // A flushed invocation does not prove that its result was persisted.
      // The bounded journal retains result presence even when it omits payloads.
      return part.toolCallId !== undefined && committedParts.some(candidate =>
        candidate.type === 'tool-call' && candidate.toolCallId === part.toolCallId &&
        (part.result === undefined || candidate.result !== undefined))
    }

    return part.type !== 'reasoning' || committedParts.some(candidate =>
      candidate.type === 'reasoning' && candidate.text.startsWith(part.text))
  }))

  const contentCommitted = tail.filter(assistantHasRecoverableContent).every(message => {
    const text = normalizedText(chatMessageText(message))

    if (message.error) {
      return committed.some(candidate => candidate.error === message.error &&
        (!text || normalizedText(chatMessageText(candidate)).startsWith(text)))
    }

    // A persisted final answer may extend the last throttled partial. Empty
    // text needs explicit structural coverage; an unrelated body proves none.
    return text ? committed.some(candidate => normalizedText(chatMessageText(candidate)).startsWith(text))
      : message.parts.some(part => part.type === 'tool-call' || part.type === 'reasoning') && structureCommitted
  })

  if (humansCommitted && contentCommitted && structureCommitted) {
    return { applied: false, caughtUp: true, messages: baseMessages, streamId: null, turnStartedAt: null }
  }

  // Occurrence reconciliation may already have split durable tool rounds from
  // the live suffix. Consume that proven prefix before overlaying the journal,
  // just as human-turn recovery does, without consuming runtime/correction rows.
  if (contentCommitted && structureCommitted) {
    tail = tail.filter(message => message.role !== 'assistant')
  }

  const firstAssistant = tail.findIndex(message => message.role === 'assistant')
  const beforeCoverage = tail

  if (firstAssistant >= 0) {
    tail = [
      ...tail.slice(0, firstAssistant),
      ...withoutCoveredAssistantPrefix(committed, tail.slice(firstAssistant))
    ]
  }

  const lastJournalAssistant = tail.findLast(assistantHasRecoverableContent)

  const lastLiveAssistant = baseTurn.findLastIndex(message => message.role === 'assistant' &&
    message.runtimeTurnStartedAt === startedAt && (message.pending === true || Boolean(message.error)))

  const keepRuntimePending = keepPending && !otherLiveAssistant
  const usedIds = new Set(baseMessages.map(message => message.id))
  const merged: ChatMessage[] = []
  const groupedHumans = new Set<ChatMessage>()
  let cursor = 0

  for (const [tailIndex, row] of tail.entries()) {
    if (groupedHumans.has(row)) {
      continue
    }

    const humanIndex = humans.indexOf(row)

    const match = row === lastJournalAssistant && lastLiveAssistant >= cursor
      ? lastLiveAssistant
      : baseTurn.findIndex((candidate, index) =>
          index >= cursor && candidate.role === row.role &&
          (candidate.id === row.id ||
            (row.rowId !== undefined && candidate.rowId === row.rowId) ||
            (row.role === 'user' ? (humanIndex >= 0
              ? coveredHumanOccurrences(candidate, humans, humanIndex) > 0 : userMessagesMatch(candidate, row))
              : normalizedText(chatMessageText(candidate)) === normalizedText(chatMessageText(row))))
        )

    if (match >= 0) {
      merged.push(...baseTurn.slice(cursor, match))
      const candidate = baseTurn[match]

      if (humanIndex >= 0) {
        const covered = coveredHumanOccurrences(candidate, humans, humanIndex)
        humans.slice(humanIndex + 1, humanIndex + covered).forEach(human => groupedHumans.add(human))
      }

      // A remainder can be just an unflushed result of this very same durable
      // bubble. Overlay its full journal row, not a prefix-subtracted fragment
      // that would erase the already covered text/tools.
      const overlay = candidate.id === row.id || (row.rowId !== undefined && candidate.rowId === row.rowId)
        ? beforeCoverage.find(original => original.id === row.id) ?? row
        : row

      merged.push(row.role === 'assistant' ? overlayProjectionRow(candidate, overlay) : candidate)
      cursor = match + 1

      continue
    }

    // The accepted next-turn queue is outside this runtime boundary. Keep its
    // existing projection when the same queue envelope is already represented.
    if (row.id.startsWith('user-queued-') && baseMessages.some(candidate =>
      candidate.id.startsWith('user-queued-') && userMessagesMatch(candidate, row))) {
      continue
    }

    // The covered assistant prefix precedes the first missing correction.
    // Removing it from the journal must not move that correction above it.
    if (row.role === 'user' && contentCommitted && structureCommitted) {
      merged.push(...baseTurn.slice(cursor))
      cursor = baseTurn.length
    }

    // An old runtime tail may collide with a later human turn's reused stream
    // id. Preserve it under a stable recovery id instead of attaching its tools
    // to that human reply or dropping it in withoutBaseIds.
    let id = row.id
    let collision = 0

    while (usedIds.has(id)) {
      id = `runtime-recovery-${startedAt}-${tailIndex}-${collision++}-${row.id}`
    }

    usedIds.add(id)
    merged.push({ ...row, id, pending: row.role === 'assistant' && keepRuntimePending && row.pending === true,
      ...(!keepRuntimePending ? { recovered: true } : {}) })
  }

  merged.push(...baseTurn.slice(cursor))

  const runtimeMessages = keepRuntimePending ? merged : merged.map(message =>
    message.role === 'assistant' && message.runtimeTurnStartedAt === startedAt && message.pending === true
      ? { ...message, pending: false }
      : message)

  const messages = first < 0
    ? [...baseMessages, ...runtimeMessages]
    : [...baseMessages.slice(0, first), ...runtimeMessages, ...baseMessages.slice(last + 1)]

  const runtimeAssistant = runtimeMessages.findLast(assistantHasRecoverableContent)

  return {
    applied: true,
    caughtUp: false,
    messages,
    streamId: keepPending ? (otherLiveAssistant?.id ?? runtimeAssistant?.id ?? null) : null,
    turnStartedAt: null
  }
}
