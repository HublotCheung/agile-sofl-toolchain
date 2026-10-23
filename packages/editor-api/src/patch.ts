import { parse, printProgram, textOf } from '@agile-sofl/parser'
import type { ProgramNode } from '@agile-sofl/parser'
import type { Span } from '@agile-sofl/parser'
import { findProcess } from './documentModel.js'
import { namesEqual } from './hybridIds.js'
import type { FsfScenarioDto } from './fsfModel.js'

function replaceSpan(source: string, span: { start: number; end: number }, replacement: string): string {
  return source.slice(0, span.start) + replacement + source.slice(span.end)
}

/** Replace the full source line containing valueSpan (keeps leading indent). */
function replaceFieldLine(
  source: string,
  valueSpan: { start: number; end: number },
  lineText: string
): string {
  let lineStart = valueSpan.start
  while (lineStart > 0 && source[lineStart - 1] !== '\n') {
    lineStart -= 1
  }
  let lineEnd = valueSpan.end
  while (lineEnd < source.length && source[lineEnd] !== '\n') {
    lineEnd += 1
  }
  const indent = source.slice(lineStart, valueSpan.start).match(/^(\s*)/)?.[1] ?? ''
  return source.slice(0, lineStart) + indent + lineText + source.slice(lineEnd)
}

function buildFsfBody(scenarios: FsfScenarioDto[], others?: string): string {
  const lines = scenarios.map((s) => `${s.test.trim()} && ${s.def.trim()}`)
  if (others?.trim()) {
    lines.push(`others && ${others.trim()}`)
  }
  return lines.map((line, i) => (i < lines.length - 1 ? `${line} ||` : line)).join('\n')
}

function fsfPatchSpan(source: string, fsf: { span: { start: number; end: number } }): {
  start: number
  end: number
} {
  // Include the `FSF :` / `FSF:` header (any whitespace before the first scenario).
  // Previously only matched `FSF :` within 8 chars, duplicating the header when the
  // body started on an indented next line.
  const before = source.slice(Math.max(0, fsf.span.start - 64), fsf.span.start)
  const m = /FSF\s*:\s*$/.exec(before)
  if (m) {
    return { start: fsf.span.start - before.length + m.index, end: fsf.span.end }
  }
  return fsf.span
}

export function patchFsfSpec(
  source: string,
  processName: string,
  scenarios: FsfScenarioDto[],
  others?: string
): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const proc = findProcess(ast, processName)
  const fsf = proc?.body?.fsf
  if (!fsf) {
    return patchProcessCondition(source, processName, 'post', scenariosToPost(scenarios, others))
  }
  const block = `FSF :\n${buildFsfBody(scenarios, others)}`
  return replaceSpan(source, fsfPatchSpan(source, fsf), block)
}

function scenariosToPost(scenarios: FsfScenarioDto[], others?: string): string {
  const normal = scenarios.filter((s) => s.kind !== 'exceptional')
  if (normal.length === 0) return others?.trim() || 'true'
  if (normal.length === 1) {
    const s = normal[0]!
    return `if ${s.guard || s.test} then ${s.definingCondition || s.def}`
  }
  return normal
    .map((s, i) => {
      const g = s.guard || s.test
      const d = s.definingCondition || s.def
      if (i === 0) return `if ${g} then ${d}`
      if (i === normal.length - 1) return `else ${d}`
      return `else if ${g} then ${d}`
    })
    .join(' ')
}

function isBareKeywordAt(source: string, index: number, keyword: string): boolean {
  if (source.slice(index, index + keyword.length) !== keyword) return false
  const before = index === 0 ? '\n' : source[index - 1]!
  const after = source[index + keyword.length] ?? '\n'
  return /\s/.test(before) && /\s/.test(after)
}

function conditionKeywordStart(source: string, which: 'pre' | 'post', clauseStart: number): number {
  const windowStart = Math.max(0, clauseStart - 64)
  const prefix = source.slice(windowStart, clauseStart)
  const re = new RegExp(`(?:^|\\n)[ \\t]*(${which})(?=\\s|$)`, 'g')
  let match: RegExpExecArray | null
  let last = -1
  while ((match = re.exec(prefix)) !== null) {
    last = windowStart + (match.index ?? 0) + match[0].lastIndexOf(which)
  }
  if (last >= 0) return last
  const header = source.lastIndexOf(which, clauseStart)
  if (header >= 0 && clauseStart - header <= 48 && isBareKeywordAt(source, header, which)) return header
  return clauseStart
}

export function patchProcessCondition(
  source: string,
  processName: string,
  which: 'pre' | 'post',
  text: string
): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const proc = findProcess(ast, processName)
  if (!proc) return source
  const clause = which === 'pre' ? proc.body?.pre : proc.body?.post
  const block = `${which}\n    ${text.trim() || 'true'}`
  if (clause && clause.span.end > clause.span.start) {
    const start = conditionKeywordStart(source, which, clause.span.start)
    return replaceSpan(source, { start, end: clause.span.end }, block)
  }
  const insertAt =
    (which === 'post' && proc.body?.pre ? proc.body.pre.span.end : undefined) ??
    proc.body?.ext.at(-1)?.span.end ??
    proc.body?.fsf?.span.start ??
    proc.body?.span.start ??
    proc.span.end
  return source.slice(0, insertAt) + `\n    ${block}` + source.slice(insertAt)
}

