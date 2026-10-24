import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyProjectRefinementStep,
  projectRefinementState,
  readRefinementLog,
  refinementLogPath
} from '../src/main/services/refinementLog'

const HYBRID = `module SYSTEM_M;
process P (x: nat) y: nat
pre true
post y = x
end_process
end_module`

describe('refinement log persistence', () => {
  let root = ''

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = ''
    }
  })

  it('persists journal-only ClassifyGrain when Hybrid source is unchanged', () => {
    root = mkdtempSync(join(tmpdir(), 'refine-log-'))
    const result = applyProjectRefinementStep(root, HYBRID, {
      kind: 'ClassifyGrain',
      moduleName: 'M',
      processName: 'P',
      grainClass: 'operation'
    })
    expect(result.error).toBeUndefined()
    expect(result.source).toBe(HYBRID)
    expect(result.journalApplied).toBe(true)
    expect(readFileSync(refinementLogPath(root), 'utf-8')).toContain('ClassifyGrain')
    const state = projectRefinementState(root, HYBRID)
    expect(state.processes.find((p) => p.processName === 'P')?.grainClass).toBe('operation')
  })

  it('does not append the journal when DeclareAtomic is rejected', () => {
    root = mkdtempSync(join(tmpdir(), 'refine-log-'))
    const informal = HYBRID.replace('pre true', 'pre still informal')
    const result = applyProjectRefinementStep(root, informal, {
      kind: 'DeclareAtomic',
      moduleName: 'M',
      processName: 'P'
    })
    expect(result.error).toMatch(/not structurally atomic/)
    expect(result.journalApplied).toBeFalsy()
    expect(readRefinementLog(root)).toEqual([])
  })
})
