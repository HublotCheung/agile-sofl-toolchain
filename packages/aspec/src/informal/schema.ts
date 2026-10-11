export type InformalSectionType = 'functions' | 'data-resources' | 'constraints'

export type InformalNodeType = 'function' | 'data-resource' | 'data-field' | 'constraint' | 'text'

export interface InformalSectionDefinition {
  id: InformalSectionType
  title: string
  type: InformalSectionType
  required: boolean
  allowChildren: boolean
  order: number
  childType: InformalNodeType
  grandchildType?: InformalNodeType
}

export const DEFAULT_INFORMAL_SECTIONS: InformalSectionDefinition[] = [
  {
    id: 'functions',
    title: 'Functions',
    type: 'functions',
    required: true,
    allowChildren: true,
    order: 1,
    childType: 'function',
    grandchildType: 'function'
  },
  {
    id: 'data-resources',
    title: 'Data Resources',
    type: 'data-resources',
    required: true,
    allowChildren: true,
    order: 2,
    childType: 'data-resource',
    grandchildType: 'data-field'
  },
  {
    id: 'constraints',
    title: 'Constraints',
    type: 'constraints',
    required: true,
    allowChildren: true,
    order: 3,
    childType: 'constraint'
  }
]

const TITLE_ALIASES: Record<string, InformalSectionType> = {
  functions: 'functions',
  function: 'functions',
  fn: 'functions',
  功能: 'functions',
  'data resources': 'data-resources',
  'data-resources': 'data-resources',
  dataresources: 'data-resources',
  data: 'data-resources',
  数据: 'data-resources',
  '数据资源': 'data-resources',
  constraints: 'constraints',
  constraint: 'constraints',
  约束: 'constraints'
}

export function sectionTypeFromTitle(title: string): InformalSectionType | null {
  const cleaned = title.replace(/^#+\s*/, '').trim().toLowerCase()
  return TITLE_ALIASES[cleaned] ?? TITLE_ALIASES[cleaned.replace(/_/g, '-')] ?? null
}

export function resolveSectionRef(raw: string | undefined): InformalSectionType | string | undefined {
  if (!raw) return undefined
  return sectionTypeFromTitle(raw) ?? raw.trim()
}

export function sectionTypeForNodeType(type: InformalNodeType): InformalSectionType {
  if (type === 'data-resource' || type === 'data-field') return 'data-resources'
  if (type === 'constraint') return 'constraints'
  return 'functions'
}

export function normalizeInformalNodeType(
  raw: unknown,
  fallback: InformalNodeType = 'function'
): InformalNodeType {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (s === 'function' || s === 'functions' || s === 'fn' || s === '功能') return 'function'
  if (
    s === 'data-resource' ||
    s === 'data-resources' ||
    s === 'data' ||
    s === 'resource' ||
    s === '数据' ||
    s === '数据资源'
  ) {
    return 'data-resource'
  }
  if (s === 'data-field' || s === 'field' || s === 'fields') return 'data-field'
  if (s === 'constraint' || s === 'constraints' || s === '约束') return 'constraint'
  if (s === 'text') return 'text'
  return fallback
}

export function sectionDef(type: InformalSectionType): InformalSectionDefinition {
  return DEFAULT_INFORMAL_SECTIONS.find((s) => s.id === type)!
}

/** Heading depth is unlimited. H2 is the section child; every deeper heading keeps the grandchild type. */
export function nodeTypeForLevel(
  section: InformalSectionType,
  headingLevel: number
): InformalNodeType {
  const def = sectionDef(section)
  if (headingLevel <= 2) return def.childType
  return def.grandchildType ?? def.childType
}
