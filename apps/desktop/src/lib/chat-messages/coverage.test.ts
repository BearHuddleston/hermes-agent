import { expect, it } from 'vitest'

import { durableToolRowCoversLiveMessage } from './coverage'
import type { ChatMessage, ChatMessagePart } from './types'

const text = (value: string): ChatMessagePart => ({ type: 'text', text: value })

const tool: ChatMessagePart = {
  type: 'tool-call',
  toolCallId: 'edit-once',
  toolName: 'write_file',
  args: {},
  argsText: '{}',
  result: { success: true },
  toolResultMetadata: { inline_diff: '+changed' }
}

const live: ChatMessage = {
  id: 'assistant-stream-tools',
  role: 'assistant',
  pending: false,
  parts: [tool, text('Finished.')]
}

const stored: ChatMessage = {
  id: 'durable-row',
  role: 'assistant',
  parts: [text('Earlier progress.'), tool, text('Finished.')]
}

it('recognizes a sealed tool occurrence folded into a larger durable bubble', () => {
  expect(durableToolRowCoversLiveMessage([stored], live)).toBe(true)
  expect(
    durableToolRowCoversLiveMessage([stored], { ...live, parts: [{ ...tool, result: undefined }, text('Finished.')] })
  ).toBe(true)
})

it('does not claim coverage of another call, unseen content, live work or richer tool data', () => {
  const uncovered: ChatMessage[] = [
    { ...live, pending: true },
    { ...live, error: 'retained failure' },
    { ...live, parts: [{ ...tool, toolCallId: 'different-turn' }, text('Finished.')] },
    { ...live, parts: [tool, text('Finished. More work.')] },
    { ...live, parts: [tool, { type: 'reasoning', text: 'Not stored' }, text('Finished.')] },
    { ...live, parts: [{ ...tool, result: { success: false } }, text('Finished.')] },
    { ...live, parts: [{ ...tool, toolResultMetadata: { inline_diff: '+newer' } }, text('Finished.')] }
  ]

  for (const row of uncovered) {
    expect(durableToolRowCoversLiveMessage([stored], row)).toBe(false)
  }
})
