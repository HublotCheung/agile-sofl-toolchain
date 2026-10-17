import { describe, expect, it } from 'vitest'
import { isLengthFinishReason, parseToolArguments } from '../src/main/services/llm/parseToolArgs'

describe('parseToolArguments', () => {
  it('keeps a complete JSON value when trailing junk follows it', () => {
    const raw = '{"explanation":"login","operations":[{"op":"replace-screen-html","screenId":"view-home","html":"<p>Hi</p>"}]}'
    const parsed = parseToolArguments(`${raw}}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.repaired).toBe(true)
    expect(parsed.droppedPartialOperation).toBe(false)
    expect(parsed.value.operations).toEqual([
      { op: 'replace-screen-html', screenId: 'view-home', html: '<p>Hi</p>' }
    ])
  })

  it('drops only the cut-off operation when a multi-screen payload is truncated', () => {
    const raw =
      '{"explanation":"screens","operations":[{"op":"add-screen","id":"view-home","html":"<section data-screen=\\"Home\\"></section>"},{"op":"add-screen","id":"view-book","html":"<section data-screen=\\"Book\\"><h2>Cash'
    const parsed = parseToolArguments(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.repaired).toBe(true)
    expect(parsed.droppedPartialOperation).toBe(true)
    const ops = parsed.value.operations as Array<{ id: string }>
    expect(ops).toHaveLength(1)
    expect(ops[0]?.id).toBe('view-home')
  })

  it('refuses a truncated whole-document replace', () => {
    const parsed = parseToolArguments('{"operations":[{"op":"replace-html","html":"<div class=\\"as-app\\">')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/truncated/)
  })

  it('does not turn a parse failure into an empty operations object', () => {
    const parsed = parseToolArguments('not json at all')
    expect(parsed.ok).toBe(false)
  })

  it('hard-fails on finishReason=length instead of silently repairing truncated JSON', () => {
    const raw =
      '{"explanation":"screens","operations":[{"op":"add-screen","id":"view-home","html":"<section data-screen=\\"Home\\"></section>"},{"op":"add-screen","id":"view-book","html":"<section data-screen=\\"Book\\"><h2>Cash'
    const parsed = parseToolArguments(raw, { finishReason: 'length' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/finish_reason=length/)
    expect(parsed.error).toMatch(/Do not treat partial tool JSON as success/)
  })

  it('hard-fails on finishReason=max_tokens alias', () => {
    const raw = '{"operations":[{"op":"add-screen","id":"a","html":"<p>ok</p>"}]}'
    const parsed = parseToolArguments(raw, { finishReason: 'max_tokens' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/truncated/)
  })

  it('still repairs truncation when finishReason is stop (legacy path)', () => {
    const raw =
      '{"explanation":"screens","operations":[{"op":"add-screen","id":"view-home","html":"<section data-screen=\\"Home\\"></section>"},{"op":"add-screen","id":"view-book","html":"<section data-screen=\\"Book\\"><h2>Cash'
    const parsed = parseToolArguments(raw, { finishReason: 'stop' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.repaired).toBe(true)
  })
})

describe('isLengthFinishReason', () => {
  it('detects length and max_tokens', () => {
    expect(isLengthFinishReason('length')).toBe(true)
    expect(isLengthFinishReason('max_tokens')).toBe(true)
    expect(isLengthFinishReason('LENGTH')).toBe(true)
    expect(isLengthFinishReason('stop')).toBe(false)
    expect(isLengthFinishReason(undefined)).toBe(false)
  })
})
