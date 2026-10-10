/**
 * Auditable Hybrid refinement steps. Spec text is state; the journal is the audit trail.
 */

import {
  analyzeProcessAtomicity,
  analyzeProcessGrain,
  canDeclareAtomic,
  checkDataRefine,
  parse,
  printRefineBlock,
  type AuthorTextNote,
  type CdfdBlockNode,
  type EffectPattern,
  type GrainVariation,
  type InformalAtomRef,
  type ProcessAtomicity,
  type ProgramNode,
  type RefineBlockNode
} from '@agile-sofl/parser'
import {
  closeProcessGrain,
  grainStepTarget,
  stickyGrainIds,
  unloggedGrainClosures,
  type GrainClass
} from './grainClosure.js'
import { addModule } from './modulePatch.js'
import { addProcess, addFunction } from './processPatch.js'
import { patchCdfdBlock } from './cdfdPatch.js'
import { patchDecom } from './patch.js'
import { patchType } from './declarationPatch.js'

export type RefinementStepKind =
  | 'FormalizePredicate'
  | 'DecomposeProcess'
  | 'BalanceFlows'
  | 'DefineType'
  | 'BindConstraint'
  | 'DeclareAtomic'
  | 'Extend'
  | 'IntroduceRetrieve'
  | 'DischargeDataObligation'
  | 'SetCdfd'
  | 'ClassifyGrain'
  | 'ResolveVariation'

export interface RefinementStep {
  kind: RefinementStepKind
  moduleName?: string
  processName?: string
  typeName?: string
  clause?: 'pre' | 'post' | 'fsf'
  fromText?: string
  toText?: string
  childModuleName?: string
  representationType?: string
  retrieveFunction?: string
  retrieveBody?: string
  note?: string
  ports?: { direction: 'in' | 'out'; name: string }[]
  /** ClassifyGrain: operation (one trigger) or abstract (still a concern). */
  grainClass?: 'operation' | 'abstract'
  /** ResolveVariation: id from the grain report, or name-claim for a broad name. */
  variationId?: string
  disposition?: 'scenario' | 'child' | 'waived'
}

export interface RefinementLogEntry {
  id: string
  at: string
  kind: RefinementStepKind
  target: string
  beforeHash: string
  afterHash: string
  processAmbiguityBefore: number
  processAmbiguityAfter: number
  dataAmbiguityBefore: number
  dataAmbiguityAfter: number
  informalKeysBefore: string[]
  informalKeysAfter: string[]
  grainAmbiguityBefore?: number
  grainAmbiguityAfter?: number
  /** Sticky grain obligation ids. Disappearing without ClassifyGrain, ResolveVariation, or DecomposeProcess does not reduce grainAmbiguity. */
  grainKeysBefore?: string[]
  grainKeysAfter?: string[]
  discharged?: boolean
  note?: string
}

export type AtomicityStatus = 'atomic' | 'ready' | 'open'

export interface RefinementProcessRow extends ProcessAtomicity {
  informalAtoms: InformalAtomRef[]
  declaredAtomic: boolean
  status: AtomicityStatus
  effectPattern: EffectPattern
  grainClass: GrainClass
  nameEffectMismatch: boolean
  variations: GrainVariation[]
  grainClosed: boolean
  operationallyAtomic: boolean
}

export interface RefinementModuleRow {
  name: string
  isSystem: boolean
  parentName?: string
  isEmpty: boolean
}

export interface ProcessAmbiguityBreakdown {
  informalAtomCount: number
  incompleteScenarioCount: number
  openConditionCount: number
  unbalancedBoundaryCount: number
  undeclaredAtomicCount: number
  emptyModuleCount: number
  stubProcessCount: number
}

export type DataItemKind = 'given' | 'retrieve' | 'obligation'

export interface DataRefinementItemView {
  kind: DataItemKind
  typeName: string
  retrieveFunction?: string
  message: string
  discharged: boolean
  target: string
}

export interface RefinementState {
  processAmbiguity: number
  dataAmbiguity: number
  /** Open operational-grain obligations. High values are expected on abstract nodes; zero is required before a detailed design is complete. */
  grainAmbiguity: number
  informalAtoms: InformalAtomRef[]
  unloggedFormalizations: number
  unloggedGrainClosures: number
  diagnostics: Array<{ code: string; message: string; severity: string }>
  processes: RefinementProcessRow[]
  modules: RefinementModuleRow[]
  breakdown: ProcessAmbiguityBreakdown
  dataItems: DataRefinementItemView[]
  log: RefinementLogEntry[]
}

function contentHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

