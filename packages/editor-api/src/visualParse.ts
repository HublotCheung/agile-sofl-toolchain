import {
  parse,
  textOf,
  isFsfFormal,
  classifyFsf,
  checkCdfd,
  checkDataRefine,
  deriveFsf,
  printType,
  type ProgramNode,
  type Span
} from '@agile-sofl/parser'
import { buildModuleGraph } from './moduleGraph.js'
import { buildAllCdfdGraphs, type CdfdGraph } from './cdfdGraph.js'
import { buildAllFsfModels } from './fsfModel.js'
import { sliceText, toSerializableSpan } from './span.js'
import { collectVisualDuplicateDiagnostics } from './visualDuplicateDiagnostics.js'
import {
  processSignatureText,
  functionSignatureText,
  paramGroupsFromNodes,
  type ParamGroupDto
} from './signatureUtils.js'
import type { ExtVarDto } from './extPatch.js'

export type FsfFormalStatus = 'formal' | 'semi-formal' | null
export type FormalizationStatus = 'semi-formal' | 'formal' | 'mixed'

export type VisualParseDiagnostic = {
  code: string
  message: string
  severity: string
  span: ReturnType<typeof toSerializableSpan>
  source: 'parse' | 'fsf' | 'visual'
}

export type VisualModelResult = {
  parseFailed: boolean
  hasDiagnostics: boolean
  ast: ProgramNode | null
  diagnostics: VisualParseDiagnostic[]
  moduleGraph: ReturnType<typeof buildModuleGraph> | null
  cdfdGraphs: CdfdGraph[]
  fsfModels: ReturnType<typeof buildAllFsfModels>
  modules: Array<{
    name: string
    isSystem: boolean
    parentName?: string
    span: ReturnType<typeof toSerializableSpan>
    constCount: number
    typeCount: number
    varCount: number
    invCount: number
    invariants: Array<{ text: string; span: ReturnType<typeof toSerializableSpan> }>
    processes: Array<{
      name: string
      span: ReturnType<typeof toSerializableSpan>
      decom: string
      comment: string
      hasFsf: boolean
      isAlias: boolean
      aliasTarget?: string
      isInit: boolean
      signature: string
      inputs: ParamGroupDto[]
      outputs: ParamGroupDto[]
      ext: ExtVarDto[]
      fsfFormal: FsfFormalStatus
      pre: string
      post: string
      hasPre: boolean
      hasPost: boolean
      scenarioCount: number
      exceptionalCount: number
      formalizationStatus: FormalizationStatus
      fsfSource?: 'derived' | 'editor-internal-dsl'
      /** Verbatim FSF block from the source, for agent reads and source edits. */
      fsfText?: string
    }>
    functions: Array<{
      name: string
      text: string
      span: ReturnType<typeof toSerializableSpan>
      hasFsf: boolean
      body: string
      signature: string
      params: ParamGroupDto[]
      returnType: string
      fsfFormal: FsfFormalStatus
    }>
    consts: Array<{ name: string; text: string; span: ReturnType<typeof toSerializableSpan> }>
    types: Array<{
      name: string
      text: string
      span: ReturnType<typeof toSerializableSpan>
      fields?: Array<{ name: string; type: string }>
    }>
    vars: Array<{ name: string; text: string; span: ReturnType<typeof toSerializableSpan> }>
    gui?: {
      name: string
      span: ReturnType<typeof toSerializableSpan>
      screens: Array<{
        name: string
        span: ReturnType<typeof toSerializableSpan>
        triggersProcess?: string
        widgets: Array<{
          name: string
          kind: string
          text: string
          triggersProcess?: string
          span: ReturnType<typeof toSerializableSpan>
        }>
      }>
    }
  }>
}

function mapDiagnostics(
  items: Array<{ code: string; message: string; severity: string; span: { start: number; end: number; line: number; column: number } }>,
  source: 'parse' | 'fsf' | 'visual'
): VisualParseDiagnostic[] {
  return items.map((d) => ({
    code: d.code,
    message: d.message,
    severity: d.severity,
    span: toSerializableSpan(d.span),
    source
  }))
}

