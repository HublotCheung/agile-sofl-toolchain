import { parse, type ModuleNode, type ProgramNode } from '@agile-sofl/parser'
import {
  addConst,
  addType,
  addVar,
  patchConst,
  patchType,
  patchVar,
  removeConst,
  removeType,
  removeVar
} from './declarationPatch.js'
import { patchProcessSignature, validateProcessSignature } from './signaturePatch.js'
import type { FsfScenarioDto } from './fsfModel.js'
import { addGuiScreen, patchGuiWidgetText } from './guiPatch.js'
import {
  canonicalModuleName,
  namesEqual,
  parseHybridId,
  uniqueSlug,
  labelsMatch,
  slug,
  type ParsedHybridId
} from './hybridIds.js'
import { addModule, removeModule, renameModule, setModuleParent } from './modulePatch.js'
import {
  patchComment,
  patchFsfSpec,
  patchProcessFsfText,
  patchInvariant,
  patchProcessCondition
} from './patch.js'
import {
  addFunction,
  addProcess,
  patchFunction,
  removeFunction,
  removeProcess,
  renameFunction,
  renameProcess
} from './processPatch.js'
import { findModuleRange, hybridLeftoverMessage, insertInvLine } from './moduleSourceRange.js'
import { applyRefinementStep, type RefinementStep } from './refinement.js'
import { buildVisualModelTolerant, type VisualModelResult } from './visualParse.js'

export type HybridEntityKind =
  | 'module'
  | 'process'
  | 'function'
  | 'type'
  | 'var'
  | 'const'
  | 'inv'
  | 'scenario'
  | 'gui-screen'

export type HybridScenarioInput = {
  name?: string
  guard?: string
  test?: string
  def?: string
  definingCondition?: string
  kind?: 'normal' | 'exceptional'
}

export type HybridPatchOp =
  | {
      op: 'add'
      kind: HybridEntityKind
      parentId?: string
      name: string
      text?: string
      pre?: string
      post?: string
      signature?: string
      inputs?: string
      outputs?: string
      scenarios?: HybridScenarioInput[]
      afterId?: string
    }
  | {
      op: 'update'
      id: string
      signature?: string
      name?: string
      text?: string
      pre?: string
      post?: string
      comment?: string
      scenarios?: HybridScenarioInput[]
    }
  | { op: 'remove'; id: string }
  | { op: 'replace-process-body'; id: string; pre?: string; post?: string; /** Final-grammar FSF text `T1 && D1 || … || others && Dn` */ fsf?: string }
  | { op: 'replace-document'; asflText: string }
  | {
      op: 'refine-step'
      kind: import('./refinement.js').RefinementStepKind
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
      grainClass?: 'operation' | 'abstract'
      variationId?: string
      disposition?: 'scenario' | 'child' | 'waived'
    }

export interface HybridPatch {
  operations: HybridPatchOp[]
  explanation?: string
  target?: 'hybrid'
}

type OpOk = { ok: true; content: string }
type OpErr = { ok: false; error: string }
type OpResult = OpOk | OpErr

type ResolvedEntity =
  | { kind: 'module'; moduleName: string }
  | { kind: 'process'; moduleName: string; name: string }
  | { kind: 'function'; moduleName: string; name: string }
  | { kind: 'type'; moduleName: string; name: string; text: string }
  | { kind: 'var'; moduleName: string; name: string; text: string }
  | { kind: 'const'; moduleName: string; name: string; text: string }
  | { kind: 'inv'; moduleName: string; name: string; text: string; span: { start: number; end: number } }
  | {
      kind: 'scenario'
      moduleName: string
      processName: string
      name: string
      index: number
      scenarios: FsfScenarioDto[]
      others?: string
    }
  | {
      kind: 'gui-screen'
      moduleName: string
      guiName: string
      screenName: string
      span: { start: number; end: number }
      widgetNames: string[]
    }

function emptySpan(): FsfScenarioDto['span'] {
  return { start: 0, end: 0, line: 1, column: 1 }
}

function findAstModule(ast: ProgramNode, moduleName: string): ModuleNode | undefined {
  return ast.modules.find((m) => namesEqual(m.name, moduleName))
}

function findVisualModule(model: VisualModelResult, moduleName: string) {
  return model.modules.find((m) => namesEqual(m.name, moduleName))
}

function err(error: string): OpErr {
  return { ok: false, error }
}

function ok(content: string): OpOk {
  return { ok: true, content }
}

function unknownId(id: string): OpErr {
  return err(`Unknown hybrid id: ${id}`)
}