function targetKey(step: RefinementStep): string {
  return (
    grainStepTarget(step) ??
    [step.kind, step.moduleName, step.processName, step.typeName, step.clause, step.fromText]
      .filter(Boolean)
      .join('::')
  )
}

export function parseRefinementLog(text: string): RefinementLogEntry[] {
  if (!text.trim()) return []
  const entries: RefinementLogEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as RefinementLogEntry)
    } catch {
      /* skip */
    }
  }
  return entries
}

export function serializeRefinementLog(entries: RefinementLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
}

function emptyBreakdown(): ProcessAmbiguityBreakdown {
  return {
    informalAtomCount: 0,
    incompleteScenarioCount: 0,
    openConditionCount: 0,
    unbalancedBoundaryCount: 0,
    undeclaredAtomicCount: 0,
    emptyModuleCount: 0,
    stubProcessCount: 0
  }
}

function moduleIsEmptyShell(mod: ProgramNode['modules'][number], program: ProgramNode): boolean {
  const members =
    mod.consts.length +
    mod.types.length +
    mod.vars.length +
    mod.invariants.length +
    mod.processes.length +
    mod.functions.length
  if (members > 0 || mod.gui || mod.cdfd || mod.refine) return false
  return !program.modules.some((other) => {
    const parent = other.parent?.name
    return parent === mod.name || parent === `SYSTEM_${mod.name}`
  })
}

function counts(source: string, notes: AuthorTextNote[] = []) {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') {
    return {
      ast: null as ProgramNode | null,
      processAmbiguity: 0,
      dataAmbiguity: 0,
      informalAtoms: [] as InformalAtomRef[],
      processes: [] as ProcessAtomicity[],
      modules: [] as RefinementModuleRow[],
      breakdown: emptyBreakdown(),
      dataItems: [] as DataRefinementItemView[],
      grain: { processes: [] } satisfies ReturnType<typeof analyzeProcessGrain>
    }
  }
  const proc = analyzeProcessAtomicity(ast)
  const data = checkDataRefine(ast)
  const grain = analyzeProcessGrain(ast, notes)
  return {
    ast,
    processAmbiguity: proc.processAmbiguity,
    dataAmbiguity: data.dataAmbiguity,
    informalAtoms: proc.informalAtoms,
    processes: proc.processes,
    grain,
    modules: ast.modules
      .filter((mod) => mod.name.trim().length > 0)
      .map((mod) => ({
        name: mod.name,
        isSystem: mod.isSystem,
        parentName: mod.parent?.name,
        isEmpty: moduleIsEmptyShell(mod, ast)
      })),
    breakdown: {
      informalAtomCount: proc.informalAtomCount,
      incompleteScenarioCount: proc.incompleteScenarioCount,
      openConditionCount: proc.openConditionCount,
      unbalancedBoundaryCount: proc.unbalancedBoundaryCount,
      undeclaredAtomicCount: proc.undeclaredAtomicCount,
      emptyModuleCount: proc.emptyModuleCount,
      stubProcessCount: proc.stubProcessCount
    },
    dataItems: data.items.map((item) => ({
      kind: item.kind,
      typeName: item.typeName,
      retrieveFunction: item.retrieveFunction,
      message: item.message,
      discharged: false,
      target: [item.kind, item.typeName, item.retrieveFunction].filter(Boolean).join('::')
    }))
  }
}

function unloggedFormalizations(current: InformalAtomRef[], log: RefinementLogEntry[]): number {
  const last = [...log].reverse().find((e) => e.informalKeysBefore)
  if (!last) return 0
  const currentKeys = new Set(current.map((a) => a.key))
  const formalized = new Set(
    log.filter((e) => e.kind === 'FormalizePredicate').flatMap((e) => e.informalKeysBefore.filter((k) => !e.informalKeysAfter.includes(k)))
  )
  let extra = 0
  for (const key of last.informalKeysAfter.length ? last.informalKeysAfter : last.informalKeysBefore) {
    if (!currentKeys.has(key) && !formalized.has(key)) extra += 1
  }
  return extra
}

function processIsDeclared(p: ProcessAtomicity, log: RefinementLogEntry[]): boolean {
  return log.some((e) => {
    if (e.kind !== 'DeclareAtomic') return false
    const parts = e.target.split('::')
    const hasModule = parts.includes(p.moduleName)
    const hasProcess = parts.includes(p.processName)
    return hasProcess && (parts.length < 3 || hasModule)
  })
}

