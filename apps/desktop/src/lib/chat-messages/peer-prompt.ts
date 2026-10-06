import { chatMessageText, textPart } from './parts'
import type { ChatMessage, MessageSender } from './types'

/** The typed prompt a shared-chat turn answers, echoed on its `message.start`. */
export interface PeerPromptEcho {
  text: string
  row_id?: null | number
  sender?: MessageSender | null
}

/**
 * Show the prompt another window sent before its reply streams in. The window
 * that sent it already has it: bound to the same durable row, or still an
 * optimistic bubble (no row id yet) with the same words.
 */
export function withPeerPrompt(
  messages: ChatMessage[],
  echo: null | PeerPromptEcho | undefined,
  nowMs = Date.now()
): ChatMessage[] {
  if (!echo?.text.trim()) {
    return messages
  }

  const { text } = echo
  const rowId = typeof echo.row_id === 'number' ? echo.row_id : undefined

  const shown = messages.some(
    message =>
      message.role === 'user' &&
      ((rowId !== undefined && message.rowId === rowId) ||
        (message.rowId === undefined && chatMessageText(message).trim() === text.trim()))
  )

  if (shown) {
    return messages
  }

  const prompt: ChatMessage = {
    id: `peer-prompt-${rowId ?? nowMs}`,
    role: 'user',
    parts: [textPart(text)],
    timestamp: nowMs / 1000,
    ...(rowId !== undefined ? { rowId } : {}),
    ...(echo.sender ? { sender: echo.sender } : {})
  }

  return [...messages, prompt]
}