function ensureTrailingSemicolon(text: string): string {
  const trimmed = text.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

function indentLine(text: string, spaces = 2): string {
  return `${' '.repeat(spaces)}${text.trim()}`
}

function moduleHeaderEnd(source: string, mod: ModuleNode): number {
  const semi = source.indexOf(';', mod.span.start)
  return semi >= 0 && semi < mod.span.end ? semi + 1 : mod.span.start
}

function lastSpanEnd(items: Array<{ span: { end: number } }>): number | undefined {
  return items.length ? items[items.length - 1]!.span.end : undefined
}

function firstSpanStart(items: Array<{ span: { start: number } }>): number | undefined {
  return items[0]?.span.start
}

function startOfLine(source: string, pos: number): number {
  let i = pos
  while (i > 0 && source[i - 1] !== '\n') i -= 1
  return i
}

function endOfLine(source: string, pos: number): number {
  let i = pos
  while (i < source.length && source[i] !== '\n') i += 1
  return i
}

function endModulePos(source: string, mod: ModuleNode): number {
  const endModule = source.lastIndexOf('end_module', mod.span.end)
  return endModule >= 0 ? endModule : mod.span.end
}

function beforeBodyStart(source: string, mod: ModuleNode): number {
  const raw =
    firstSpanStart(mod.invariants) ??
    (mod.gui ? mod.gui.span.start : undefined) ??
    firstSpanStart(mod.processes) ??
    firstSpanStart(mod.functions)
  return raw != null ? startOfLine(source, raw) : endModulePos(source, mod)
}

function declInsertPoint(source: string, mod: ModuleNode, kind: 'const' | 'type' | 'var'): number {
  const beforeRaw =
    (kind === 'const' ? firstSpanStart(mod.types) : undefined) ??
    (kind !== 'var' ? firstSpanStart(mod.vars) : undefined)
  const before = beforeRaw != null ? startOfLine(source, beforeRaw) : beforeBodyStart(source, mod)
  const afterRaw =
    kind === 'var'
      ? lastSpanEnd(mod.types) ?? lastSpanEnd(mod.consts)
      : kind === 'type'
        ? lastSpanEnd(mod.consts)
        : undefined
  if (afterRaw != null) return endOfLine(source, afterRaw)
  if (kind === 'const') return moduleHeaderEnd(source, mod)
  return before
}

function addDeclLine(
  source: string,
  moduleName: string,
  kind: 'const' | 'type' | 'var',
  line: string
): string | null {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return null
  const mod = findAstModule(ast, moduleName)
  if (!mod) return null
  if (kind === 'const') return addConst(source, moduleName, line)
  if (kind === 'type') return addType(source, moduleName, line)
  return addVar(source, moduleName, line)
}

function insertInv(source: string, moduleName: string, text: string): string | null {
  const scanned = insertInvLine(source, moduleName, ensureTrailingSemicolon(text))
  if (scanned != null) return scanned
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return null
  const mod = findAstModule(ast, moduleName)
  if (!mod) return null
  const line = ensureTrailingSemicolon(text)
  if (mod.invariants.length > 0) {
    let at = mod.invariants[mod.invariants.length - 1]!.span.end
    while (at < source.length && source[at] !== '\n') at += 1
    return source.slice(0, at) + `\n${indentLine(line)}` + source.slice(at)
  }
  const slice = source.slice(mod.span.start, mod.span.end)
  const existing = /(^|\n)inv\s*\n/i.exec(slice)
  if (existing) {
    const at = mod.span.start + existing.index + existing[0].length
    return source.slice(0, at) + `${indentLine(line)}\n` + source.slice(at)
  }
  const at = lastSpanEnd(mod.vars) ?? lastSpanEnd(mod.types) ?? lastSpanEnd(mod.consts)
  const insertAt = at != null ? endOfLine(source, at) : declInsertPoint(source, mod, 'var')
  return source.slice(0, insertAt) + `\ninv\n${indentLine(line)}\n` + source.slice(insertAt)
}

function removeLineSpan(source: string, span: { start: number; end: number }): string {
  let lineStart = span.start
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart -= 1
  let lineEnd = span.end
  while (lineEnd < source.length && source[lineEnd] !== '\n') lineEnd += 1
  if (source[lineEnd] === '\n') lineEnd += 1
  return source.slice(0, lineStart) + source.slice(lineEnd)
}

function stripEmptyInvSection(source: string, moduleName: string): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const mod = findAstModule(ast, moduleName)
  if (!mod || mod.invariants.length > 0) return source
  const slice = source.slice(mod.span.start, mod.span.end)
  const match = /(^|\n)inv\s*\n(?=\s*(?:gui|process|function|end_module))/i.exec(slice)
  if (!match) return source
  const start = mod.span.start + match.index + match[1].length
  const end = start + (match[0].length - match[1].length)
  return source.slice(0, start) + source.slice(end)
}

function typeLine(name: string, text?: string): string {
  if (!text?.trim()) return `${name} = nat`
  const raw = text.trim()
  let t = raw.includes('=') ? raw : `${name} = ${raw}`
  t = t.replace(/(\S+)\s+序列\b/g, 'seq of $1')
  t = t.replace(/(\S+)\s+集合\b/g, 'set of $1')
  t = t.replace(/(\S+)\s*->\s*(\S+)/g, 'map $1 to $2')
  const eq = t.match(/^(\S+)\s*=\s*([\s\S]+)$/)
  if (
    eq &&
    /:\s*\S/.test(eq[2]!) &&
    !/\bcomposed\s+of\b/i.test(eq[2]!) &&
    !eq[2]!.trim().startsWith('{')
  ) {
    const fields = eq[2]!.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    return `${eq[1]} = composed of ${fields} end`
  }
  return t
}

function varLine(name: string, text?: string): string {
  if (!text?.trim()) return `${name}: nat`
  const t = text.trim()
  return t.includes(':') ? t : `${name}: ${t}`
}

function constLine(name: string, text?: string): string {
  if (!text?.trim()) return `${name} = 0`
  const t = text.trim()
  return t.includes('=') ? t : `${name} = ${t}`
}

function processSignature(op: Extract<HybridPatchOp, { op: 'add' }>): string {
  if (op.signature?.trim()) return op.signature.trim()
  if (op.inputs != null || op.outputs != null) {
    return `(${op.inputs ?? ''})${op.outputs?.trim() ? ` ${op.outputs.trim()}` : ''}`
  }
  return '()'
}

function buildProcessTemplate(name: string, op: Extract<HybridPatchOp, { op: 'add' }>): string {
  const raw = op.text?.trim()
  if (raw && /^\s*process\b/i.test(raw) && !/\bend_module\b/i.test(raw)) return raw
  const pre = op.pre?.trim() || 'true'
  const post = op.post?.trim() || 'true'
  return `process ${name} ${processSignature(op)}
    pre
        ${pre}
    post
        ${post}
end_process`
}

