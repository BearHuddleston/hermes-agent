import { expect, it } from 'vitest'

import { type ChatMessage, type ChatMessagePart, chatMessageText } from '@/lib/chat-messages'

import { reconcileSettledTranscript } from './settled-transcript'
import { preserveEquivalentTranscript } from './utils'

const text = (value: string): ChatMessagePart => ({ type: 'text', text: value })

const tool: ChatMessagePart = {
  type: 'tool-call',
  toolName: 'write_file',
  toolCallId: 'edit',
  args: {},
  argsText: '{}'
}

const user: ChatMessage = { id: 'stored-user', rowId: 1, role: 'user', parts: [text('Do the edit')] }
const row = (id: string, parts: ChatMessagePart[]): ChatMessage => ({ id, role: 'assistant', parts, pending: false })
const completed = { ...tool, result: { success: true }, toolResultMetadata: { inline_diff: '+new' } }

it('recovers a result and final while retaining an unseen local suffix and the next accepted prompt', () => {
  const durable = [user, row('stored', [text('Checking.'), completed])]
  const nextUser: ChatMessage = { ...user, id: 'next-user', rowId: undefined }

  const local = [
    user,
    row('live-tools', [text('Checking.'), tool]),
    row('live-final', [text('Done.')]),
    nextUser,
    row('next-live', [text('New progress.')])
  ]

  let result = reconcileSettledTranscript(durable, local)

  for (let attempt = 0; attempt < 3; attempt++) {
    expect(result.map(chatMessageText)).toEqual(['Do the edit', 'Checking.', 'Done.', 'Do the edit', 'New progress.'])
    expect(result.flatMap(message => message.parts).filter(part => part.type === 'tool-call')).toEqual([completed])
    result = reconcileSettledTranscript(durable, result)
  }
})

it('does not lose fetched history when a cold stream has no occurrence anchor', () => {
  const durable = [user, row('old', [text('Earlier answer')])]
  const local = [row('unanchored', [text('Different answer')])]
  expect(reconcileSettledTranscript(durable, local)).toEqual([...durable, ...local])
})

it('recovers an unseen durable prefix when the viewer joined at a tool', () => {
  const durable = [user, row('stored', [text('Earlier commentary'), completed, text('Done.')])]
  const local = [row('live-tools', [tool]), row('live-final', [text('Done.')])]
  const result = reconcileSettledTranscript(durable, local)
  expect(result.flatMap(message => message.parts).filter(part => part.type === 'tool-call')).toEqual([completed])
  expect(
    result
      .map(chatMessageText)
      .join('\n')
      .match(/Done\./g)
  ).toHaveLength(1)
  expect(result[0]).toBe(user)
})

it('keeps newer live tool metadata when the history read is behind', () => {
  const durable = [user, row('stored', [tool])]
  const local = [user, row('live', [completed, text('Done.')])]
  const result = reconcileSettledTranscript(durable, local)
  expect(result.flatMap(message => message.parts).filter(part => part.type === 'tool-call')).toEqual([completed])
  expect(result.map(chatMessageText).join('\n')).toContain('Done.')
})

it('publishes newly recovered preview metadata even when the result already exists', () => {
  const previous = [user, row('stored', [{ ...tool, result: { success: true } }])]
  const next = reconcileSettledTranscript([user, row('stored', [completed])], previous)
  const published = preserveEquivalentTranscript(previous, next)
  expect(published[1].parts[0]).toMatchObject({ toolResultMetadata: { inline_diff: '+new' } })
})

it.each(['local', 'durable'] as const)('keeps reused tool IDs within their %s user interval', ahead => {
  const first = { ...completed, result: { value: 'first' } }
  const second = { ...completed, result: { value: 'second' } }
  const nextUser: ChatMessage = { ...user, id: 'later-user', rowId: 2 }
  const prefix = [user, row('stored-first', [first])]
  const suffix = [nextUser, row('later-answer', [second])]
  const durable = ahead === 'durable' ? [...prefix, ...suffix] : prefix
  const local = ahead === 'local' ? [...prefix, ...suffix] : prefix
  const result = reconcileSettledTranscript(durable, local)

  expect(
    result.flatMap(message => message.parts).flatMap(part => (part.type === 'tool-call' ? [part.result] : []))
  ).toEqual([{ value: 'first' }, { value: 'second' }])
})

it('does not overlay an ambiguous cold tool ID onto an earlier user interval', () => {
  const first = { ...completed, result: { value: 'first' } }
  const second = { ...completed, result: { value: 'second' } }
  const nextUser: ChatMessage = { ...user, id: 'later-user', rowId: 2 }
  const durable = [user, row('stored-first', [first]), nextUser, row('stored-second', [second])]
  const local = [row('cold-live', [second])]

  expect(reconcileSettledTranscript(durable, local)).toEqual([...durable, ...local])
})

it('keeps a retained text-only failure on its own user interval', () => {
  const nextUser: ChatMessage = { ...user, id: 'later-user', rowId: 2 }
  const laterAnswer = row('later-success', [text('Successful later answer.')])
  const durable = [user, row('stored-partial', [text('Partial answer.')]), nextUser, laterAnswer]
  const failure = { ...row('assistant-stream-error', [text('Partial answer.')]), error: 'provider failed' }
  const result = reconcileSettledTranscript(durable, [user, failure])

  expect(result[1].error).toBe('provider failed')
  expect(result.find(message => message.id === laterAnswer.id)).toEqual(laterAnswer)
})
