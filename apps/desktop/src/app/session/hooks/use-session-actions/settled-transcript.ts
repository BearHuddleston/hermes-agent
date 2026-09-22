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

    const matchingIntervals = new Set<number>()
    let userIndex = -1

    for (let index = 0; index < durable.length; index++) {
      const message = durable[index]

      if (message.role === 'user') {
        userIndex = index
      }

      if (message.parts.some(part => part.type === 'tool-call' && toolIds.has(part.toolCallId))) {
        matchingIntervals.add(userIndex)
      }
    }

    if (matchingIntervals.size !== 1) {
      // No occurrence identity: never discard the fetched prompt/history just
      // because local assistant-only rows have synthetic stream IDs. Tool IDs
      // can repeat across turns, so a match in several user intervals is not
      // proof of a shared occurrence either; retain both without overlaying.
      return [...durable, ...local]
    }

    durableStart = [...matchingIntervals][0]
  }

  const durableTail = durable.slice(durableStart + 1)
  const localTail = local.slice(localStart + 1)
  const nextUser = localTail.findIndex(message => message.role === 'user')
  const localRun = nextUser < 0 ? localTail : localTail.slice(0, nextUser)

  // Tool IDs are not unique across turns: take live tool state only from the
  // matched local interval and apply it only within the matched durable one.
  const localTools = new Map(
    localRun.flatMap(message =>
      message.parts.flatMap(part => (part.type === 'tool-call' ? [[part.toolCallId, part] as const] : []))
    )
  )

  const nextDurableUser = durableTail.findIndex(message => message.role === 'user')
  const durableRunEnd = nextDurableUser < 0 ? durableTail.length : nextDurableUser

  const enriched = durableTail.map((message, index) => ({
    ...message,
    parts: message.parts.map(part => {
      if (part.type !== 'tool-call' || index >= durableRunEnd) {
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

  const durableRun = enriched.slice(0, durableRunEnd)
  const durableLater = enriched.slice(durableRunEnd)
  // Coverage evidence must come from the matched durable run, not a later
  // turn whose tool IDs happen to repeat.
  let remaining = withoutCoveredAssistantPrefix(durableRun, localTail)

  if (remaining === localTail) {
    // A cold viewer can join halfway through the durable assistant run. Align
    // by tool identity, then require the same ordered-prefix proof; never use
    // equal prose elsewhere in the session to choose an offset.
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
  // The merge projects the local terminal (pending/interim/error) onto the
  // last row it receives, so give it only the matched durable run.
  if (localRun.every(message => message.parts.every(part => part.type === 'text'))) {
    return [
      ...durable.slice(0, durableStart + 1),
      ...mergeLiveAssistantRun(localRun, durableRun),
      ...durableLater,
      ...(nextUser < 0 ? [] : localTail.slice(nextUser))
    ]
  }

  // Divergent output without a proven ordered prefix is not safe to subtract.
  return [...durable, ...localTail]
}