function buildFunctionTemplate(name: string, op: Extract<HybridPatchOp, { op: 'add' }>): string {
  const raw = op.text?.trim()
  if (raw && /^\s*function\b/i.test(raw) && !/\bend_module\b/i.test(raw)) return raw
  const sig = op.signature?.trim() || '(x: nat): nat'
  const sigText = sig.startsWith('(') ? sig : `(${sig})`
  const body = raw || 'x + 1'
  return `function ${name}${sigText}\n== ${body}\nend_function`
}

function toScenarioDto(s: HybridScenarioInput, index: number): FsfScenarioDto {
  const test = (s.test ?? s.guard ?? 'true').trim() || 'true'
  const def = (s.def ?? s.definingCondition ?? 'true').trim() || 'true'
  return {
    id: s.name ?? `scenario-${index + 1}`,
    test,
    def,
    span: emptySpan(),
    name: s.name,
    kind: s.kind,
    guard: s.guard ?? s.test,
    definingCondition: s.definingCondition ?? s.def,
    testCondition: s.test
  }
}

function processScenarios(model: VisualModelResult, moduleName: string, processName: string): {
  scenarios: FsfScenarioDto[]
  others?: string
} {
  const fsf = model.fsfModels.find(
    (m) =>
      !m.functionName &&
      m.processName === processName &&
      namesEqual(m.moduleName ?? '', moduleName)
  )
  if (!fsf) return { scenarios: [] }
  const scenarios = [...fsf.scenarios]
  for (const extra of fsf.exceptionalScenarios ?? []) {
    if (!scenarios.some((s) => s.id === extra.id)) scenarios.push(extra)
  }
  return { scenarios, others: fsf.others }
}

function scenarioLabel(scenario: FsfScenarioDto, indexInKind: number): string {
  const named = scenario.name?.trim()
  if (named) return named
  if (scenario.kind === 'exceptional') return `Exceptional${indexInKind}`
  return indexInKind === 1 ? 'Success' : `Success${indexInKind}`
}

function scenarioIdNames(scenarios: FsfScenarioDto[]): string[] {
  const used = new Set<string>()
  let normalIndex = 0
  let exceptionalIndex = 0
  return scenarios.map((scenario) => {
    if (scenario.kind === 'exceptional') exceptionalIndex += 1
    else normalIndex += 1
    const indexInKind = scenario.kind === 'exceptional' ? exceptionalIndex : normalIndex
    return uniqueSlug(scenarioLabel(scenario, indexInKind), used)
  })
}

function invIdNames(texts: string[]): string[] {
  const used = new Set<string>()
  return texts.map((text) => uniqueSlug(text, used))
}

function matchName(actual: string, expected: string): boolean {
  return labelsMatch(actual, expected)
}

function resolveEntity(source: string, id: string): ResolvedEntity | null {
  const parsed = parseHybridId(id)
  if (!parsed) return null
  const model = buildVisualModelTolerant(source)
  return resolveParsed(model, parsed) ?? resolveFuzzy(model, parsed)
}

function resolveFuzzy(model: VisualModelResult, parsed: ParsedHybridId): ResolvedEntity | null {
  if (!parsed.bare && parsed.kind !== 'mod' && !findVisualModule(model, parsed.moduleName)) return null
  const query = parsed.entityName || parsed.moduleName
  if (parsed.kind === 'mod' || parsed.bare) {
    const mod = model.modules.find(
      (m) => labelsMatch(m.name, parsed.moduleName) || labelsMatch(m.name, query)
    )
    if (mod && parsed.kind === 'mod') return { kind: 'module', moduleName: mod.name }
  }

  const kinds: Array<ParsedHybridId['kind']> =
    parsed.kind === 'fn' || parsed.kind === 'proc' ? ['proc', 'fn'] : [parsed.kind]

  for (const kind of kinds) {
    for (const mod of model.modules) {
      if (parsed.bare || !findVisualModule(model, parsed.moduleName)) {
        /* search all modules */
      } else if (!namesEqual(mod.name, parsed.moduleName)) {
        continue
      }
      if (kind === 'proc') {
        const proc = mod.processes.find(
          (p) =>
            labelsMatch(p.name, query) ||
            labelsMatch(p.comment, query) ||
            labelsMatch(p.comment.replace(/^.*aspec[_-]?fn[_-]/i, ''), query)
        )
        if (proc) return { kind: 'process', moduleName: mod.name, name: proc.name }
      }
      if (kind === 'fn') {
        const fn = mod.functions.find((f) => labelsMatch(f.name, query))
        if (fn) return { kind: 'function', moduleName: mod.name, name: fn.name }
      }
      if (kind === 'type') {
        const t = mod.types.find((x) => labelsMatch(x.name, query))
        if (t) return { kind: 'type', moduleName: mod.name, name: t.name, text: t.text }
      }
      if (kind === 'var') {
        const v = mod.vars.find((x) => labelsMatch(x.name, query))
        if (v) return { kind: 'var', moduleName: mod.name, name: v.name, text: v.text }
      }
      if (kind === 'const') {
        const c = mod.consts.find((x) => labelsMatch(x.name, query))
        if (c) return { kind: 'const', moduleName: mod.name, name: c.name, text: c.text }
      }
      if (kind === 'inv') {
        const names = invIdNames(mod.invariants.map((i) => i.text))
        let idx = /^\d+$/.test(query) ? parseInt(query, 10) : -1
        if (idx < 0) idx = names.findIndex((n, i) => labelsMatch(n, query) || labelsMatch(mod.invariants[i]?.text, query))
        if (idx >= 0 && idx < mod.invariants.length) {
          const inv = mod.invariants[idx]!
          return { kind: 'inv', moduleName: mod.name, name: names[idx]!, text: inv.text, span: inv.span }
        }
      }
      if (kind === 'gui') {
        if (!mod.gui) continue
        const screen = parsed.screenName
          ? mod.gui.screens.find((s) => labelsMatch(s.name, parsed.screenName))
          : mod.gui.screens[0]
        if (labelsMatch(mod.gui.name, parsed.moduleName) || labelsMatch(mod.name, parsed.moduleName) || screen) {
          if (!screen) continue
          return {
            kind: 'gui-screen',
            moduleName: mod.name,
            guiName: mod.gui.name,
            screenName: screen.name,
            span: screen.span,
            widgetNames: screen.widgets.map((w) => w.name)
          }
        }
      }
    }
  }

  if (parsed.kind === 'mod') {
    const mod = model.modules.find((m) => labelsMatch(m.name, parsed.moduleName) || labelsMatch(m.name, query))
    if (mod) return { kind: 'module', moduleName: mod.name }
  }
  return null
}

