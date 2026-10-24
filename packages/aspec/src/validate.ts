import type { AspecDocument, AspecDiagnostic } from './model.js'
import { createDiagnostic, DiagnosticCodes } from './diagnostics/codes.js'

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function validateStructure(document: AspecDocument, diagnostics: AspecDiagnostic[]): void {
  if (document.aspecVersion !== '1.0') {
    diagnostics.push(
      createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, 'aspecVersion must be "1.0"', 'error', 'aspecVersion')
    )
  }
  if (!document.meta || !isNonEmptyString(document.meta.id) || !isNonEmptyString(document.meta.title)) {
    diagnostics.push(
      createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, 'meta.id and meta.title are required', 'error', 'meta')
    )
  }
  if (!document.system || !isNonEmptyString(document.system.name)) {
    diagnostics.push(
      createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, 'system.name is required', 'error', 'system.name')
    )
  }
  if (!Array.isArray(document.modules)) {
    diagnostics.push(
      createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, 'modules must be an array', 'error', 'modules')
    )
    return
  }
  for (const mod of document.modules) {
    if (!isNonEmptyString(mod.id) || !isNonEmptyString(mod.name)) {
      diagnostics.push(
        createDiagnostic(DiagnosticCodes.SCHEMA_ERROR, 'module id and name are required', 'error', `modules.${mod.id}`)
      )
    }
  }
}

import { validateBookAlign } from './validateBookAlign.js'

export function validateAspec(document: AspecDocument, options?: { bookAlignStrict?: boolean }): AspecDiagnostic[] {
  const diagnostics: AspecDiagnostic[] = []
  validateStructure(document, diagnostics)

  const purpose = document.system?.purpose?.trim()
  if (!purpose) {
    diagnostics.push(
      createDiagnostic(DiagnosticCodes.STYLE_NO_PURPOSE, 'system.purpose is required', 'warning', 'system.purpose')
    )
  }

  for (const mod of document.modules) {
    if (!mod.description?.trim()) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.STYLE_NO_MODULE_DESC,
          `Module '${mod.name}' missing description`,
          'warning',
          `modules.${mod.id}.description`
        )
      )
    }
    for (const proc of mod.processes ?? []) {
      const hasScenarios = (proc.scenarios?.length ?? 0) > 0
      const hasDesc = Boolean(proc.description?.trim())
      if (!hasScenarios && !hasDesc) {
        diagnostics.push(
          createDiagnostic(
            DiagnosticCodes.STYLE_NO_PROCESS_DESC,
            `Process '${proc.name}' has no scenarios or description`,
            'warning',
            `modules.${mod.id}.processes.${proc.id}`
          )
        )
      }
      const bottom = proc.refinementHints?.bottomLevel ?? false
      if (!bottom && !proc.decomposition?.trim()) {
        diagnostics.push(
          createDiagnostic(
            DiagnosticCodes.STYLE_NO_DECOMP,
            `Non-bottom process '${proc.name}' should have decomposition`,
            'warning',
            `modules.${mod.id}.processes.${proc.id}.decomposition`
          )
        )
      }
      if (hasScenarios && !proc.scenarios!.some((s) => s.condition.toLowerCase().includes('other'))) {
        diagnostics.push(
          createDiagnostic(
            DiagnosticCodes.STYLE_NO_OTHERS,
            `Process '${proc.name}' has no explicit others scenario (will be added on refine)`,
            'info',
            `modules.${mod.id}.processes.${proc.id}.scenarios`
          )
        )
      }
    }
  }

  const seen = new Map<string, string>()
  function track(id: string, path: string) {
    if (seen.has(id)) {
      seen.set(id, `${seen.get(id)!};${path}`)
    } else {
      seen.set(id, path)
    }
  }
  track(document.meta.id, 'meta.id')
  for (const mod of document.modules) {
    track(mod.id, `modules.${mod.id}`)
    for (const t of mod.types ?? []) track(t.id, `modules.${mod.id}.types.${t.id}`)
    for (const c of mod.constants ?? []) track(c.id, `modules.${mod.id}.constants.${c.id}`)
    for (const v of mod.variables ?? []) track(v.id, `modules.${mod.id}.variables.${v.id}`)
    for (const inv of mod.invariants ?? []) track(inv.id, `modules.${mod.id}.invariants.${inv.id}`)
    for (const p of mod.processes ?? []) {
      track(p.id, `modules.${mod.id}.processes.${p.id}`)
      for (const s of p.scenarios ?? []) track(s.id, `modules.${mod.id}.processes.${p.id}.scenarios.${s.id}`)
    }
    for (const f of mod.functions ?? []) track(f.id, `modules.${mod.id}.functions.${f.id}`)
  }
  for (const [id, paths] of seen) {
    if (paths.includes(';')) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.STYLE_DUPLICATE_ID,
          `Duplicate id '${id}' at ${paths}`,
          'error',
          id
        )
      )
    }
  }

  diagnostics.push(...validateBookAlign(document, options?.bookAlignStrict ?? false))

  return diagnostics
}