export function patchComment(source: string, processName: string, text: string): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const proc = findProcess(ast, processName)
  if (!proc?.body) return source
  const replacement = `comment: ${text}`
  if (proc.body.comment) {
    return replaceFieldLine(source, textSpan(proc.body.comment), replacement)
  }
  const insertAt = proc.body.fsf?.span.end ?? proc.body.ext.at(-1)?.span.end ?? proc.span.end
  return source.slice(0, insertAt) + `\n${replacement}` + source.slice(insertAt)
}

export function patchDecom(source: string, processName: string, text: string): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const proc = findProcess(ast, processName)
  if (!proc?.body) return source
  const replacement = `decom: ${text}`
  if (proc.body.decomposition) {
    return replaceFieldLine(source, textSpan(proc.body.decomposition), replacement)
  }
  const insertAt = proc.body.fsf?.span.end ?? proc.body.ext.at(-1)?.span.end ?? proc.span.end
  return source.slice(0, insertAt) + `\n${replacement}` + source.slice(insertAt)
}

export function patchInformal(
  source: string,
  span: { start: number; end: number },
  text: string
): string {
  return replaceSpan(source, span, text)
}

export function patchInvariant(
  source: string,
  span: { start: number; end: number },
  text: string
): string {
  return replaceSpan(source, span, text.trim())
}

export function formatDocument(source: string): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  return printProgram(ast)
}

function textSpan(field: { span: Span } | string | undefined): Span {
  if (!field || typeof field === 'string') {
    return { start: 0, end: 0, line: 1, column: 1 }
  }
  return field.span
}

export function patchProcessCommentFromAst(ast: ProgramNode, source: string, processName: string, text: string): string {
  void ast
  return patchComment(source, processName, text)
}

function pushInformalFromPredicate(
  spans: Array<{
    processName: string
    field: 'comment' | 'decom' | 'fsf'
    text: string
    span: { start: number; end: number }
  }>,
  processName: string,
  pred: { disjuncts?: Array<{ atoms?: Array<{ type: string; text?: string; span: Span }> }> } | undefined
): void {
  if (!pred) return
  for (const conj of pred.disjuncts ?? []) {
    for (const a of conj.atoms ?? []) {
      if (a.type === 'informal_text' && a.text) {
        spans.push({ processName, field: 'fsf', text: a.text, span: a.span })
      }
    }
  }
}

export function getInformalSpans(source: string, ast: ProgramNode) {
  const spans: Array<{
    processName: string
    field: 'comment' | 'decom' | 'fsf'
    text: string
    span: { start: number; end: number }
  }> = []
  for (const mod of ast.modules) {
    for (const proc of mod.processes) {
      if (proc.body?.comment && textOf(proc.body.comment)) {
        spans.push({
          processName: proc.name,
          field: 'comment',
          text: textOf(proc.body.comment)!,
          span: textSpan(proc.body.comment)
        })
      }
      if (textOf(proc.body?.decomposition)) {
        spans.push({
          processName: proc.name,
          field: 'decom',
          text: textOf(proc.body!.decomposition)!,
          span: textSpan(proc.body!.decomposition)
        })
      }
      const fsf = proc.body?.fsf
      if (fsf) {
        for (const scen of fsf.scenarios) {
          pushInformalFromPredicate(spans, proc.name, scen.test)
        }
        pushInformalFromPredicate(spans, proc.name, fsf.others)
      }
    }
  }
  void source
  return spans
}

/**
 * Replace (or insert) the whole `FSF :` clause of a process with final-grammar FSF text
 * `T1 && D1 || … || others && Dn`. Existing pre/post clauses are left untouched.
 */
export function patchProcessFsfText(source: string, processName: string, fsfText: string, moduleName?: string): string {
  const { ast } = parse(source)
  if (!ast || ast.type !== 'program') return source
  const proc = moduleName
    ? ast.modules.find((m) => namesEqual(m.name, moduleName))?.processes.find((p) => p.name === processName)
    : findProcess(ast, processName)
  if (!proc) return source
  let body = fsfText.trim().replace(/^FSF\s*:\s*/i, '')
  const labelled = /^([^:\n]+)\s*:\s*([\s\S]*)$/.exec(body)
  if (labelled?.[1]?.trim() === processName) body = labelled[2]!.trim()
  const block = `FSF :\n    ${body}`
  const fsf = proc.body?.fsf
  if (fsf) return replaceSpan(source, fsfPatchSpan(source, fsf), block)
  const slice = source.slice(proc.span.start, proc.span.end)
  const m = /\n([ \t]*)(?:decom\s*:|comment\s*:|end_process)/.exec(slice)
  if (!m) return source
  const at = proc.span.start + m.index
  return source.slice(0, at) + `\n${m[1] || '    '}${block}` + source.slice(at)
}