function dataItemDischarged(item: DataRefinementItemView, log: RefinementLogEntry[]): boolean {
  if (item.kind !== 'obligation') return false
  return log.some((e) => {
    if (e.kind !== 'DischargeDataObligation') return false
    if (e.target.includes(item.typeName)) return true
    return Boolean(item.retrieveFunction && e.target.includes(item.retrieveFunction))
  })
}

function dischargedDataCount(log: RefinementLogEntry[]): number {
  const seen = new Set<string>()
  for (const e of log) {
    if (e.kind !== 'DischargeDataObligation') continue
    seen.add(e.target)
  }
  return seen.size
}

function grainSnapshot(source: string, log: RefinementLogEntry[], notes: AuthorTextNote[] = []) {
  const snap = counts(source, notes)
  const closed = closeProcessGrain(snap.grain, log)
  const sticky = stickyGrainIds(closed.flatMap((row) => row.obligationIds))
  const unloggedGrain = unloggedGrainClosures(sticky, log)
  return { snap, closed, sticky, unloggedGrain, grainAmbiguity: closed.reduce((sum, row) => sum + row.obligationIds.length, 0) + unloggedGrain }
}

export function buildRefinementState(
  source: string,
  log: RefinementLogEntry[],
  notes: AuthorTextNote[] = []
): RefinementState {
  const { snap, closed, unloggedGrain, grainAmbiguity } = grainSnapshot(source, log, notes)
  const grainByProcess = new Map(closed.map((row) => [`${row.moduleName}::${row.processName}`, row]))
  const extra = unloggedFormalizations(snap.informalAtoms, log)
  const discharged = dischargedDataCount(log)
  const diagnostics = [
    ...(extra > 0
      ? [
          {
            code: 'ASFL_REFINE_001',
            message: `${extra} informal atom(s) disappeared without a FormalizePredicate step; ambiguity is not reduced`,
            severity: 'warning'
          }
        ]
      : []),
    ...(unloggedGrain > 0
      ? [
          {
            code: 'ASFL_REFINE_002',
            message: `${unloggedGrain} grain obligation(s) disappeared without ClassifyGrain, ResolveVariation, or DecomposeProcess; grain ambiguity is not reduced`,
            severity: 'warning'
          }
        ]
      : [])
  ]
  let signed = 0
  let grainBlocked = 0
  const processes: RefinementProcessRow[] = snap.processes.map((p) => {
    const grain = grainByProcess.get(`${p.moduleName}::${p.processName}`)
    const declaredAtomic = processIsDeclared(p, log)
    const grainClosed = grain?.grainClosed ?? false
    const operationallyAtomic = p.structurallyAtomic && grainClosed
    if (p.structurallyAtomic && grainClosed && declaredAtomic) signed += 1
    if (p.structurallyAtomic && !grainClosed) grainBlocked += 1
    const status: AtomicityStatus = operationallyAtomic ? (declaredAtomic ? 'atomic' : 'ready') : 'open'
    return {
      ...p,
      informalAtoms: snap.informalAtoms.filter(
        (a) => a.moduleName === p.moduleName && a.processName === p.processName
      ),
      declaredAtomic,
      status,
      effectPattern: grain?.effectPattern ?? 'opaque',
      grainClass: grain?.grainClass ?? 'unclassified',
      nameEffectMismatch: grain?.nameEffectMismatch ?? false,
      variations: grain?.variations ?? [],
      grainClosed,
      operationallyAtomic
    }
  })
  const readyCount = processes.filter((p) => p.operationallyAtomic && !p.declaredAtomic).length
  return {
    processAmbiguity: Math.max(0, snap.processAmbiguity - signed - grainBlocked + extra),
    dataAmbiguity: Math.max(0, snap.dataAmbiguity - discharged),
    grainAmbiguity,
    informalAtoms: snap.informalAtoms,
    unloggedFormalizations: extra,
    unloggedGrainClosures: unloggedGrain,
    diagnostics,
    processes,
    modules: snap.modules,
    breakdown: {
      informalAtomCount: snap.breakdown.informalAtomCount + extra,
      incompleteScenarioCount: snap.breakdown.incompleteScenarioCount,
      openConditionCount: snap.breakdown.openConditionCount,
      unbalancedBoundaryCount: snap.breakdown.unbalancedBoundaryCount,
      undeclaredAtomicCount: readyCount,
      emptyModuleCount: snap.breakdown.emptyModuleCount,
      stubProcessCount: snap.breakdown.stubProcessCount
    },
    dataItems: snap.dataItems.map((item) => ({
      ...item,
      discharged: dataItemDischarged(item, log)
    })),
    log
  }
}

function replaceOnce(source: string, from: string, to: string): string | null {
  const idx = source.indexOf(from)
  if (idx < 0) return null
  return source.slice(0, idx) + to + source.slice(idx + from.length)
}

