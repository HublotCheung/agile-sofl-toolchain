/**
 * Studio default: tolerate incomplete specs during Informal → Hybrid refinement.
 * Downgrades selected checker errors to warnings unless hybrid FSF strict mode is on.
 */

const REFINEMENT_WARNING_CODES = new Set([
  'VISUAL_DUPLICATE_NAME',
  'ASFL_PARSE_001',
  'ASFL_LEX_001',
  'ASFL_SCOPE_001',
  'ASFL_SCOPE_002',
  'ASFL_TYPE_001',
  'ASFL_TYPE_002',
  'ASFL_TYPE_003',
  'ASFL_CDFD_001',
  'ASFL_CDFD_002',
  'ASFL_CDFD_003',
  'ASFL_CDFD_004',
  'ASFL_CDFD_005',
  'ASFL_CDFD_007',
  'ASFL_CDFD_008',
  'ASFL_CDFD_009',
  'ASFL_CDFD_010',
  'ASFL_CDFD_011',
  'ASFL_CDFD_012',
  'ASFL_DATA_002',
  'ASFL_DATA_003',
  'ASFL_DATA_004',
  'ASFL_REFINE_001'
])

const REFINEMENT_WARNING_PREFIXES = ['ASFL_FSF_1', 'ASFL_FSF_2']

function shouldDowngrade(code: string, hybridFsfStrict: boolean): boolean {
  if (hybridFsfStrict) return false
  if (REFINEMENT_WARNING_CODES.has(code)) return true
  return REFINEMENT_WARNING_PREFIXES.some((p) => code.startsWith(p))
}

export function adjustRefinementDiagnosticSeverity<T extends { code: string; severity: string }>(
  diagnostics: T[],
  hybridFsfStrict: boolean
): T[] {
  if (hybridFsfStrict) return diagnostics
  return diagnostics.map((d) => {
    if (d.severity !== 'error') return d
    if (!shouldDowngrade(d.code, hybridFsfStrict)) return d
    return { ...d, severity: 'warning' }
  })
}

/** True when any diagnostic remains at error severity after refinement adjustment. */
export function hasBlockingHybridDiagnostics(
  diagnostics: Array<{ severity: string; code: string }>,
  hybridFsfStrict: boolean
): boolean {
  return adjustRefinementDiagnosticSeverity(diagnostics, hybridFsfStrict).some(
    (d) => d.severity === 'error'
  )
}
