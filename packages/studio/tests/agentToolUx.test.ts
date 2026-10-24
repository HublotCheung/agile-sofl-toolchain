import { describe, expect, it } from 'vitest'
import {
  activeToolCall,
  formatAgentToolError,
  formatToolArgsSize,
  isThinkingLive,
  parsePartialToolArgs,
  resolvedToolStatus,
  shouldShowThinkingPlaceholder,
  toolCallSubtitle,
  toolLabelKey,
  upsertToolCall
} from '../src/renderer/components/workspace/agent/agentToolUx'

describe('agent tool activity UX helpers', () => {
  it('maps known tools to i18n keys and falls back for unknown names', () => {
    expect(toolLabelKey('propose_hybrid_changes')).toBe('agent.tool.proposeHybrid')
    expect(toolLabelKey('read_refinement_state')).toBe('agent.tool.readRefine')
    expect(toolLabelKey('read_specification')).toBe('agent.tool.readInformal')
    expect(toolLabelKey('not_a_tool')).toBe('agent.tool.generic')
  })

  it('shortens lexer errors for patch cards', () => {
    const raw =
      "Typed FSF replacement rejected before writing: Expecting token of type --> DoubleAmp <-- but found --> 'in' <--"
    const friendly = formatAgentToolError(raw)
    expect(friendly).toContain('ASFL')
    expect(friendly).toContain('&&')
  })

  it('formats argument payload size', () => {
    expect(formatToolArgsSize('')).toBe('0 B')
    expect(formatToolArgsSize('hello')).toBe('5 B')
    expect(formatToolArgsSize('a'.repeat(2048))).toBe('2.0 KB')
    expect(formatToolArgsSize('你')).toBe('3 B')
  })

  it('extracts view and operation count from complete or partial JSON', () => {
    expect(parsePartialToolArgs('{"view":"inventory","operations":[{},{}]}')).toEqual({
      view: 'inventory',
      operationCount: 2
    })
    expect(
      parsePartialToolArgs('{"view":"source","operations":[{"op":"add","id":"mod:1"')
    ).toEqual({
      view: 'source',
      operationCount: 1
    })
    expect(toolCallSubtitle('{"view":"inventory","operations":[{},{},{}]}')).toBe('inventory · 3')
    expect(toolCallSubtitle('{')).toBeNull()
  })

  it('shows thinking placeholder only when streaming with no content or tools', () => {
    expect(isThinkingLive({ streaming: true })).toBe(true)
    expect(shouldShowThinkingPlaceholder({ streaming: true, content: '' })).toBe(true)
    expect(shouldShowThinkingPlaceholder({ streaming: true, content: '', thinking: 'hmm' })).toBe(false)
    expect(
      shouldShowThinkingPlaceholder({
        streaming: true,
        content: '',
        toolCalls: [{ id: '1', name: 'propose_changes', arguments: '{' }]
      })
    ).toBe(false)
    expect(isThinkingLive({ streaming: true, content: 'hello' })).toBe(false)
    expect(isThinkingLive({ streaming: false })).toBe(false)
  })

  it('upserts streaming tool calls and finds the active one', () => {
    const first = upsertToolCall(undefined, 0, {
      id: 'a',
      name: 'read_hybrid_specification',
      arguments: '{"view":',
      status: 'streaming'
    })
    const next = upsertToolCall(first, 0, {
      id: 'a',
      name: 'read_hybrid_specification',
      arguments: '{"view":"inventory"}',
      status: 'streaming'
    })
    expect(next[0].arguments).toBe('{"view":"inventory"}')
    const running = upsertToolCall(next, 1, {
      id: 'b',
      name: 'propose_hybrid_changes',
      arguments: '{}',
      status: 'running'
    })
    expect(activeToolCall(running, { messageStreaming: true, busy: true })?.id).toBe('b')
    expect(
      activeToolCall([
        { id: 'a', name: 'read_hybrid_specification', arguments: '{}', status: 'done' }
      ])
    ).toBeNull()
  })

  it('treats leftover running/streaming tools on finished messages as done', () => {
    const stuck = { id: 'a', name: 'read_hybrid_specification', arguments: '{}', status: 'running' as const }
    expect(resolvedToolStatus(stuck, { messageStreaming: false, busy: true })).toBe('done')
    expect(resolvedToolStatus(stuck, { messageStreaming: true, busy: false })).toBe('done')
    expect(resolvedToolStatus(stuck, { messageStreaming: true, busy: true })).toBe('running')
    expect(
      resolvedToolStatus(
        { ...stuck, status: 'error' },
        { messageStreaming: false, busy: false }
      )
    ).toBe('error')
    expect(activeToolCall([stuck], { messageStreaming: false, busy: true })).toBeNull()
  })
})