function isIdentChar(c: string | undefined): boolean {
  return Boolean(c && /[A-Za-z0-9_\u0080-\uFFFF]/.test(c))
}

function clipPredicate(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 160 ? `${compact.slice(0, 159)}…` : compact
}

/** Exact match, then a unique whitespace-insensitive match so pretty-printed spacing still formalizes. */
function replacePredicateText(source: string, from: string, to: string): { source: string } | { error: string } {
  const exact = replaceOnce(source, from, to)
  if (exact != null) return { source: exact }
  const needle = from.replace(/\s+/g, '')
  if (!needle.trim()) return { error: 'FormalizePredicate fromText is empty.' }
  const hits: Array<{ start: number; end: number }> = []
  for (let i = 0; i < source.length; i++) {
    if (/\s/.test(source[i]!)) continue
    if (isIdentChar(source[i - 1]) && isIdentChar(needle[0])) continue
    let si = i
    let ni = 0
    let end = i
    while (si < source.length && ni < needle.length) {
      if (/\s/.test(source[si]!)) {
        si += 1
        continue
      }
      if (source[si] !== needle[ni]) break
      end = si + 1
      si += 1
      ni += 1
    }
    if (ni !== needle.length) continue
    if (isIdentChar(source[end]) && isIdentChar(needle[needle.length - 1])) continue
    hits.push({ start: i, end })
  }
  if (hits.length === 1) {
    const hit = hits[0]!
    return { source: source.slice(0, hit.start) + to + source.slice(hit.end) }
  }
  if (hits.length > 1) {
    return {
      error: `Informal text matched ${hits.length} times; quote a longer unique snippet. Text: ${clipPredicate(from)}`
    }
  }
  return { error: `Informal text not found: ${clipPredicate(from)}` }
}

