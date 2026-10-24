import { createDiagnostic, DiagnosticCodes } from '../diagnostics/codes.js'
import type { AspecDiagnostic } from '../model.js'
import { walkTree, type InformalSpecification } from './model.js'
import { DEFAULT_INFORMAL_SECTIONS } from './schema.js'

export function validateInformalSpec(spec: InformalSpecification): AspecDiagnostic[] {
  const diagnostics: AspecDiagnostic[] = []
  const seen = new Set<string>([spec.id])

  for (const def of DEFAULT_INFORMAL_SECTIONS) {
    if (def.required && !spec.sections.some((s) => s.type === def.id)) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.INFORMAL_MISSING_SECTION,
          `Required section "${def.title}" is missing.`,
          'warning',
          def.id
        )
      )
    }
  }

  const unknown = spec.sections.filter(
    (s) => !DEFAULT_INFORMAL_SECTIONS.some((d) => d.id === s.type)
  )
  for (const section of unknown) {
    diagnostics.push(
      createDiagnostic(
        DiagnosticCodes.INFORMAL_UNKNOWN_SECTION,
        `Unknown section "${section.title}".`,
        'error',
        section.id
      )
    )
  }

  walkTree(spec, (node) => {
    if (seen.has(node.id)) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.STYLE_DUPLICATE_ID,
          `Duplicate informal node id "${node.id}".`,
          'error',
          node.id
        )
      )
    }
    seen.add(node.id)
    if (!node.title.trim()) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.INFORMAL_EMPTY_TITLE,
          'Specification nodes must have a title.',
          'error',
          node.id
        )
      )
    }
  })

  return diagnostics
}
