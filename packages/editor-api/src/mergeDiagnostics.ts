import type { SerializableSpan } from './span.js'

export type DiagnosticSource = 'parse' | 'fsf' | 'lsp'

export type MergedDiagnostic = {
  code: string
  message: string
  severity: string
  span: SerializableSpan
  source: DiagnosticSource
}

function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, ' ')
}

function spansOverlap(a: SerializableSpan, b: SerializableSpan): boolean {
  return a.start < b.end && b.start < a.end
}

function isDuplicateVisualAndLsp(visual: MergedDiagnostic, lsp: MergedDiagnostic): boolean {
  if (visual.span.line !== lsp.span.line) return false
  if (!spansOverlap(visual.span, lsp.span)) return false
  const va = normalizeMessage(visual.message)
  const vb = normalizeMessage(lsp.message)
  if (va === vb) return true
  return va.includes(vb) || vb.includes(va)
}

function inferSource(code: string, explicit?: DiagnosticSource): DiagnosticSource {
  if (explicit) return explicit
  if (code.startsWith('ASFL_FSF') || code.includes('FSF')) return 'fsf'
  return 'parse'
}

function severityRank(severity: string): number {
  if (severity === 'error') return 3
  if (severity === 'warning') return 2
  if (severity === 'info') return 1
  return 0
}

export function adjustFsfDiagnosticSeverity<T extends { code: string; severity: string }>(
  diagnostics: T[],
  hybridFsfStrict: boolean
): T[] {
  if (!hybridFsfStrict) return diagnostics
  return diagnostics.map((d) => {
    if (d.code === 'ASFL_FSF_001' && d.severity === 'warning') {
      return { ...d, severity: 'error' }
    }
    return d
  })
}

export {
  adjustRefinementDiagnosticSeverity,
  hasBlockingHybridDiagnostics
} from './refinementLint.js'

/** Merge visual (parse/fsf) diagnostics with LSP markers, dropping near-duplicate LSP entries. */
export function mergeDiagnostics(
  visual: Array<{
    code: string
    message: string
    severity: string
    span: SerializableSpan
    source?: DiagnosticSource
  }>,
  lsp: Array<{
    code: string
    message: string
    severity: string
    span: SerializableSpan
  }>
): MergedDiagnostic[] {
  const base: MergedDiagnostic[] = visual.map((d) => ({
    code: d.code,
    message: d.message,
    severity: d.severity,
    span: d.span,
    source: inferSource(d.code, d.source)
  }))

  for (const item of lsp) {
    const candidate: MergedDiagnostic = {
      code: item.code || 'LSP',
      message: item.message,
      severity: item.severity,
      span: item.span,
      source: 'lsp'
    }
    if (base.some((existing) => isDuplicateVisualAndLsp(existing, candidate))) continue
    base.push(candidate)
  }

  return base.sort((a, b) => {
    const sd = severityRank(b.severity) - severityRank(a.severity)
    if (sd !== 0) return sd
    if (a.span.line !== b.span.line) return a.span.line - b.span.line
    return a.span.column - b.span.column
  })
}

export function countBySeverity(
  diagnostics: Array<{ severity: string }>
): { error: number; warning: number; info: number } {
  return {
    error: diagnostics.filter((d) => d.severity === 'error').length,
    warning: diagnostics.filter((d) => d.severity === 'warning').length,
    info: diagnostics.filter((d) => d.severity === 'info').length
  }
}
