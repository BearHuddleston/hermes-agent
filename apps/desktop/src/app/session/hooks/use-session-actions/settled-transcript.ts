import type { ChatMessage } from '@/lib/chat-messages'
import { withoutCoveredAssistantPrefix } from '@/lib/chat-messages/coverage'

import { mergeLiveAssistantRun } from './live-turn-remainder'

const sameRow = (a: ChatMessage, b: ChatMessage) => a.id === b.id || (a.rowId !== undefined && a.rowId === b.rowId)

/** Completion owns liveness, not the history read's missing rows/results.
 * Reconcile only a proven shared user interval, or the assistant run containing
 * a shared tool when a cold viewer never received the prompt. */
export function reconcileSettledTranscript(durable: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  if (!durable.length) {
    return local
  }

  if (!local.length) {
    return durable
  }

  let localStart = -1
  let durableStart = -1

  for (let index = local.length - 1; index >= 0; index--) {
    if (local[index].role !== 'user') {
      continue
    }

    const match = durable.findIndex(message => message.role === 'user' && sameRow(message, local[index]))

    if (match >= 0) {
      localStart = index
      durableStart = match

      break
    }
  }

  if (durableStart < 0) {
    const firstUser = local.findIndex(message => message.role === 'user')
    const leading = firstUser < 0 ? local : local.slice(0, firstUser)

    const toolIds = new Set(
      leading.flatMap(message => message.parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])))
    )

    const toolRow = durable.findIndex(message =>
      message.parts.some(part => part.type === 'tool-call' && toolIds.has(part.toolCallId))
    )

    if (toolRow < 0) {
      // No occurrence identity: never discard the fetched prompt/history just
      // because local assistant-only rows have synthetic stream IDs.
      return [...durable, ...local]
    }

    durableStart = durable.findLastIndex((message, index) => index < toolRow && message.role === 'user')
  }

  const durableTail = durable.slice(durableStart + 1)
  const localTail = local.slice(localStart + 1)
  const nextUser = localTail.findIndex(message => message.role === 'user')
  const localRun = nextUser < 0 ? localTail : localTail.slice(0, nextUser)

  const localTools = new Map(
    localTail.flatMap(message =>
      message.parts.flatMap(part => (part.type === 'tool-call' ? [[part.toolCallId, part] as const] : []))
    )
  )

  const enriched = durableTail.map(message => ({
    ...message,
    parts: message.parts.map(part => {
      if (part.type !== 'tool-call') {
        return part
      }

      const live = localTools.get(part.toolCallId)

      return live
        ? {
            ...part,
            ...live,
            result: live.result !== undefined ? live.result : part.result,
            toolResultMetadata: { ...part.toolResultMetadata, ...live.toolResultMetadata }
          }
        : part
    })
  }))

  let remaining = withoutCoveredAssistantPrefix(enriched, localTail)

  if (remaining === localTail) {
    // A cold viewer can join halfway through the durable assistant run. Align
    // by tool identity, then require the same ordered-prefix proof; never use
    // equal prose elsewhere in the session to choose an offset.
    const nextDurableUser = enriched.findIndex(message => message.role === 'user')
    const durableRun = nextDurableUser < 0 ? enriched : enriched.slice(0, nextDurableUser)
    const parts = durableRun.flatMap(message => message.parts)

    const localParts = localRun.flatMap(message => message.parts)

    const firstTool = localParts.findIndex(part => part.type === 'tool-call')
    const anchor = localParts[firstTool]

    const durableTool =
      anchor?.type === 'tool-call'
        ? parts.findIndex(part => part.type === 'tool-call' && part.toolCallId === anchor.toolCallId)
        : -1

    const offset = durableTool - firstTool

    if (firstTool >= 0 && offset > 0) {
      remaining = withoutCoveredAssistantPrefix([{ ...durableRun[0], parts: parts.slice(offset) }], localTail)
    }
  }

  if (remaining !== localTail) {
    return [...durable.slice(0, durableStart + 1), ...enriched, ...remaining]
  }

  // The viewer may have missed every tool frame. Within the shared prompt,
  // merge its text-only reply into the durable structured run; do not compare
  // equal text from unrelated turns or consume an accepted next user prompt.
  if (localRun.every(message => message.parts.every(part => part.type === 'text'))) {
    return [
      ...durable.slice(0, durableStart + 1),
      ...mergeLiveAssistantRun(localRun, enriched),
      ...(nextUser < 0 ? [] : localTail.slice(nextUser))
    ]
  }

  // Divergent output without a proven ordered prefix is not safe to subtract.
  return [...durable, ...localTail]
}