function applyStepToSource(source: string, step: RefinementStep): { source: string; error?: string } {
  switch (step.kind) {
    case 'FormalizePredicate': {
      if (!step.fromText || step.toText == null) return { source, error: 'FormalizePredicate requires fromText and toText' }
      const next = replacePredicateText(source, step.fromText, step.toText)
      if ('error' in next) return { source, error: next.error }
      return { source: next.source }
    }
    case 'DecomposeProcess': {
      if (!step.moduleName || !step.processName || !step.childModuleName) {
        return { source, error: 'DecomposeProcess requires moduleName, processName, childModuleName' }
      }
      return { source: decomposeProcess(source, step.moduleName, step.processName, step.childModuleName) }
    }
    case 'BalanceFlows': {
      if (!step.moduleName || !step.fromText) return { source, error: 'BalanceFlows requires moduleName and flow text' }
      const { ast } = parse(source)
      if (!ast || ast.type !== 'program') return { source, error: 'Parse failed' }
      const mod = ast.modules.find((m) => m.name === step.moduleName || `SYSTEM_${m.name}` === step.moduleName)
      if (!mod) return { source, error: `Unknown module ${step.moduleName}` }
      const cdfd: CdfdBlockNode = mod.cdfd ?? {
        type: 'cdfd',
        span: { start: 0, end: 0, line: 1, column: 1 },
        ports: [],
        stores: [],
        nodes: [],
        conditions: [],
        flows: []
      }
      const [from, to] = (step.toText ?? step.fromText).split('->').map((s) => s.trim())
      if (from && to) {
        cdfd.flows = [...cdfd.flows, { type: 'cdfd_flow', span: cdfd.span, from, to }]
      }
      return { source: patchCdfdBlock(source, mod.name, cdfd) }
    }
    case 'DefineType': {
      if (!step.moduleName || !step.typeName || !step.toText) return { source, error: 'DefineType requires module, type, and body' }
      return { source: patchType(source, step.moduleName, step.typeName, `${step.typeName} = ${step.toText}`) }
    }
    case 'BindConstraint': {
      if (!step.toText) return { source, error: 'BindConstraint requires invariant text' }
      return { source }
    }
    case 'DeclareAtomic': {
      return { source }
    }
    case 'Extend': {
      if (!step.moduleName || !step.processName) return { source, error: 'Extend requires moduleName and processName' }
      return { source: addProcess(source, step.moduleName, step.processName) }
    }
    case 'IntroduceRetrieve': {
      if (!step.moduleName || !step.typeName || !step.representationType || !step.retrieveFunction) {
        return { source, error: 'IntroduceRetrieve requires type, representation, and retrieve function' }
      }
      const { ast } = parse(source)
      if (!ast || ast.type !== 'program') return { source, error: 'Parse failed' }
      const mod = ast.modules.find((m) => m.name === step.moduleName)
      if (!mod) return { source, error: `Unknown module ${step.moduleName}` }
      const refine: RefineBlockNode = {
        type: 'refine',
        span: { start: 0, end: 0, line: 1, column: 1 },
        items: [
          ...(mod.refine?.items ?? []),
          {
            type: 'refine_type',
            span: { start: 0, end: 0, line: 1, column: 1 },
            abstractType: step.typeName,
            representationType: step.representationType,
            retrieveFunction: step.retrieveFunction
          }
        ]
      }
      let next = source
      if (mod.refine) {
        next = source.slice(0, mod.refine.span.start) + printRefineBlock(refine) + source.slice(mod.refine.span.end)
      } else {
        const endKw = source.lastIndexOf('end_module', mod.span.end)
        const at = endKw >= 0 ? endKw : mod.span.end
        next = source.slice(0, at) + `${printRefineBlock(refine)}\n` + source.slice(at)
      }
      if (step.retrieveBody) {
        next = addFunction(
          next,
          step.moduleName,
          step.retrieveFunction,
          `function ${step.retrieveFunction} (rep: ${step.representationType}): ${step.typeName}\n== ${step.retrieveBody}\nend_function`
        )
      }
      return { source: next }
    }
    case 'DischargeDataObligation': {
      return { source }
    }
    case 'ClassifyGrain': {
      if (!step.moduleName || !step.processName || (step.grainClass !== 'operation' && step.grainClass !== 'abstract')) {
        return { source, error: 'ClassifyGrain requires moduleName, processName, and grainClass operation|abstract' }
      }
      return { source }
    }
    case 'ResolveVariation': {
      if (!step.moduleName || !step.processName || !step.variationId || !step.disposition) {
        return { source, error: 'ResolveVariation requires moduleName, processName, variationId, and disposition' }
      }
      if (step.disposition !== 'scenario' && step.disposition !== 'child' && step.disposition !== 'waived') {
        return { source, error: 'ResolveVariation disposition must be scenario, child, or waived' }
      }
      if (step.disposition === 'waived' && !step.note?.trim()) {
        return { source, error: 'ResolveVariation waived requires a note' }
      }
      if (step.disposition === 'child' && !step.toText?.trim()) {
        return { source, error: 'ResolveVariation child requires toText (the child process name)' }
      }
      return { source }
    }
    case 'SetCdfd': {
      if (!step.moduleName || !step.toText?.trim()) {
        return { source, error: 'SetCdfd requires moduleName and toText (a cdfd block)' }
      }
      const body = step.toText.trim()
      const wrapped = body.startsWith('cdfd')
        ? `module Wrap;\n${body}\nend_module`
        : `module Wrap;\ncdfd\n${body}\nend_cdfd\nend_module`
      const { ast } = parse(wrapped)
      const cdfd = ast?.type === 'program' ? ast.modules[0]?.cdfd : undefined
      if (!cdfd) return { source, error: 'SetCdfd text is not a valid cdfd block' }
      return { source: patchCdfdBlock(source, step.moduleName, cdfd) }
    }
    default:
      return { source, error: `Unknown step ${String((step as RefinementStep).kind)}` }
  }
}

export function decomposeProcess(
  source: string,
  moduleName: string,
  processName: string,
  childModuleName: string
): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const mod = ast.modules.find((m) => m.name === moduleName || `SYSTEM_${m.name}` === moduleName)
  const proc = mod?.processes.find((p) => p.name === processName)
  if (!mod || !proc) return source
  const parentLabel = mod.isSystem ? `SYSTEM_${mod.name}` : mod.name
  let next = addModule(source, childModuleName, { parentName: parentLabel })
  const inPorts = proc.inputs.flatMap((g) => g.names)
  const outPorts = proc.outputs.flatMap((g) => g.names)
  const cdfd: CdfdBlockNode = {
    type: 'cdfd',
    span: { start: 0, end: 0, line: 1, column: 1 },
    ports: [
      ...inPorts.map((name) => ({ type: 'cdfd_port' as const, span: { start: 0, end: 0, line: 1, column: 1 }, direction: 'in' as const, name })),
      ...outPorts.map((name) => ({ type: 'cdfd_port' as const, span: { start: 0, end: 0, line: 1, column: 1 }, direction: 'out' as const, name }))
    ],
    stores: (proc.body?.ext ?? []).map((e) => ({
      type: 'cdfd_store' as const,
      span: { start: 0, end: 0, line: 1, column: 1 },
      name: e.name
    })),
    nodes: [],
    conditions: [],
    flows: []
  }
  next = patchCdfdBlock(next, childModuleName, cdfd)
  next = patchDecom(next, processName, childModuleName)
  return next
}

