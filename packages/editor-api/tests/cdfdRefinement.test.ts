import { describe, expect, it } from 'vitest'
import { parse } from '@agile-sofl/parser'
import { buildCdfdGraph } from '../src/cdfdGraph.js'
import { layoutCdfdGraph as layout } from '../src/cdfdLayout.js'
import { applyRefinementStep, decomposeProcess, buildRefinementState, formatRefinementDigest } from '../src/refinement.js'
import { buildModuleGraph } from '../src/moduleGraph.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../parser/tests/fixtures/grammar/modules/cdfd-banking-decom.asfl'),
  'utf-8'
)

describe('CDFD graph and refinement', () => {
  it('builds a graph with stores, conditions, and guarded flows', () => {
    const { ast } = parse(fixture)
    expect(ast?.type).toBe('program')
    if (ast?.type !== 'program') return
    const child = ast.modules.find((m) => m.name === 'Banking_Decom')!
    const graph = buildCdfdGraph(child)
    expect(graph.nodes.some((n) => n.kind === 'store')).toBe(true)
    expect(graph.nodes.some((n) => n.kind === 'cond')).toBe(true)
    expect(graph.edges.some((e) => e.isOthers)).toBe(true)
    const laid = layout(graph)
    expect(laid.nodes.length).toBe(graph.nodes.length)
    expect(laid.bbox.maxX).toBeGreaterThan(laid.bbox.minX)
  })

  it('FormalizePredicate logs and DecomposeProcess creates a child cdfd', () => {
    const source = `module SYSTEM_P;
process P (x: nat) y: nat
pre x is valid
post y is produced
end_process
end_module`
    const formalized = applyRefinementStep(source, [], {
      kind: 'FormalizePredicate',
      fromText: 'x is valid',
      toText: 'x > 0'
    })
    expect(formalized.error).toBeUndefined()
    expect(formalized.source).toContain('x > 0')
    expect(formalized.log[0]?.kind).toBe('FormalizePredicate')
    const next = decomposeProcess(formalized.source, 'P', 'P', 'P_Decom')
    expect(next).toContain('module P_Decom')
    expect(next).toContain('cdfd')
    expect(next).toContain('decom: P_Decom')
  })

  it('FormalizePredicate matches informal text when only whitespace differs', () => {
    const source = `module SYSTEM_P;
process P (x: nat) y: nat
pre account_of ( user_id )
post y is produced
end_process
end_module`
    const formalized = applyRefinementStep(source, [], {
      kind: 'FormalizePredicate',
      fromText: 'account_of(user_id)',
      toText: 'user_id > 0',
      clause: 'pre'
    })
    expect(formalized.error).toBeUndefined()
    expect(formalized.source).toContain('user_id > 0')
    expect(formalized.source).not.toContain('account_of')
  })

  it('counts unlogged informal removals', () => {
    const before = `module SYSTEM_P;
process P ()
pre informal atom here
post true
end_process
end_module`
    const logged = applyRefinementStep(before, [], {
      kind: 'Extend',
      moduleName: 'P',
      processName: 'Extra'
    })
    const sneaky = before.replace('informal atom here', 'true')
    const state = buildRefinementState(sneaky, logged.log)
    expect(state.unloggedFormalizations).toBeGreaterThan(0)
    expect(state.diagnostics.some((d) => d.code === 'ASFL_REFINE_001')).toBe(true)
  })

  it('resolves decom edges to child modules', () => {
    const { ast } = parse(fixture)
    expect(ast?.type).toBe('program')
    if (ast?.type !== 'program') return
    const graph = buildModuleGraph(ast)
    expect(graph.edges.some((e) => e.kind === 'decom' && e.to === 'Banking_Decom' && e.resolved)).toBe(true)
  })

  it('DeclareAtomic fails until structural conditions hold', () => {
    const source = `module SYSTEM_P;
process P (x: nat) y: nat
pre x is still informal
post y = x
end_process
end_module`
    const result = applyRefinementStep(source, [], { kind: 'DeclareAtomic', moduleName: 'P', processName: 'P' })
    expect(result.error).toMatch(/not structurally atomic/)
  })

  it('SetCdfd writes a module cdfd block', () => {
    const source = `module SYSTEM_P;
process P (x: nat) y: nat
pre true
post y = x
end_process
end_module`
    const next = applyRefinementStep(source, [], {
      kind: 'SetCdfd',
      moduleName: 'P',
      toText: `cdfd
  port in x
  port out y
  node P
  flow x -> P
  flow P -> y
end_cdfd`
    })
    expect(next.error).toBeUndefined()
    expect(next.source).toContain('port in x')
    expect(next.source).toContain('node P')
  })

  it('exposes atomicity gates, data items, and audit log on the refinement state', () => {
    const state = buildRefinementState(fixture, [])
    expect(state.modules.map((m) => m.name)).toEqual(['Banking', 'Banking_Decom'])
    const parent = state.processes.find((p) => p.processName === 'A')
    expect(parent?.hasDecom).toBe(true)
    expect(parent?.decomTarget).toBe('Banking_Decom')
    expect(parent?.status).toBe('open')
    expect(parent?.declaredAtomic).toBe(false)
    expect(state.breakdown.informalAtomCount).toBeGreaterThanOrEqual(0)
    expect(state.dataItems.some((d) => d.kind === 'obligation' && d.typeName === 'Account')).toBe(true)
    expect(state.dataItems.every((d) => d.discharged === false)).toBe(true)
    expect(state.log).toEqual([])
    const discharged = applyRefinementStep(fixture, [], {
      kind: 'DischargeDataObligation',
      moduleName: 'Banking_Decom',
      typeName: 'Account'
    })
    expect(discharged.state.dataItems.find((d) => d.typeName === 'Account' && d.kind === 'obligation')?.discharged).toBe(
      true
    )
    expect(discharged.state.log.some((e) => e.kind === 'DischargeDataObligation')).toBe(true)
  })

  it('marks name-only modules as empty shells in refinement state', () => {
    const source = `module SYSTEM_Empty;
end_module
module ScoreEntry / Empty;
end_module`
    const state = buildRefinementState(source, [])
    const score = state.modules.find((m) => m.name === 'ScoreEntry')
    const system = state.modules.find((m) => m.name === 'Empty')
    expect(score?.isEmpty).toBe(true)
    expect(system?.isEmpty).toBe(false)
    expect(state.breakdown.emptyModuleCount).toBe(1)
    expect(state.processAmbiguity).toBeGreaterThanOrEqual(1)
    const digest = formatRefinementDigest(state, 'tree')
    expect(digest).toMatch(/EMPTY-SHELL|ScoreEntry/)
    expect(formatRefinementDigest(state, 'summary')).toMatch(/unambiguous=false/)
  })

  it('keeps a formally shaped maintain-student process from being operationally atomic', () => {
    const source = `module SYSTEM_S;
process 维护学生 (student_id: nat, name: string) ok: nat
pre true
post students = union(students, {student_id})
comment: 包括登记、修改、退学
end_process
end_module`
    const state = buildRefinementState(source, [])
    const row = state.processes.find((p) => p.processName === '维护学生')
    expect(row?.effectPattern).toBe('insert')
    expect(row?.nameEffectMismatch).toBe(true)
    expect(row?.variations.map((v) => v.text)).toEqual(['登记', '修改', '退学'])
    expect(row?.grainClosed).toBe(false)
    expect(state.grainAmbiguity).toBeGreaterThan(0)
    const denied = applyRefinementStep(source, [], { kind: 'DeclareAtomic', moduleName: 'S', processName: '维护学生' })
    expect(denied.error).toMatch(/not (structurally|operationally) atomic/)

    const classified = applyRefinementStep(source, [], {
      kind: 'ClassifyGrain',
      moduleName: 'S',
      processName: '维护学生',
      grainClass: 'operation'
    })
    expect(classified.error).toBeUndefined()
    const stillOpen = classified.state.processes.find((p) => p.processName === '维护学生')
    expect(stillOpen?.grainClass).toBe('operation')
    expect(stillOpen?.grainClosed).toBe(false)

    const renamed = source.replaceAll('维护学生', '登记学生')
    const sneaky = buildRefinementState(renamed, classified.log)
    expect(sneaky.unloggedGrainClosures).toBeGreaterThan(0)
    expect(sneaky.grainAmbiguity).toBeGreaterThan(0)
    expect(sneaky.diagnostics.some((d) => d.code === 'ASFL_REFINE_002')).toBe(true)
  })
})
