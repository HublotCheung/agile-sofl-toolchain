import { describe, expect, it } from 'vitest'
import {
  composerAction,
  createQueuedMessage,
  enqueueMessage,
  removeQueuedMessage,
  sessionStillRunning,
  shiftQueuedMessage,
  shouldAutoFlushQueue,
  takeQueuedMessage,
  updateQueuedMessage
} from '../src/renderer/components/workspace/agent/agentQueue'

describe('agent message queue', () => {
  it('uses enqueue while busy with input, stop when busy and empty, send otherwise', () => {
    expect(composerAction(true, 'follow up')).toBe('enqueue')
    expect(composerAction(true, '  ')).toBe('stop')
    expect(composerAction(false, 'hello')).toBe('send')
  })

  it('drops blank enqueue and trims stored text', () => {
    expect(createQueuedMessage('   ')).toBeNull()
    expect(createQueuedMessage('  keep  ')?.text).toBe('keep')
    expect(enqueueMessage([], '  next  ')).toEqual([{ id: expect.any(String), text: 'next' }])
  })

  it('edits, deletes empty edits, and shifts in order', () => {
    const a = createQueuedMessage('one', 'a')!
    const b = createQueuedMessage('two', 'b')!
    const edited = updateQueuedMessage([a, b], 'a', '  one*  ')
    expect(edited).toEqual([
      { id: 'a', text: 'one*' },
      { id: 'b', text: 'two' }
    ])
    expect(updateQueuedMessage(edited, 'b', '   ')).toEqual([{ id: 'a', text: 'one*' }])
    expect(removeQueuedMessage(edited, 'a').map((i) => i.id)).toEqual(['b'])
    expect(shiftQueuedMessage(edited)).toEqual({
      next: { id: 'a', text: 'one*' },
      rest: [{ id: 'b', text: 'two' }]
    })
    expect(takeQueuedMessage(edited, 'b')).toEqual({
      item: { id: 'b', text: 'two' },
      rest: [{ id: 'a', text: 'one*' }]
    })
  })

  it('auto-sends only after the agent has fully stopped', () => {
    expect(shouldAutoFlushQueue({ busy: true, interrupted: false, stillRunning: false })).toBe(false)
    expect(shouldAutoFlushQueue({ busy: false, interrupted: false, stillRunning: true })).toBe(false)
    expect(shouldAutoFlushQueue({ busy: false, interrupted: true, stillRunning: false })).toBe(false)
    expect(shouldAutoFlushQueue({ busy: false, interrupted: false, stillRunning: false })).toBe(true)
  })

  it('treats a pending tool or live stream as the turn still running', () => {
    expect(sessionStillRunning({ context: { pendingToolCallId: 'call-1' }, messages: [] })).toBe(true)
    expect(sessionStillRunning({ context: {}, messages: [{ pending: true }] })).toBe(true)
    expect(sessionStillRunning({ context: {}, messages: [{ streaming: true }] })).toBe(true)
    expect(sessionStillRunning({ context: {}, messages: [{ pending: false, streaming: false }] })).toBe(false)
    expect(sessionStillRunning(null)).toBe(false)
  })
})