export function applyRefinementStep(
  source: string,
  log: RefinementLogEntry[],
  step: RefinementStep,
  notes: AuthorTextNote[] = []
): { source: string; log: RefinementLogEntry[]; error?: string; state: RefinementState } {
  const beforeState = buildRefinementState(source, log, notes)
  if (step.kind === 'DeclareAtomic') {
    const row = beforeState.processes.find(
      (p) => p.processName === step.processName && (!step.moduleName || p.moduleName === step.moduleName)
    )
    if (!row || !canDeclareAtomic(row, { grainClosed: row.grainClosed })) {
      const why = !row?.structurallyAtomic ? 'not structurally atomic' : 'not operationally atomic'
      return { source, log, error: `Process '${step.processName}' is ${why}`, state: beforeState }
    }
  }
  const applied = applyStepToSource(source, step)
  if (applied.error) {
    return { source, log, error: applied.error, state: beforeState }
  }
  const beforeGrain = grainSnapshot(source, log, notes)
  const provisional: RefinementLogEntry = {
    id: 'provisional',
    at: '',
    kind: step.kind,
    target: targetKey(step),
    beforeHash: '',
    afterHash: '',
    processAmbiguityBefore: 0,
    processAmbiguityAfter: 0,
    dataAmbiguityBefore: 0,
    dataAmbiguityAfter: 0,
    informalKeysBefore: [],
    informalKeysAfter: [],
    grainKeysBefore: beforeGrain.sticky,
    grainKeysAfter: beforeGrain.sticky
  }
  const afterGrain = grainSnapshot(applied.source, [...log, provisional], notes)
  const afterState = buildRefinementState(applied.source, [...log, provisional], notes)
  const entry: RefinementLogEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    kind: step.kind,
    target: targetKey(step),
    beforeHash: contentHash(source),
    afterHash: contentHash(applied.source),
    processAmbiguityBefore: beforeState.processAmbiguity,
    processAmbiguityAfter: afterState.processAmbiguity,
    dataAmbiguityBefore: beforeState.dataAmbiguity,
    dataAmbiguityAfter: afterState.dataAmbiguity,
    informalKeysBefore: beforeState.informalAtoms.map((a) => a.key),
    informalKeysAfter: afterState.informalAtoms.map((a) => a.key),
    grainAmbiguityBefore: beforeGrain.grainAmbiguity,
    grainAmbiguityAfter: afterGrain.grainAmbiguity,
    grainKeysBefore: beforeGrain.sticky,
    grainKeysAfter: afterGrain.sticky,
    discharged: step.kind === 'DischargeDataObligation' || step.kind === 'DeclareAtomic',
    note: step.note
  }
  const nextLog = [...log, entry]
  const state = buildRefinementState(applied.source, nextLog, notes)
  return { source: applied.source, log: nextLog, state }
}

export type RefinementDigestView = 'summary' | 'tree' | 'log'

export interface DualLineRates {
  overall: number
  processRate: number
  dataRate: number
  grainRate: number
  atomicLeaves: number
  expectedLeaves: number
  unambiguous: boolean
}

function findModuleRow(modules: RefinementModuleRow[], name: string | undefined): RefinementModuleRow | undefined {
  if (!name) return undefined
  const bare = name.startsWith('SYSTEM_') ? name.slice('SYSTEM_'.length) : name
  return modules.find((m) => m.name === name || m.name === bare || `SYSTEM_${m.name}` === name)
}

function decomTargetSet(processes: RefinementProcessRow[]): Set<string> {
  const set = new Set<string>()
  for (const p of processes) {
    const t = p.decomTarget?.trim()
    if (!t) continue
    set.add(t)
    if (t.startsWith('SYSTEM_')) set.add(t.slice('SYSTEM_'.length))
    else set.add(`SYSTEM_${t}`)
  }
  return set
}

function leafStats(
  state: RefinementState,
  moduleName: string,
  seen = new Set<string>()
): { atomic: number; total: number } {
  if (seen.has(moduleName)) return { atomic: 0, total: 0 }
  seen.add(moduleName)
  let atomic = 0
  let total = 0
  for (const proc of state.processes.filter((p) => p.moduleName === moduleName)) {
    if (proc.hasDecom && proc.decomTarget) {
      const child = findModuleRow(state.modules, proc.decomTarget)
      if (child) {
        const nested = leafStats(state, child.name, seen)
        atomic += nested.atomic
        total += nested.total
      } else {
        total += 1
      }
      continue
    }
    total += 1
    if (proc.status === 'atomic') atomic += 1
  }
  if (total === 0) {
    const mod = findModuleRow(state.modules, moduleName)
    if (mod?.isEmpty) return { atomic: 0, total: 1 }
  }
  return { atomic, total }
}

