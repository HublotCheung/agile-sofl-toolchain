import { describe, expect, it } from 'vitest'
import { parse } from '@agile-sofl/parser'
import { applyHybridPatch } from '../src/hybridPatch.js'

const source = `module SYSTEM_Submission;
process CanSubmit (now: int) allowed: bool
FSF : others && allowed = false
end_process
process Submit (now: int) accepted: bool
FSF : others && accepted = false
end_process
end_module
module SYSTEM_Other;
process Submit (now: int) accepted: bool
FSF : others && accepted = false
end_process
end_module`

describe('qualified process FSF targets', () => {
  for (const moduleName of ['Submission', 'Other']) {
    it(`changes only ${moduleName}.Submit, preserving CanSubmit and the other module`, () => {
      const result = applyHybridPatch(source, { operations: [{
        op: 'replace-process-body', id: `proc:${moduleName}.Submit`,
        fsf: 'others && accepted = true'
      }] })
      expect(result.error).toBeUndefined()
      expect(parse(result.content).diagnostics.filter(d => d.severity === 'error')).toHaveLength(0)
      const start = source.indexOf(`module SYSTEM_${moduleName};`)
      const end = source.indexOf('end_module', start)
      expect(result.content.slice(0, start)).toBe(source.slice(0, start))
      const selected = result.content.slice(start, result.content.indexOf('end_module', start))
      expect(selected).toContain('accepted = true')
      expect(selected).not.toContain('accepted = false')
      expect(result.content).toContain('FSF : others && allowed = false')
      expect(result.content.slice(result.content.indexOf('end_module', start))).toBe(source.slice(end))
    })
  }
})
