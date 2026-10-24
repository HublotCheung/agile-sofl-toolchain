import { describe, expect, it } from 'vitest'
import {
  adjustRefinementDiagnosticSeverity,
  hasBlockingHybridDiagnostics
} from '../src/refinementLint.js'

describe('refinementLint', () => {
  it('downgrades parse and refinement errors to warnings by default', () => {
    const diags = [
      { code: 'ASFL_PARSE_001', severity: 'error', message: 'x' },
      { code: 'ASFL_CDFD_002', severity: 'error', message: 'y' }
    ]
    const adjusted = adjustRefinementDiagnosticSeverity(diags, false)
    expect(adjusted.every((d) => d.severity === 'warning')).toBe(true)
    expect(hasBlockingHybridDiagnostics(adjusted, false)).toBe(false)
  })

  it('keeps errors when hybrid FSF strict mode is on', () => {
    const diags = [{ code: 'ASFL_PARSE_001', severity: 'error', message: 'x' }]
    expect(adjustRefinementDiagnosticSeverity(diags, true)[0]?.severity).toBe('error')
  })
})