export function dualLineRates(state: RefinementState): DualLineRates {
  const targets = decomTargetSet(state.processes)
  const roots = state.modules.filter((m) => !targets.has(m.name) && !targets.has(`SYSTEM_${m.name}`))
  let atomicLeaves = 0
  let expectedLeaves = 0
  for (const mod of roots) {
    const s = leafStats(state, mod.name)
    atomicLeaves += s.atomic
    expectedLeaves += s.total
  }
  const processRate = expectedLeaves <= 0 ? 0 : atomicLeaves / expectedLeaves
  const dataOpen = state.dataItems.filter((d) => !d.discharged).length
  const dataTotal = state.dataItems.length
  const dataRate =
    dataTotal === 0 ? (state.breakdown.emptyModuleCount > 0 ? 0 : 1) : (dataTotal - dataOpen) / dataTotal
  const leaves = state.processes.filter((p) => !p.hasDecom)
  const grainClosedLeaves = leaves.filter((p) => p.grainClosed).length
  const grainRate =
    state.grainAmbiguity === 0
      ? 1
      : leaves.length === 0
        ? 0
        : grainClosedLeaves / (grainClosedLeaves + state.grainAmbiguity)
  const overall = harmonicMean([processRate, dataRate, grainRate])
  const unambiguous =
    state.processAmbiguity === 0 &&
    state.dataAmbiguity === 0 &&
    state.grainAmbiguity === 0 &&
    (state.breakdown.emptyModuleCount ?? 0) === 0 &&
    (state.breakdown.stubProcessCount ?? 0) === 0
  return { overall, processRate, dataRate, grainRate, atomicLeaves, expectedLeaves, unambiguous }
}