function resolveParsed(model: VisualModelResult, parsed: ParsedHybridId): ResolvedEntity | null {
  if (parsed.kind === 'mod') {
    const mod = findVisualModule(model, parsed.moduleName)
    return mod ? { kind: 'module', moduleName: mod.name } : null
  }

  if (parsed.kind === 'gui') {
    for (const mod of model.modules) {
      if (!mod.gui) continue
      const guiMatch = namesEqual(mod.gui.name, parsed.moduleName) || namesEqual(mod.name, parsed.moduleName)
      const screen = parsed.screenName
        ? mod.gui.screens.find((s) => matchName(s.name, parsed.screenName!))
        : undefined
      if (guiMatch && screen) {
        return {
          kind: 'gui-screen',
          moduleName: mod.name,
          guiName: mod.gui.name,
          screenName: screen.name,
          span: screen.span,
          widgetNames: screen.widgets.map((w) => w.name)
        }
      }
    }
    return null
  }

  const mod = findVisualModule(model, parsed.moduleName)
  if (!mod || !parsed.entityName) return null

  if (parsed.kind === 'proc') {
    const proc = mod.processes.find((p) => namesEqual(p.name, parsed.entityName!))
      ?? mod.processes.find((p) => matchName(p.name, parsed.entityName!))
    return proc ? { kind: 'process', moduleName: mod.name, name: proc.name } : null
  }
  if (parsed.kind === 'fn') {
    const fn = mod.functions.find((f) => matchName(f.name, parsed.entityName!))
    return fn ? { kind: 'function', moduleName: mod.name, name: fn.name } : null
  }
  if (parsed.kind === 'type') {
    const t = mod.types.find((x) => matchName(x.name, parsed.entityName!))
    return t ? { kind: 'type', moduleName: mod.name, name: t.name, text: t.text } : null
  }
  if (parsed.kind === 'var') {
    const v = mod.vars.find((x) => matchName(x.name, parsed.entityName!))
    return v ? { kind: 'var', moduleName: mod.name, name: v.name, text: v.text } : null
  }
  if (parsed.kind === 'const') {
    const c = mod.consts.find((x) => matchName(x.name, parsed.entityName!))
    return c ? { kind: 'const', moduleName: mod.name, name: c.name, text: c.text } : null
  }
  if (parsed.kind === 'inv') {
    const names = invIdNames(mod.invariants.map((i) => i.text))
    const entity = parsed.entityName!
    let idx = /^\d+$/.test(entity) ? parseInt(entity, 10) : -1
    if (idx < 0) idx = names.findIndex((n) => matchName(n, entity))
    if (idx < 0 || idx >= mod.invariants.length) return null
    const inv = mod.invariants[idx]!
    return {
      kind: 'inv',
      moduleName: mod.name,
      name: names[idx]!,
      text: inv.text,
      span: inv.span
    }
  }
  if (parsed.kind === 'scn') {
    if (!parsed.processName) return null
    const proc = mod.processes.find((p) => matchName(p.name, parsed.processName!))
    if (!proc) return null
    const { scenarios, others } = processScenarios(model, mod.name, proc.name)
    const names = scenarioIdNames(scenarios)
    const idx = names.findIndex((n) => matchName(n, parsed.entityName!))
    if (idx < 0) {
      return {
        kind: 'scenario',
        moduleName: mod.name,
        processName: proc.name,
        name: parsed.entityName,
        index: -1,
        scenarios,
        others
      }
    }
    return {
      kind: 'scenario',
      moduleName: mod.name,
      processName: proc.name,
      name: names[idx]!,
      index: idx,
      scenarios,
      others
    }
  }
  return null
}

function defaultModule(source: string): { moduleName: string } | OpErr {
  const model = buildVisualModelTolerant(source)
  if (model.modules.length === 1) return { moduleName: model.modules[0]!.name }
  if (model.modules.length === 0) return err('Cannot add entity: no module found')
  return err('Missing parentId for add operation')
}

function resolveParentModule(source: string, parentId?: string): { moduleName: string } | OpErr {
  if (!parentId) return defaultModule(source)
  const parsed = parseHybridId(parentId)
  if (!parsed) return unknownId(parentId)
  const resolved = resolveEntity(source, parentId)
  if (resolved?.kind === 'process' || resolved?.kind === 'function') {
    return { moduleName: resolved.moduleName }
  }
  if (resolved?.kind === 'module') return { moduleName: resolved.moduleName }
  if (resolved && 'moduleName' in resolved) return { moduleName: resolved.moduleName }

  const model = buildVisualModelTolerant(source)
  if (parsed.kind === 'gui') {
    const byGui = model.modules.find((m) => m.gui && namesEqual(m.gui.name, parsed.moduleName))
    const byName = findVisualModule(model, parsed.moduleName)
    const mod = byGui ?? byName
    if (!mod) return unknownId(parentId)
    return { moduleName: mod.name }
  }
  const mod = findVisualModule(model, parsed.moduleName)
  if (!mod) return unknownId(parentId)
  return { moduleName: mod.name }
}

