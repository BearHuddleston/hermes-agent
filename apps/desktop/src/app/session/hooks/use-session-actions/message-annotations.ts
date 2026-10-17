import type { ChatMessage } from '@/lib/chat-messages'

/**
 * What a row paints beside its text: reactions and, in a shared chat, the
 * sender label above a peer's message. Both arrive as fresh objects on every
 * hydration, so they compare by value, or every resume would repaint them.
 */
export function chatAnnotationsEquivalent(a: ChatMessage, b: ChatMessage): boolean {
  return chatReactionsEquivalent(a.reactions, b.reactions) && chatSendersEquivalent(a.sender, b.sender)
}

function chatReactionsEquivalent(a: ChatMessage['reactions'], b: ChatMessage['reactions']): boolean {
  const aList = a ?? []
  const bList = b ?? []

  if (aList === bList) {
    return true
  }

  return (
    aList.length === bList.length &&
    aList.every((reaction, index) => reaction.emoji === bList[index].emoji && reaction.author === bList[index].author)
  )
}

function chatSendersEquivalent(a: ChatMessage['sender'], b: ChatMessage['sender']): boolean {
  return a?.id === b?.id && a?.name === b?.name && a?.color === b?.color
}
