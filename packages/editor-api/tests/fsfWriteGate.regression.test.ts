import { describe, expect, it } from 'vitest'
import { parseSpecification } from '@agile-sofl/parser'
import { applyHybridPatch } from '../src/hybridPatch.js'

const source = `module SYSTEM_A;
process Cancel (x: nat) y: nat
FSF : others && y = x
end_process
end_module`

describe('typed FSF write acceptance', () => {
  it('refuses an unknown qualified module without changing a same-named process', () => {
    const result = applyHybridPatch(source, { operations: [
      { op: 'replace-process-body', id: 'proc:Missing.Cancel', fsf: 'others && y = x + 1' }
    ] })
    expect(result.error).toMatch(/Unknown module/)
    expect(result.content).toBe(source)
  })

  it('keeps a parseable source when the replacement FSF has an invalid Boolean RHS', () => {
    expect(parseSpecification(source).diagnostics.filter(d => d.severity === 'error')).toEqual([])
    const result = applyHybridPatch(source, { operations: [
      { op: 'replace-process-body', id: 'proc:A.Cancel', fsf: 'others && y = not (x >= 1)' }
    ] })
    expect(result.error).toMatch(/rejected before writing/)
    expect(result.content).toBe(source)
  })

  it('accepts a matching process-name label as an FSF payload prefix', () => {
    const result = applyHybridPatch(source, { operations: [
      { op: 'replace-process-body', id: 'proc:A.Cancel', fsf: 'Cancel : others && y = x + 1' }
    ] })
    expect(result.error).toBeUndefined()
    expect(result.content).toContain('y = x + 1')
    expect(parseSpecification(result.content).diagnostics.filter(d => d.severity === 'error')).toEqual([])
  })

  it('reports a failed second replacement while retaining the first applied change', () => {
    const first = applyHybridPatch(source, { operations: [
      { op: 'replace-process-body', id: 'proc:A.Cancel', fsf: 'others && y = x + 1' }
    ] })
    const result = applyHybridPatch(source, { operations: [
      { op: 'replace-process-body', id: 'proc:A.Cancel', fsf: 'others && y = x + 1' },
      { op: 'replace-process-body', id: 'proc:A.Cancel', fsf: 'others && y = not (x >= 1)' }
    ] })
    expect(result.error).toBeTruthy()
    expect(result.content).toBe(first.content)
    expect(result.content).not.toBe(source)
    expect(parseSpecification(result.content).diagnostics.filter(d => d.severity === 'error')).toEqual([])
  })
})
