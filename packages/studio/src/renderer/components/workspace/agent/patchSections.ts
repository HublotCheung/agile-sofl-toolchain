export type PatchSectionItem = {
  index: number
  op: Record<string, unknown>
}

export type PatchSection = {
  id: string
  items: PatchSectionItem[]
}

const SECTION_ALIAS: Record<string, string> = {
  function: 'functions',
  functions: 'functions',
  'data-resource': 'data',
  'data-resources': 'data',
  'data-field': 'data',
  data: 'data',
  constraint: 'constraints',
  constraints: 'constraints'
}

const SOURCE_OPS = new Set([
  'replace',
  'append',
  'replace-document',
  'replace-process-body',
  'replace-html',
  'replace-screen-html',
  'insert-html'
])

const PREFERRED = ['functions', 'data', 'constraints']

export function patchSectionId(op: Record<string, unknown>): string {
  const node = op.node as { type?: string } | undefined
  for (const raw of [node?.type, op.kind, op.target]) {
    const key = String(raw ?? '').trim().toLowerCase()
    const aliased = SECTION_ALIAS[key]
    if (aliased) return aliased
  }
  const kind = String(node?.type ?? op.kind ?? '').trim().toLowerCase()
  if (kind && kind !== 'text') return kind
  const name = String(op.op ?? '').trim().toLowerCase()
  if (SOURCE_OPS.has(name)) return 'source'
  return 'other'
}

/** Large groups start collapsed so Apply and Reject stay in view. */
export function sectionStartsOpen(count: number): boolean {
  return count <= 3
}

export function groupPatchOperations(operations: Array<Record<string, unknown>>): PatchSection[] {
  const buckets = new Map<string, PatchSectionItem[]>()
  operations.forEach((op, index) => {
    const id = patchSectionId(op)
    const item = { index, op }
    const list = buckets.get(id)
    if (list) list.push(item)
    else buckets.set(id, [item])
  })
  const rest = [...buckets.keys()].filter((id) => !PREFERRED.includes(id))
  const ids = [...PREFERRED.filter((id) => buckets.has(id)), ...rest]
  return ids.map((id) => ({ id, items: buckets.get(id)! }))
}