function aliasTargetText(alias: { module?: string; name: string }): string {
  return alias.module ? `${alias.module}.${alias.name}` : alias.name
}

function fsfFormalStatus(fsf: Parameters<typeof isFsfFormal>[0] | undefined): FsfFormalStatus {
  if (!fsf) return null
  return isFsfFormal(fsf) ? 'formal' : 'semi-formal'
}

function processFormalization(p: ProgramNode['modules'][0]['processes'][0]): {
  fsfFormal: FsfFormalStatus
  formalizationStatus: FormalizationStatus
  scenarioCount: number
  exceptionalCount: number
  fsfSource?: 'derived' | 'editor-internal-dsl'
} {
  const form = deriveFsf(p)
  const preKind = p.body?.pre?.kind
  const postKind = p.body?.post?.kind
  const kinds = [preKind, postKind].filter(Boolean)
  let formalizationStatus: FormalizationStatus = 'semi-formal'
  if (kinds.length && kinds.every((k) => k === 'formal') && form && form.source === 'derived') {
    formalizationStatus = 'formal'
  } else if (kinds.includes('formal') && kinds.includes('natural-language')) {
    formalizationStatus = 'mixed'
  } else if (p.body?.fsf) {
    formalizationStatus = isFsfFormal(p.body.fsf) ? 'formal' : 'semi-formal'
  }
  return {
    fsfFormal: p.body?.fsf ? fsfFormalStatus(p.body.fsf) : form ? (form.source === 'derived' ? 'semi-formal' : fsfFormalStatus(form.fsf)) : null,
    formalizationStatus,
    scenarioCount: form?.scenarios.length ?? 0,
    exceptionalCount: form?.exceptionalScenarios.length ?? 0,
    fsfSource: form?.source
  }
}

function clauseSource(source: string, span: Span, keyword: string): string {
  const text = sliceText(source, span).replace(/\s+/g, ' ').trim()
  return text.replace(new RegExp(`^${keyword}\\s+`, 'i'), '')
}

function typeFields(t: ProgramNode['modules'][0]['types'][0]): Array<{ name: string; type: string }> | undefined {
  if (t.typeExpr.type !== 'composed_type') return undefined
  return t.typeExpr.fields.map((f) => ({ name: f.name, type: printType(f.typeExpr) }))
}

