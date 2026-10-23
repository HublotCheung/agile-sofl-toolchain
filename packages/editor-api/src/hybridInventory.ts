import type { FsfModelDto, FsfScenarioDto } from './fsfModel.js'
import {
  formatHybridId,
  namesEqual,
  uniqueSlug
} from './hybridIds.js'
import { findModuleRange, hybridLeftoverMessage, listModuleHeaders, scanModuleInvariants, scanModuleProcesses } from './moduleSourceRange.js'
import { buildVisualModelTolerant, type VisualModelResult, type VisualParseDiagnostic } from './visualParse.js'

function clip(text: string, n: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= n) return compact
  return `${compact.slice(0, Math.max(0, n - 1))}…`
}

export type HybridAgentDiagnostic = {
  severity: string
  code: string
  source: VisualParseDiagnostic['source']
  module: string | null
  line: number
  column: number
  message: string
}

function moduleNameForOffset(modules: VisualModelResult['modules'], start: number): string | null {
  let best: { name: string; start: number } | null = null
  for (const mod of modules) {
    if (start >= mod.span.start && start <= mod.span.end) {
      if (!best || mod.span.start >= best.start) best = { name: mod.name, start: mod.span.start }
    }
  }
  return best?.name ?? null
}

function diagnosticsFromModel(model: VisualModelResult): HybridAgentDiagnostic[] {
  const rank = (severity: string) =>
    severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
  return model.diagnostics
    .filter((d) => {
      if (d.severity === 'error') return true
      // Incomplete specs without cdfd/retrieve are expected; keep agent inventory clean.
      return d.code !== 'ASFL_CDFD_001' && d.code !== 'ASFL_DATA_001' && d.code !== 'ASFL_DATA_005'
    })
    .map((d) => ({
      severity: d.severity,
      code: d.code,
      source: d.source,
      module: moduleNameForOffset(model.modules, d.span.start),
      line: d.span.line,
      column: d.span.column,
      message: d.message
    }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.line - b.line || a.column - b.column)
}

export function collectHybridAgentDiagnostics(source: string): HybridAgentDiagnostic[] {
  if (!source.trim()) return []
  return diagnosticsFromModel(buildVisualModelTolerant(source))
}

export function formatHybridDiagnostics(
  sourceOrItems: string | HybridAgentDiagnostic[],
  maxChars = 4000
): string {
  const items = typeof sourceOrItems === 'string' ? collectHybridAgentDiagnostics(sourceOrItems) : sourceOrItems
  if (!items.length) return '(no hybrid diagnostics)'
  const errors = items.filter((d) => d.severity === 'error').length
  const lines = [
    `## Diagnostics (${items.length}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''})`
  ]
  for (const d of items) {
    const mod = d.module ? `mod:${d.module}` : 'document'
    lines.push(`- ${d.severity} [${d.source}/${d.code}] ${mod} L${d.line}:C${d.column} — ${d.message}`)
  }
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…(truncated)`
}

function processScenarios(
  fsfModels: FsfModelDto[],
  moduleName: string,
  processName: string
): FsfScenarioDto[] {
  const model = fsfModels.find(
    (m) =>
      !m.functionName &&
      m.processName === processName &&
      namesEqual(m.moduleName ?? '', moduleName)
  )
  if (!model) return []
  const listed = [...model.scenarios]
  for (const extra of model.exceptionalScenarios ?? []) {
    if (!listed.some((s) => s.id === extra.id)) listed.push(extra)
  }
  return listed
}

function scenarioLabel(scenario: FsfScenarioDto, indexInKind: number): string {
  const named = scenario.name?.trim()
  if (named) return named
  if (scenario.kind === 'exceptional') return `Exceptional${indexInKind}`
  return indexInKind === 1 ? 'Success' : `Success${indexInKind}`
}

function formatModuleInventory(model: VisualModelResult, mod: VisualModelResult['modules'][0]): string[] {
  const lines: string[] = []
  const role = mod.isSystem ? ' system' : mod.parentName ? ` / ${mod.parentName}` : ''
  lines.push(`## Module ${formatHybridId('mod', mod.name)} [${mod.name}]${role}`)

  for (const t of mod.types) {
    const fields = t.fields?.length
      ? `fields: ${t.fields.map((f) => `${f.name}: ${f.type}`).join(', ')}`
      : t.text
    const desc = fields ? ` — ${clip(fields, 240)}` : ''
    lines.push(`- ${formatHybridId('type', mod.name, t.name)} (type) ${t.name}${desc}`)
  }

  for (const v of mod.vars) {
    const desc = v.text ? ` — ${clip(v.text, 240)}` : ''
    lines.push(`- ${formatHybridId('var', mod.name, v.name)} (var) ${v.name}${desc}`)
  }

  for (const c of mod.consts) {
    const desc = c.text ? ` — ${clip(c.text, 240)}` : ''
    lines.push(`- ${formatHybridId('const', mod.name, c.name)} (const) ${c.name}${desc}`)
  }

  for (let i = 0; i < mod.invariants.length; i++) {
    const inv = mod.invariants[i]!
    lines.push(`- ${formatHybridId('inv', mod.name, String(i))} (inv) ${clip(inv.text, 240)}`)
  }

  for (const proc of mod.processes) {
    lines.push(`- ${formatHybridId('proc', mod.name, proc.name)} (process) ${proc.name}`)
    if (proc.signature) lines.push(`  signature: ${clip(proc.signature, 200)}`)
    if (proc.pre) lines.push(`  pre: ${clip(proc.pre, 200)}`)
    if (proc.post) lines.push(`  post: ${clip(proc.post, 200)}`)
    if (proc.comment) lines.push(`  comment: ${clip(proc.comment, 200)}`)
    const scenarios = processScenarios(model.fsfModels, mod.name, proc.name)
    const used = new Set<string>()
    let normalIndex = 0
    let exceptionalIndex = 0
    for (const scenario of scenarios) {
      if (scenario.kind === 'exceptional') exceptionalIndex += 1
      else normalIndex += 1
      const indexInKind = scenario.kind === 'exceptional' ? exceptionalIndex : normalIndex
      const label = scenarioLabel(scenario, indexInKind)
      const idName = uniqueSlug(label, used)
      const guard = clip(scenario.guard || scenario.test || '', 80)
      const def = clip(scenario.definingCondition || scenario.def || '', 80)
      const detail = [guard, def].filter(Boolean).join(' / ')
      const desc = detail ? ` — ${detail}` : ''
      lines.push(`  - ${formatHybridId('scn', mod.name, proc.name, idName)} (scenario) ${label}${desc}`)
    }
  }

  for (const fn of mod.functions) {
    const sig = fn.signature ? ` — ${clip(fn.signature, 200)}` : ''
    lines.push(`- ${formatHybridId('fn', mod.name, fn.name)} (function) ${fn.name}${sig}`)
  }

  if (mod.gui) {
    const guiName = mod.gui.name || `${mod.name}_GUI`
    for (const screen of mod.gui.screens) {
      const desc = screen.triggersProcess ? ` → ${screen.triggersProcess}` : ''
      lines.push(`- ${formatHybridId('gui', guiName, screen.name)} (gui-screen) ${screen.name}${desc}`)
    }
  }

  return lines
}

export function formatHybridInventory(source: string, maxChars = 12000): string {
  if (!source.trim() || /^[.;\s]*$/.test(source.trim())) return '(empty hybrid specification)'
  const leftover = hybridLeftoverMessage(source)
  const model = buildVisualModelTolerant(source)
  overlaySourceInventory(source, model)
  const diagnostics = formatHybridDiagnostics(diagnosticsFromModel(model), 3500)
  const hasIssues = diagnostics !== '(no hybrid diagnostics)'
  if (!model.modules.length) {
    const parts = [
      hasIssues ? diagnostics : '',
      leftover
        ? `${leftover}. Do not treat this as empty — fix with propose_hybrid_changes or a unique propose_source_edit.`
        : hasIssues
          ? ''
          : '(empty hybrid specification)'
    ].filter(Boolean)
    return parts.join('\n\n') || '(empty hybrid specification)'
  }
  const lines: string[] = []
  for (const mod of model.modules) {
    lines.push(...formatModuleInventory(model, mod))
    lines.push('')
  }
  const inventory = lines.join('\n').trim() || '(empty hybrid specification)'
  const text = hasIssues ? `${diagnostics}\n\n${inventory}` : inventory
  if (text.length <= maxChars) return text
  if (hasIssues) {
    const budget = Math.max(0, maxChars - diagnostics.length - 20)
    return `${diagnostics}\n\n${inventory.slice(0, budget)}\n…(truncated)`
  }
  return `${text.slice(0, maxChars)}\n…(truncated)`
}

function overlaySourceInventory(source: string, model: VisualModelResult): void {
  const headers = listModuleHeaders(source)
  for (const header of headers) {
    const range = findModuleRange(source, header.name)
    if (!range) continue
    let mod = model.modules.find((m) => namesEqual(m.name, header.name))
    if (!mod) {
      mod = {
        name: header.name,
        isSystem: false,
        span: { start: range.start, end: range.end, line: 1, column: 1 },
        constCount: 0,
        typeCount: 0,
        varCount: 0,
        invCount: 0,
        invariants: [],
        processes: [],
        functions: [],
        consts: [],
        types: [],
        vars: []
      }
      model.modules.push(mod)
    }
    if (!mod.processes.length) {
      for (const name of scanModuleProcesses(source, range)) {
        mod.processes.push({
          name,
          span: { start: range.start, end: range.end, line: 1, column: 1 },
          decom: '',
          comment: '',
          hasFsf: false,
          isAlias: false,
          isInit: name === 'Init',
          signature: '',
          inputs: [],
          outputs: [],
          ext: [],
          fsfFormal: null,
          pre: '',
          post: '',
          hasPre: false,
          hasPost: false,
          scenarioCount: 0,
          exceptionalCount: 0,
          formalizationStatus: 'semi-formal'
        })
      }
    }
    if (!mod.invariants.length) {
      for (const text of scanModuleInvariants(source, range)) {
        mod.invariants.push({
          text,
          span: { start: range.start, end: range.end, line: 1, column: 1 }
        })
      }
      mod.invCount = mod.invariants.length
    }
  }
}

export function hybridInventoryFromSource(source: string, maxChars = 12000): string {
  return formatHybridInventory(source, maxChars)
}
