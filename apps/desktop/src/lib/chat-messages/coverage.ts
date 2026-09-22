import { normalizeWs as normalizedText } from './parts'
import type { ChatMessage, ChatMessagePart } from './types'

function sameOccurrencePart(stored: ChatMessagePart, local: ChatMessagePart): boolean {
  if (stored.type === 'tool-call' && local.type === 'tool-call') {
    return Boolean(stored.toolCallId) && stored.toolCallId === local.toolCallId
  }

  if ((stored.type === 'text' || stored.type === 'reasoning') && local.type === stored.type) {
    return normalizedText(stored.text) === normalizedText(local.text)
  }

  return false
}

/** Subtract an ordered, tool-anchored prefix within an already matched user
 * interval. Hydration can fold several live bubbles into one durable row;
 * bubble ordinals and equal text alone cannot establish that coverage. */
export function withoutCoveredAssistantPrefix(stored: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const parts = stored.flatMap(message => (message.role === 'assistant' ? message.parts : []))
  let cursor = 0
  let anchored = false
  let stopped = false
  const remaining: ChatMessage[] = []

  for (const message of local) {
    if (stopped || message.role !== 'assistant' || message.error) {
      stopped = true
      remaining.push(message)

      continue
    }

    let consumed = 0

    for (const part of message.parts) {
      if (!parts[cursor] || !sameOccurrencePart(parts[cursor], part)) {
        break
      }

      anchored ||= part.type === 'tool-call'
      cursor += 1
      consumed += 1
    }

    if (consumed < message.parts.length) {
      stopped = true
      remaining.push(consumed ? { ...message, parts: message.parts.slice(consumed) } : message)
    }
  }

  // A coincidentally equal paragraph, without the same tool occurrence after
  // it, is insufficient evidence to remove anything.
  return anchored ? remaining : local
}

/** Envelope fields that can be a tool's only failure or edit evidence. Hydrated
 * tool parts never carry display hints such as `summary`/`duration_s`, so
 * requiring those would make every live completion permanently "uncovered". */
const COVERED_TOOL_METADATA = ['error', 'message', 'inline_diff'] as const

/** A sealed live bubble can start at a tool inside a folded durable bubble.
 * Match that call occurrence, not the bubble's role ordinal or prose alone.
 * Missing durable result metadata is not coverage of a richer local tool. */
export function durableToolRowCoversLiveMessage(stored: ChatMessage[], local: ChatMessage): boolean {
  if (local.pending || local.error) {
    return false
  }

  const firstTool = local.parts.findIndex(part => part.type === 'tool-call')
  const anchor = local.parts[firstTool]

  if (anchor?.type !== 'tool-call') {
    return false
  }

  return stored.some(message => {
    const toolIndex = message.parts.findIndex(
      part => part.type === 'tool-call' && part.toolCallId === anchor.toolCallId
    )

    const offset = toolIndex - firstTool

    if (message.role !== 'assistant' || offset < 0 || toolIndex < 0) {
      return false
    }

    const parts = message.parts.slice(offset)

    return (
      withoutCoveredAssistantPrefix([{ ...message, parts }], [local]).length === 0 &&
      local.parts.every((part, index) => {
        const durable = parts[index]

        return (
          part.type !== 'tool-call' ||
          (durable?.type === 'tool-call' &&
            (part.result === undefined || JSON.stringify(part.result) === JSON.stringify(durable.result)) &&
            (!part.isError || durable.isError === true) &&
            COVERED_TOOL_METADATA.every(
              key =>
                part.toolResultMetadata?.[key] === undefined ||
                JSON.stringify(part.toolResultMetadata[key]) === JSON.stringify(durable.toolResultMetadata?.[key])
            ))
        )
      })
    )
  })
}
