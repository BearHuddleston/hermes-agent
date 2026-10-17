import { describe, expect, it } from 'vitest'

import { chatMessageText, textPart } from './parts'
import { withPeerPrompt } from './peer-prompt'
import type { ChatMessage } from './types'

const bob = { color: '#2563eb', id: 'nous:usr_bob', name: 'Bob' }

const user = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `u-${text}`,
  parts: [textPart(text)],
  role: 'user',
  ...extra
})

const reply: ChatMessage = { id: 'a-1', parts: [textPart('earlier answer')], role: 'assistant' }

describe('withPeerPrompt', () => {
  it("places another window's prompt after the transcript, carrying its sender, before the reply streams", () => {
    const next = withPeerPrompt([reply], { row_id: 42, sender: bob, text: 'what changed?' })

    expect(next.map(message => message.role)).toEqual(['assistant', 'user'])
    expect(chatMessageText(next[1])).toBe('what changed?')
    expect(next[1]).toMatchObject({ rowId: 42, sender: bob })
  })

  it('leaves a prompt this window already shows alone (bound row or optimistic bubble)', () => {
    const bound = [user('what changed?', { rowId: 42 })]
    const optimistic = [user('what changed?')]

    expect(withPeerPrompt(bound, { row_id: 42, text: 'what changed?' })).toBe(bound)
    expect(withPeerPrompt(optimistic, { row_id: 42, text: 'what changed?' })).toBe(optimistic)
  })

  it('still shows the same words when an earlier, different turn already said them', () => {
    const earlier = [user('ship it', { rowId: 7 }), reply]

    expect(withPeerPrompt(earlier, { row_id: 9, text: 'ship it' })).toHaveLength(3)
  })
})