function ensureNamedModule(source: string, moduleName: string): string {
  const model = buildVisualModelTolerant(source)
  if (findVisualModule(model, moduleName)) return source
  const fuzzy = model.modules.find((m) => labelsMatch(m.name, moduleName))
  if (fuzzy) return source
  const name = slug(moduleName) || moduleName
  return addModule(source, name, { isSystem: /^SYSTEM_/i.test(moduleName) || /^SYSTEM_/i.test(name) })
}

function resolveParentProcess(
  source: string,
  parentId?: string
): { moduleName: string; processName: string } | OpErr {
  if (!parentId) return err('Missing parentId for scenario')
  const resolved = resolveEntity(source, parentId)
  if (resolved?.kind === 'process') {
    return { moduleName: resolved.moduleName, processName: resolved.name }
  }
  if (resolved?.kind === 'scenario') {
    return { moduleName: resolved.moduleName, processName: resolved.processName }
  }
  const parsed = parseHybridId(parentId)
  if (!parsed) return unknownId(parentId)
  const name = parsed.entityName || parsed.moduleName
  const parent = resolveParentModule(source, parentId)
  if ('error' in parent) return unknownId(parentId)
  return { moduleName: parent.moduleName, processName: name }
}

function unchangedAdd(source: string, next: string, what: string): OpResult {
  if (next === source) return err(`Cannot add ${what}`)
  return ok(next)
}

function applyAdd(source: string, op: Extract<HybridPatchOp, { op: 'add' }>): OpResult {
  if (!op.name?.trim() && op.kind !== 'inv') return err('Add operation requires a name')

  if (op.kind === 'module') {
    const parent = op.parentId ? parseHybridId(op.parentId) : null
    const parentName = parent ? canonicalModuleName(parent.moduleName) : undefined
    const isSystem = Boolean(!parentName && op.name.startsWith('SYSTEM_'))
    const existing = findModuleRange(source, op.name)
    if (existing) {
      if (parentName) {
        const next = setModuleParent(source, existing.name, parentName)
        return next === source ? ok(source) : ok(next)
      }
      return ok(source)
    }
    const next = addModule(source, op.name, { isSystem, parentName })
    return unchangedAdd(source, next, `module "${op.name}"`)
  }

  if (op.kind === 'scenario') {
    if (op.parentId) {
      const hint = parseHybridId(op.parentId)
      if (hint?.moduleName) source = ensureNamedModule(source, hint.moduleName)
      const existing = resolveEntity(source, op.parentId)
      if (!existing || existing.kind !== 'process') {
        const created = materializeFromId(source, op.parentId, { name: hint?.entityName || hint?.moduleName })
        if (created.ok) source = created.content
      }
    }
    const parent = resolveParentProcess(source, op.parentId)
    if ('error' in parent) return parent
    const model = buildVisualModelTolerant(source)
    const { scenarios, others } = processScenarios(model, parent.moduleName, parent.processName)
    const nextScenarios = [
      ...scenarios,
      toScenarioDto(
        {
          name: op.name,
          guard: op.pre,
          test: op.text,
          def: op.post,
          ...op.scenarios?.[0]
        },
        scenarios.length
      )
    ]
    return ok(patchFsfSpec(source, parent.processName, nextScenarios, others))
  }

  const parentHint = op.parentId ? parseHybridId(op.parentId) : null
  if (parentHint?.moduleName) {
    const existing = resolveEntity(source, op.parentId || '')
    if (!existing || existing.kind === 'module') {
      source = ensureNamedModule(source, parentHint.moduleName)
    }
  }

  const parent = resolveParentModule(source, op.parentId)
  if ('error' in parent) return parent
  const { moduleName } = parent

  if (op.kind === 'process') {
    const next = addProcess(source, moduleName, op.name, buildProcessTemplate(op.name, op))
    if (next === source) return err(`Cannot add process "${op.name}"`)
    if (!op.scenarios?.length) return ok(next)
    return ok(patchFsfSpec(next, op.name, op.scenarios.map(toScenarioDto)))
  }

  if (op.kind === 'function') {
    const next = addFunction(source, moduleName, op.name, buildFunctionTemplate(op.name, op))
    return unchangedAdd(source, next, `function "${op.name}"`)
  }

  if (op.kind === 'type') {
    const next = addDeclLine(source, moduleName, 'type', typeLine(op.name, op.text))
    if (next == null) return err(`Cannot add type "${op.name}"`)
    return unchangedAdd(source, next, `type "${op.name}"`)
  }

  if (op.kind === 'var') {
    const next = addDeclLine(source, moduleName, 'var', varLine(op.name, op.text))
    if (next == null) return err(`Cannot add var "${op.name}"`)
    return unchangedAdd(source, next, `var "${op.name}"`)
  }

  if (op.kind === 'const') {
    const next = addDeclLine(source, moduleName, 'const', constLine(op.name, op.text))
    if (next == null) return err(`Cannot add const "${op.name}"`)
    return unchangedAdd(source, next, `const "${op.name}"`)
  }

  if (op.kind === 'inv') {
    const next = insertInv(source, moduleName, op.text?.trim() || 'true')
    if (next == null || next === source) return err(`Cannot add invariant to module "${moduleName}"`)
    return ok(next)
  }

  if (op.kind === 'gui-screen') {
    const next = addGuiScreen(source, moduleName, op.name, op.text)
    if (next == null || next === source) return err(`Cannot add gui-screen "${op.name}"`)
    return ok(next)
  }

  return err(`Unsupported add kind: ${op.kind}`)
}

function patchScenarios(
  source: string,
  processName: string,
  scenarios: FsfScenarioDto[],
  others?: string
): string {
  const normal = scenarios.filter((s) => s.kind !== 'exceptional')
  const exceptional = scenarios.filter((s) => s.kind === 'exceptional')
  const othersText = exceptional[0]?.def ?? others
  return patchFsfSpec(source, processName, normal.length ? normal : scenarios, othersText)
}