/** Tolerant parse for visual editor — keeps partial AST when possible. */
export function buildVisualModelTolerant(source: string): VisualModelResult {
  const { ast, diagnostics: parseDiags } = parse(source)
  const program = ast?.type === 'program' ? ast : null
  const parseFailed = !program

  const allDiagnostics = mapDiagnostics(
    parseDiags.map((d) => ({
      code: d.code,
      message: d.message,
      severity: d.severity,
      span: d.span
    })),
    'parse'
  )

  if (program) {
    const fsfDiags = classifyFsf(program).diagnostics
    allDiagnostics.push(
      ...mapDiagnostics(
        fsfDiags.map((d) => ({
          code: d.code,
          message: d.message,
          severity: d.severity,
          span: d.span
        })),
        'fsf'
      )
    )
    allDiagnostics.push(...collectVisualDuplicateDiagnostics(program, source))
    allDiagnostics.push(
      ...mapDiagnostics(
        checkCdfd(program).diagnostics.map((d) => ({
          code: d.code,
          message: d.message,
          severity: d.severity,
          span: d.span
        })),
        'parse'
      )
    )
    allDiagnostics.push(
      ...mapDiagnostics(
        checkDataRefine(program).diagnostics.map((d) => ({
          code: d.code,
          message: d.message,
          severity: d.severity,
          span: d.span
        })),
        'parse'
      )
    )
  }

  const hasDiagnostics = allDiagnostics.some((d) => d.severity === 'error')

  if (!program) {
    return {
      parseFailed,
      hasDiagnostics,
      ast: null,
      diagnostics: allDiagnostics,
      moduleGraph: null,
      cdfdGraphs: [],
      fsfModels: [],
      modules: []
    }
  }

  return {
    parseFailed,
    hasDiagnostics,
    ast: program,
    diagnostics: allDiagnostics,
    moduleGraph: buildModuleGraph(program),
    cdfdGraphs: buildAllCdfdGraphs(program),
    fsfModels: buildAllFsfModels(program, source),
    modules: program.modules
      .filter((mod) => mod.name.trim().length > 0)
      .map((mod) => ({
      name: mod.name,
      isSystem: mod.isSystem,
      parentName: mod.parent?.name,
      span: toSerializableSpan(mod.span),
      constCount: mod.consts.length,
      typeCount: mod.types.length,
      varCount: mod.vars.length,
      invCount: mod.invariants.length,
      invariants: mod.invariants.map((inv) => ({
        text: sliceText(source, inv.span).trim(),
        span: toSerializableSpan(inv.span)
      })),
      processes: mod.processes.map((p) => {
        const form = processFormalization(p)
        return {
        name: p.name,
        span: toSerializableSpan(p.span),
        decom: textOf(p.body?.decomposition) ?? '',
        comment: textOf(p.body?.comment) ?? '',
        hasFsf: Boolean(p.body?.fsf) || Boolean(p.body?.pre || p.body?.post),
        isAlias: Boolean(p.alias),
        aliasTarget: p.alias ? aliasTargetText(p.alias) : undefined,
        isInit: p.isInit,
        signature: processSignatureText(p),
        inputs: paramGroupsFromNodes(p.inputs),
        outputs: paramGroupsFromNodes(p.outputs),
        ext: (p.body?.ext ?? []).map((e) => ({
          access: e.access,
          name: e.name,
          type: e.typeExpr ? sliceText(source, e.typeExpr.span).trim() : undefined
        })),
        fsfFormal: form.fsfFormal,
        pre: p.body?.pre ? clauseSource(source, p.body.pre.span, 'pre') : '',
        post: p.body?.post ? clauseSource(source, p.body.post.span, 'post') : '',
        hasPre: Boolean(p.body?.pre),
        hasPost: Boolean(p.body?.post),
        scenarioCount: form.scenarioCount,
        exceptionalCount: form.exceptionalCount,
        formalizationStatus: form.formalizationStatus,
        fsfSource: form.fsfSource,
        fsfText: p.body?.fsf ? sliceText(source, p.body.fsf.span).replace(/\s+/g, ' ').trim() : ''
        }
      }),
      functions: mod.functions.map((f) => ({
        name: f.name,
        text: sliceText(source, f.span).trim(),
        span: toSerializableSpan(f.span),
        hasFsf: Boolean(f.fsf),
        body: f.isUndefined
          ? 'undefined'
          : f.body
            ? sliceText(source, f.body.span).trim()
            : '',
        signature: functionSignatureText(f),
        params: paramGroupsFromNodes(f.params),
        returnType: printType(f.returnType),
        fsfFormal: f.fsf ? fsfFormalStatus(f.fsf) : null
      })),
      consts: mod.consts.map((c) => ({
        name: c.name,
        text: sliceText(source, c.span).trim(),
        span: toSerializableSpan(c.span)
      })),
      types: mod.types.map((t) => ({
        name: t.name,
        text: sliceText(source, t.span).trim(),
        span: toSerializableSpan(t.span),
        fields: typeFields(t)
      })),
      vars: mod.vars.map((v) => ({
        name: v.variable.name,
        text: sliceText(source, v.span).trim(),
        span: toSerializableSpan(v.span)
      })),
      gui: mod.gui
        ? {
            name: mod.gui.name,
            span: toSerializableSpan(mod.gui.span),
            screens: mod.gui.screens.map((s) => ({
              name: s.name,
              span: toSerializableSpan(s.span),
              triggersProcess: s.triggersProcess,
              widgets: s.widgets.map((w) => ({
                name: w.name,
                kind: w.kind,
                text: w.text,
                triggersProcess: w.triggersProcess,
                span: toSerializableSpan(w.span)
              }))
            }))
          }
        : undefined
    }))
  }
}
