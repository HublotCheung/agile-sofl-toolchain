import type { ProcessNode, ProgramNode, ConditionClauseNode } from '@agile-sofl/parser'
import { deriveFsf, printConditionText, type FunctionalScenarioForm, type DerivedFunctionalScenario } from '@agile-sofl/parser'
import { sliceText, toSerializableSpan, type SerializableSpan } from './span.js'
import { findProcess } from './documentModel.js'

export interface FsfScenarioDto {
  id: string
  test: string
  def: string
  span: SerializableSpan
  name?: string
  kind?: 'normal' | 'exceptional'
  guard?: string
  definingCondition?: string
  testCondition?: string
  atomicPredicates?: string[]
}

export interface FsfModelDto {
  processName: string
  /** Set when FSF belongs to a function rather than a process. */
  functionName?: string
  moduleName?: string
  span: SerializableSpan
  scenarios: FsfScenarioDto[]
  others?: string
  othersSpan?: SerializableSpan
  source?: 'derived' | 'editor-internal-dsl'
  precondition?: string
  exceptionalScenarios?: FsfScenarioDto[]
}

function emptySpan(processNode: ProcessNode): SerializableSpan {
  return toSerializableSpan(processNode.body?.span ?? processNode.span)
}

function derivedToDto(s: DerivedFunctionalScenario, span: SerializableSpan): FsfScenarioDto {
  return {
    id: s.id,
    test: s.testCondition,
    def: s.definingCondition,
    span,
    name: s.name,
    kind: s.kind,
    guard: s.guard,
    definingCondition: s.definingCondition,
    testCondition: s.testCondition,
    atomicPredicates: s.atomicPredicates
  }
}

export function formToFsfModel(form: FunctionalScenarioForm, processNode: ProcessNode): FsfModelDto {
  const span = toSerializableSpan(form.fsf.span)
  return {
    processName: form.processName,
    span: form.fsf.span.end > form.fsf.span.start ? span : emptySpan(processNode),
    source: form.source,
    precondition: form.precondition,
    scenarios: form.scenarios.map((s) => derivedToDto(s, span)),
    exceptionalScenarios: form.exceptionalScenarios.map((s) => derivedToDto(s, span)),
    others: form.exceptionalScenarios[0]?.definingCondition
  }
}

export function buildFsfModel(processNode: ProcessNode, source: string): FsfModelDto | null {
  // Inventory and editors must show the text that is actually in the file.
  // deriveFsf rewrites predicates (and joins pre/post), which made source edits miss.
  if (processNode.body?.fsf) {
    return buildFsfModelFromSpec(processNode.name, processNode.body.fsf, source)
  }
  const derived = deriveFsf(processNode)
  if (derived) return formToFsfModel(formWithSourceText(derived, processNode, source), processNode)
  return null
}

function formWithSourceText(form: FunctionalScenarioForm, processNode: ProcessNode, source: string): FunctionalScenarioForm {
  const pre = processNode.body?.pre
  const preText = pre ? sliceClause(pre, source) : form.precondition
  return { ...form, precondition: preText }
}

function sliceClause(clause: ConditionClauseNode, source: string): string {
  if (clause.text?.trim()) return printConditionText(clause) || clause.text
  if (clause.span.end > clause.span.start) return sliceText(source, clause.span).trim()
  return ''
}

export function buildFsfModelFromSpec(
  processName: string,
  fsf: NonNullable<NonNullable<ProcessNode['body']>['fsf']>,
  source: string
): FsfModelDto {
  const scenarios: FsfScenarioDto[] = fsf.scenarios.map((s, i: number) => ({
    id: `${processName}-scenario-${i + 1}`,
    test: sliceText(source, s.test.span),
    def: sliceText(source, s.def.span),
    span: toSerializableSpan(s.span),
    kind: 'normal',
    guard: sliceText(source, s.test.span),
    definingCondition: sliceText(source, s.def.span),
    testCondition: sliceText(source, s.test.span)
  }))
  return {
    processName,
    span: toSerializableSpan(fsf.span),
    source: 'editor-internal-dsl',
    scenarios,
    others: fsf.others ? sliceText(source, fsf.others.span) : undefined,
    othersSpan: fsf.others ? toSerializableSpan(fsf.others.span) : undefined,
    exceptionalScenarios: fsf.others
      ? [
          {
            id: `${processName}-E1`,
            test: 'others',
            def: sliceText(source, fsf.others.span),
            span: toSerializableSpan(fsf.others.span),
            name: 'others',
            kind: 'exceptional',
            guard: 'others',
            definingCondition: sliceText(source, fsf.others.span),
            testCondition: 'others'
          }
        ]
      : []
  }
}

export function buildAllFsfModels(ast: ProgramNode, source: string): FsfModelDto[] {
  const models: FsfModelDto[] = []
  for (const mod of ast.modules) {
    for (const proc of mod.processes) {
      const model = buildFsfModel(proc, source)
      if (model) models.push({ ...model, moduleName: mod.name })
    }
    for (const fn of mod.functions) {
      if (!fn.fsf) continue
      models.push({
        ...buildFsfModelFromSpec(fn.name, fn.fsf, source),
        functionName: fn.name,
        moduleName: mod.name
      })
    }
  }
  return models
}

export function buildFsfModelByName(
  ast: ProgramNode,
  source: string,
  processName: string
): FsfModelDto | null {
  const proc = findProcess(ast, processName)
  if (!proc) return null
  return buildFsfModel(proc, source)
}