function applyScenarioUpdate(
  source: string,
  resolved: Extract<ResolvedEntity, { kind: 'scenario' }>,
  op: Extract<HybridPatchOp, { op: 'update' }>
): OpResult {
  const incoming = op.scenarios?.[0]
  const current = resolved.index >= 0 ? resolved.scenarios[resolved.index] : undefined
  const replacement = toScenarioDto(
    {
      name: op.name ?? incoming?.name ?? current?.name ?? resolved.name,
      test: incoming?.test ?? incoming?.guard ?? current?.test,
      guard: incoming?.guard ?? current?.guard,
      def: incoming?.def ?? incoming?.definingCondition ?? op.text ?? current?.def,
      definingCondition: incoming?.definingCondition ?? current?.definingCondition,
      kind: incoming?.kind ?? current?.kind
    },
    resolved.index >= 0 ? resolved.index : resolved.scenarios.length
  )
  const nextList = [...resolved.scenarios]
  if (resolved.index >= 0) nextList[resolved.index] = { ...current!, ...replacement, span: current!.span }
  else nextList.push(replacement)
  return ok(patchScenarios(source, resolved.processName, nextList, resolved.others))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceScreenBody(
  source: string,
  span: { start: number; end: number },
  inner: string
): string {
  const slice = source.slice(span.start, span.end)
  const nextSlice = slice.replace(/(screen[^\n]*\n)[\s\S]*?(?=\s*end_screen)/i, `$1${inner}\n`)
  return source.slice(0, span.start) + nextSlice + source.slice(span.end)
}

function renameScreen(
  source: string,
  span: { start: number; end: number },
  oldName: string,
  newName: string
): string {
  const slice = source.slice(span.start, span.end)
  const nextSlice = slice.replace(new RegExp(`screen\\s+${escapeRegex(oldName)}`, 'i'), `screen ${newName}`)
  return source.slice(0, span.start) + nextSlice + source.slice(span.end)
}

function materializeFromId(
  source: string,
  id: string,
  extra?: { name?: string; text?: string; pre?: string; post?: string }
): OpResult {
  const parsed = parseHybridId(id)
  if (!parsed) return unknownId(id)
  const name = extra?.name?.trim() || parsed.entityName || parsed.moduleName
  if (parsed.kind === 'mod') return ok(ensureNamedModule(source, parsed.moduleName))
  const moduleHint = parsed.bare ? name : parsed.moduleName
  source = ensureNamedModule(source, moduleHint)
  const parentId = `mod:${moduleHint}`
  if (parsed.kind === 'proc') {
    return applyAdd(source, {
      op: 'add',
      kind: 'process',
      parentId,
      name,
      pre: extra?.pre,
      post: extra?.post,
      text: extra?.text
    })
  }
  if (parsed.kind === 'fn') {
    return applyAdd(source, { op: 'add', kind: 'function', parentId, name, text: extra?.text })
  }
  if (parsed.kind === 'type') {
    return applyAdd(source, { op: 'add', kind: 'type', parentId, name, text: extra?.text })
  }
  if (parsed.kind === 'var') {
    return applyAdd(source, { op: 'add', kind: 'var', parentId, name, text: extra?.text })
  }
  if (parsed.kind === 'const') {
    return applyAdd(source, { op: 'add', kind: 'const', parentId, name, text: extra?.text })
  }
  if (parsed.kind === 'inv') {
    return applyAdd(source, { op: 'add', kind: 'inv', parentId, name, text: extra?.text || 'true' })
  }
  return unknownId(id)
}

function applyUpdate(source: string, op: Extract<HybridPatchOp, { op: 'update' }>): OpResult {
  let resolved = resolveEntity(source, op.id)
  if (!resolved) {
    const created = materializeFromId(source, op.id, op)
    if (!created.ok) return created
    source = created.content
    resolved = resolveEntity(source, op.id)
  }
  if (!resolved) return unknownId(op.id)

  if (resolved.kind === 'module') {
    if (!op.name) return ok(source)
    const next = renameModule(source, resolved.moduleName, op.name)
    if (next === source && op.name !== resolved.moduleName) return err(`Cannot rename module "${resolved.moduleName}"`)
    return ok(next)
  }

  if (resolved.kind === 'process') {
    let next = source
    if (op.name && op.name !== resolved.name) {
      next = renameProcess(next, resolved.moduleName, resolved.name, op.name)
      if (next === source) return err(`Cannot rename process "${resolved.name}"`)
    }
    const procName = op.name ?? resolved.name
    if (op.signature !== undefined) {
      const check = validateProcessSignature(op.signature)
      if (!check.ok) return err(`Invalid process signature: ${check.error}`)
      next = patchProcessSignature(next, resolved.moduleName, procName, op.signature)
    }
    if (op.pre !== undefined) next = patchProcessCondition(next, procName, 'pre', op.pre)
    if (op.post !== undefined) next = patchProcessCondition(next, procName, 'post', op.post)
    if (op.comment !== undefined) next = patchComment(next, procName, op.comment)
    if (op.scenarios) next = patchScenarios(next, procName, op.scenarios.map(toScenarioDto))
    return ok(next)
  }

  if (resolved.kind === 'function') {
    let next = source
    if (op.name && op.name !== resolved.name) {
      next = renameFunction(next, resolved.moduleName, resolved.name, op.name)
      if (next === source) return err(`Cannot rename function "${resolved.name}"`)
    }
    if (op.text !== undefined) next = patchFunction(next, { moduleName: resolved.moduleName, name: op.name ?? resolved.name, body: op.text })
    return ok(next)
  }

  if (resolved.kind === 'type') {
    const line = typeLine(op.name ?? resolved.name, op.text ?? resolved.text)
    const next = patchType(source, resolved.moduleName, resolved.name, line)
    if (next === source && (op.text !== undefined || op.name)) return err(`Cannot update type "${resolved.name}"`)
    return ok(next)
  }

  if (resolved.kind === 'var') {
    const line = varLine(op.name ?? resolved.name, op.text ?? resolved.text)
    const next = patchVar(source, resolved.moduleName, resolved.name, line)
    if (next === source && (op.text !== undefined || op.name)) return err(`Cannot update var "${resolved.name}"`)
    return ok(next)
  }

  if (resolved.kind === 'const') {
    const line = constLine(op.name ?? resolved.name, op.text ?? resolved.text)
    const next = patchConst(source, resolved.moduleName, resolved.name, line)
    if (next === source && (op.text !== undefined || op.name)) return err(`Cannot update const "${resolved.name}"`)
    return ok(next)
  }

  if (resolved.kind === 'inv') {
    if (op.text === undefined) return ok(source)
    return ok(patchInvariant(source, resolved.span, op.text))
  }

  if (resolved.kind === 'scenario') return applyScenarioUpdate(source, resolved, op)

  if (resolved.kind === 'gui-screen') {
    let next = source
    const screenName = op.name ?? resolved.screenName
    if (op.name && op.name !== resolved.screenName) {
      next = renameScreen(next, resolved.span, resolved.screenName, op.name)
    }
    if (op.text !== undefined) {
      const multiline = op.text.includes('\n') || /^\s*(label|button|text-input|navigation)\b/i.test(op.text)
      if (multiline) {
        next = replaceScreenBody(next, resolved.span, op.text)
      } else {
        const { ast } = parse(next)
        const widgetName = resolved.widgetNames.includes('Title') ? 'Title' : resolved.widgetNames[0]
        const patched =
          ast && ast.type === 'program' && widgetName
            ? patchGuiWidgetText(next, ast, resolved.moduleName, screenName, widgetName, op.text)
            : null
        next = patched ?? replaceScreenBody(next, resolved.span, `    label Title "${op.text}";`)
      }
    }
    return ok(next)
  }

  return unknownId(op.id)
}

function applyRemove(source: string, op: Extract<HybridPatchOp, { op: 'remove' }>): OpResult {
  const resolved = resolveEntity(source, op.id)
  if (!resolved) return unknownId(op.id)

  if (resolved.kind === 'module') {
    const next = removeModule(source, resolved.moduleName)
    return next === source ? err(`Cannot remove module "${resolved.moduleName}"`) : ok(next)
  }
  if (resolved.kind === 'process') {
    const next = removeProcess(source, resolved.moduleName, resolved.name)
    return next === source ? err(`Cannot remove process "${resolved.name}"`) : ok(next)
  }
  if (resolved.kind === 'function') {
    const next = removeFunction(source, resolved.moduleName, resolved.name)
    return next === source ? err(`Cannot remove function "${resolved.name}"`) : ok(next)
  }
  if (resolved.kind === 'type') {
    const next = removeType(source, resolved.moduleName, resolved.name)
    return next === source ? err(`Cannot remove type "${resolved.name}"`) : ok(next)
  }
  if (resolved.kind === 'var') {
    const next = removeVar(source, resolved.moduleName, resolved.name)
    return next === source ? err(`Cannot remove var "${resolved.name}"`) : ok(next)
  }
  if (resolved.kind === 'const') {
    const next = removeConst(source, resolved.moduleName, resolved.name)
    return next === source ? err(`Cannot remove const "${resolved.name}"`) : ok(next)
  }
  if (resolved.kind === 'inv') {
    const next = stripEmptyInvSection(removeLineSpan(source, resolved.span), resolved.moduleName)
    return ok(next)
  }
  if (resolved.kind === 'scenario') {
    if (resolved.index < 0) return unknownId(op.id)
    const nextList = resolved.scenarios.filter((_, i) => i !== resolved.index)
    return ok(patchScenarios(source, resolved.processName, nextList, resolved.others))
  }
  if (resolved.kind === 'gui-screen') {
    const model = buildVisualModelTolerant(source)
    const mod = findVisualModule(model, resolved.moduleName)
    const lastScreen = (mod?.gui?.screens.length ?? 0) <= 1
    if (lastScreen && mod?.gui) return ok(removeLineSpan(source, mod.gui.span))
    return ok(removeLineSpan(source, resolved.span))
  }
  return unknownId(op.id)
}

function applyReplaceBody(
  source: string,
  op: Extract<HybridPatchOp, { op: 'replace-process-body' }>
): OpResult {
  if (op.pre === undefined && op.post === undefined && op.fsf === undefined) {
    return err('replace-process-body requires fsf, pre or post')
  }
  const requested = parseHybridId(op.id)
  if (requested && !requested.bare && !findVisualModule(buildVisualModelTolerant(source), requested.moduleName)) {
    return err(`Unknown module in qualified process target: ${op.id}`)
  }
  const previouslyParseable = !parse(source).diagnostics.some((d) => d.severity === 'error')
  let resolved = resolveEntity(source, op.id)
  if (!resolved || resolved.kind !== 'process') {
    const created = materializeFromId(source, op.id, { pre: op.pre, post: op.post })
    if (!created.ok) return created
    source = created.content
    resolved = resolveEntity(source, op.id)
  }
  if (!resolved) return unknownId(op.id)
  if (resolved.kind !== 'process') return err(`replace-process-body expects a process id, got ${op.id}`)
  if (previouslyParseable && op.fsf !== undefined) {
    const candidate = patchProcessFsfText(source, resolved.name, op.fsf, resolved.moduleName)
    const errors = parse(candidate).diagnostics.filter((d) => d.severity === 'error')
    if (errors.length) return err(`Typed FSF replacement rejected before writing: ${errors[0]!.message.slice(0, 240)}`)
  }
  let next = source
  if (op.pre !== undefined) next = patchProcessCondition(next, resolved.name, 'pre', op.pre)
  if (op.post !== undefined) next = patchProcessCondition(next, resolved.name, 'post', op.post)
  if (op.fsf !== undefined) {
    const patched = patchProcessFsfText(next, resolved.name, op.fsf, resolved.moduleName)
    if (patched === next) return err(`Cannot write FSF for process ${resolved.name}`)
    next = patched
  }
  return ok(next)
}

function isRealModuleName(name: string): boolean {
  const n = name.trim()
  return n.length > 0 && n !== 'SYSTEM_'
}

function namedModuleNames(source: string): string[] {
  return moduleHeaders(source).filter(isRealModuleName)
}

function moduleHeaders(source: string): string[] {
  const names: string[] = []
  const re =
    /^\s*(?:module|system)\s+(?:SYSTEM_)?([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/gim
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    if (match[1]) names.push(match[1])
  }
  return names
}

function namesLost(before: string[], after: string[]): string[] {
  return before.filter((n) => !after.some((x) => namesEqual(x, n)))
}

function isModuleRemoveOp(op: HybridPatchOp): boolean {
  if (op.op !== 'remove') return false
  const parsed = parseHybridId(op.id)
  return parsed?.kind === 'mod'
}

function structuralDumpReason(op: HybridPatchOp): string | null {
  if (op.op === 'replace-document' || (op.op === 'update' && 'asflText' in op)) {
    return 'replace-document / asflText is not allowed. Use add/update/remove CRUD.'
  }
  const fields: string[] = []
  if ('text' in op && typeof op.text === 'string') fields.push(op.text)
  if ('pre' in op && typeof op.pre === 'string') fields.push(op.pre)
  if ('post' in op && typeof op.post === 'string') fields.push(op.post)
  if ('comment' in op && typeof op.comment === 'string') fields.push(op.comment)
  if ('signature' in op && typeof op.signature === 'string') fields.push(op.signature)
  const allowProcessBlock =
    op.op === 'add' && 'kind' in op && (op.kind === 'process' || op.kind === 'function')
  for (const text of fields) {
    if (/\b(?:module|system)\b[\s\S]{6,}\bend_module\b/i.test(text) || /\bend_module\b/i.test(text)) {
      return 'Do not put module/end_module in CRUD fields. Add each module with kind: module.'
    }
    if (!allowProcessBlock && /^\s*process\b/im.test(text) && /\bend_process\b/i.test(text)) {
      return 'Do not put a process block in this field. Use add kind: process.'
    }
  }
  return null
}

function applyOp(source: string, op: HybridPatchOp): OpResult {
  const dump = structuralDumpReason(op)
  if (dump) return err(dump)
  switch (op.op) {
    case 'add':
      return applyAdd(source, op)
    case 'update':
      return applyUpdate(source, op)
    case 'remove':
      return applyRemove(source, op)
    case 'replace-process-body':
      return applyReplaceBody(source, op)
    case 'refine-step': {
      const step: RefinementStep = {
        kind: op.kind,
        moduleName: op.moduleName,
        processName: op.processName,
        typeName: op.typeName,
        clause: op.clause,
        fromText: op.fromText,
        toText: op.toText,
        childModuleName: op.childModuleName,
        representationType: op.representationType,
        retrieveFunction: op.retrieveFunction,
        retrieveBody: op.retrieveBody,
        note: op.note,
        grainClass: op.grainClass,
        variationId: op.variationId,
        disposition: op.disposition
      }
      const applied = applyRefinementStep(source, [], step)
      if (applied.error) return err(applied.error)
      return ok(applied.source)
    }
    case 'replace-document':
      return err('replace-document is not allowed. Use add/update/remove CRUD.')
  }
}

export function applyHybridPatch(source: string, patch: HybridPatch): { content: string; error?: string; warnings?: string[] } {
  let content = source
  let protectedNames = namedModuleNames(source)
  const warnings: string[] = []
  for (const op of patch.operations) {
    const result = applyOp(content, op)
    if (!result.ok) {
      warnings.push(result.error)
      continue
    }
    const nextNames = namedModuleNames(result.content)
    const lost = namesLost(protectedNames, nextNames)
    const moduleRemove = isModuleRemoveOp(op)
    const headersBefore = moduleHeaders(content)
    const headersAfter = moduleHeaders(result.content)
    const headersGone = headersBefore.length > 0 && headersAfter.length === 0 && !moduleRemove
    const parsedDrop =
      protectedNames.length > 0 &&
      nextNames.length > 0 &&
      lost.length > (moduleRemove ? 1 : 0)
    const wiped = headersGone || parsedDrop
    if (wiped) {
      const label =
        ('kind' in op && op.kind ? `${op.op} ${op.kind}` : op.op) +
        ('name' in op && op.name ? ` ${op.name}` : '') +
        ('id' in op && op.id ? ` ${op.id}` : '')
      warnings.push(
        `Skipped ${label.trim()}: would drop modules (${lost.join(', ') || 'all'}). Keep existing modules and use CRUD ids.`
      )
      continue
    }
    const leftoverAfter = hybridLeftoverMessage(result.content)
    const leftoverBefore = hybridLeftoverMessage(content)
    if (leftoverAfter && leftoverAfter !== leftoverBefore) {
      const label =
        ('kind' in op && op.kind ? `${op.op} ${op.kind}` : op.op) +
        ('name' in op && op.name ? ` ${op.name}` : '') +
        ('id' in op && op.id ? ` ${op.id}` : '')
      warnings.push(`Skipped ${label.trim()}: ${leftoverAfter}`)
      continue
    }
    content = result.content
    if (nextNames.length) protectedNames = nextNames
  }
  const leftover = hybridLeftoverMessage(content)
  if (leftover) warnings.push(leftover)
  if (!warnings.length) return { content }
  return { content, error: warnings.join('; '), warnings }
}