function harmonicMean(parts: number[]): number {
  if (parts.some((part) => part <= 0)) return 0
  const inverted = parts.reduce((sum, part) => sum + 1 / part, 0)
  return parts.length / inverted
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 16))}\n…(truncated)`
}

function nextSliceHints(state: RefinementState): string[] {
  const hints: string[] = []
  for (const mod of state.modules) {
    if (mod.isEmpty) hints.push(`fill empty module ${mod.name}`)
  }
  for (const p of state.processes) {
    if (p.isStub) hints.push(`flesh out stub process ${p.moduleName}.${p.processName}`)
    else if (!p.hasDecom && !p.grainClosed) {
      const openVariations = p.variations.filter((variation) => variation.disposition === 'unresolved')
      if (p.nameEffectMismatch || openVariations.length > 0) {
        const listed = openVariations.map((variation) => variation.text).join(', ')
        hints.push(
          `ask_clarification for ${p.moduleName}.${p.processName}` +
            `${p.effectPattern !== 'opaque' ? ` effect=${p.effectPattern}` : ''}` +
            `${p.nameEffectMismatch ? ' name-claim' : ''}` +
            `${listed ? ` variations=${listed}` : ''}. Then ResolveVariation or ClassifyGrain. Do not clear grainAmbiguity by rewriting pre/post.`
        )
      } else {
        hints.push(`ClassifyGrain operation ${p.moduleName}.${p.processName} after ask_clarification. Do not clear grainAmbiguity by rewriting pre/post.`)
      }
    } else if (p.status === 'ready') hints.push(`DeclareAtomic ${p.moduleName}.${p.processName}`)
    else if (p.status === 'open' && !p.hasDecom) {
      if (p.informalAtomCount > 0) hints.push(`FormalizePredicate ${p.moduleName}.${p.processName}`)
      else if (!p.scenarioCoverageComplete) hints.push(`complete scenarios ${p.moduleName}.${p.processName}`)
      else if (!p.onCdfd) hints.push(`SetCdfd so ${p.moduleName}.${p.processName} appears as a node`)
    }
  }
  for (const item of state.dataItems) {
    if (item.discharged) continue
    if (item.kind === 'obligation') hints.push(`DischargeDataObligation ${item.typeName}`)
    else hints.push(`IntroduceRetrieve/DefineType ${item.typeName}`)
  }
  return [...new Set(hints)].slice(0, 12)
}

/** Compact dual-line refinement tree for the Specification Agent. */
export function formatRefinementDigest(
  state: RefinementState,
  view: RefinementDigestView = 'summary',
  limit = 12000
): string {
  const rates = dualLineRates(state)
  const b = state.breakdown
  const pct = (n: number) => `${Math.round(n * 100)}%`
  if (view === 'log') {
    if (!state.log.length) return 'Refinement audit log: (empty)'
    const lines = [...state.log]
      .slice(-24)
      .reverse()
      .map(
        (e) =>
          `${e.kind} ${e.target}  process ${e.processAmbiguityBefore}→${e.processAmbiguityAfter}  data ${e.dataAmbiguityBefore}→${e.dataAmbiguityAfter}  grain ${e.grainAmbiguityBefore ?? '?'}→${e.grainAmbiguityAfter ?? '?'}`
      )
    return clip(`Refinement audit log (newest first):\n${lines.join('\n')}`, limit)
  }

  const header = [
    `Three-line refinement (process + data + operational grain). Unambiguous only when processAmbiguity=0, dataAmbiguity=0, grainAmbiguity=0, empty modules=0, stub processes=0.`,
    `Overall (harmonic mean): ${pct(rates.overall)}  process atomicity ${rates.atomicLeaves}/${rates.expectedLeaves} (${pct(rates.processRate)})  data discharge ${pct(rates.dataRate)}  grain ${pct(rates.grainRate)}  unambiguous=${rates.unambiguous}`,
    `Counters: processAmbiguity=${state.processAmbiguity} dataAmbiguity=${state.dataAmbiguity} grainAmbiguity=${state.grainAmbiguity} unloggedGrain=${state.unloggedGrainClosures} emptyModules=${b.emptyModuleCount ?? 0} stubs=${b.stubProcessCount ?? 0} informalAtoms=${b.informalAtomCount} openScenarios=${b.incompleteScenarioCount} openConds=${b.openConditionCount} unbalancedFlows=${b.unbalancedBoundaryCount} undeclaredAtomic=${b.undeclaredAtomicCount}`
  ]

  if (view === 'summary') {
    const hints = nextSliceHints(state)
    const next =
      rates.unambiguous
        ? 'No remaining dual-line gaps. Do not invent extra CDFDs.'
        : `Suggested next slices (ask the user; do not refine the whole tree at once):\n${hints.map((h) => `- ${h}`).join('\n') || '- (inspect tree view)'}`
    return clip([...header, next].join('\n'), limit)
  }

  const targets = decomTargetSet(state.processes)
  const roots = state.modules.filter((m) => !targets.has(m.name) && !targets.has(`SYSTEM_${m.name}`))
  const lines: string[] = [...header, 'Process tree:']
  const walk = (mod: RefinementModuleRow, depth: number, seen: Set<string>) => {
    if (seen.has(mod.name)) return
    seen.add(mod.name)
    const stats = leafStats(state, mod.name)
    const pad = '  '.repeat(depth)
    const label = mod.isSystem ? `SYSTEM_${mod.name}` : mod.name
    const empty = mod.isEmpty ? ' EMPTY-SHELL' : ''
    lines.push(`${pad}${label}${empty} leaves ${stats.atomic}/${stats.total}`)
    for (const proc of state.processes.filter((p) => p.moduleName === mod.name)) {
      const flags = [
        proc.status,
        proc.isStub ? 'stub' : '',
        proc.hasDecom ? `decom:${proc.decomTarget ?? '?'}` : '',
        proc.informalAtomCount ? `informal:${proc.informalAtomCount}` : '',
        proc.scenarioCoverageComplete ? '' : 'coverage-open',
        proc.typesDefined ? '' : 'types-open',
        proc.onCdfd ? '' : 'off-cdfd',
        proc.grainClosed ? '' : `grain:${proc.effectPattern}${proc.nameEffectMismatch ? ':name' : ''}`
      ].filter(Boolean)
      lines.push(`${pad}  process ${proc.processName} [${flags.join(' ')}]`)
      if (proc.hasDecom && proc.decomTarget) {
        const child = findModuleRow(state.modules, proc.decomTarget)
        if (child) walk(child, depth + 2, seen)
        else lines.push(`${pad}    missing child ${proc.decomTarget}`)
      }
    }
  }
  const seen = new Set<string>()
  for (const mod of roots) walk(mod, 0, seen)
  lines.push('Data items:')
  if (!state.dataItems.length) lines.push('  (none)')
  for (const item of state.dataItems) {
    lines.push(
      `  ${item.kind} ${item.typeName}${item.retrieveFunction ? ` retrieve ${item.retrieveFunction}` : ''} ${item.discharged ? 'discharged' : 'OPEN'} — ${item.message}`
    )
  }
  return clip(lines.join('\n'), limit)
}
