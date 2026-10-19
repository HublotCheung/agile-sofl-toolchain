import { linkBaseline, type TraceDocument, type TraceLink, type TraceSide } from './traceability'

/** Notifications belong to the receiving side, and only describe upstream changes. */
export function traceNotification(doc: TraceDocument, link: TraceLink, receiving: TraceSide): boolean {
  if (link.review === 'rejected') return false
  const upstream = receiving === 'informal' ? 'hybrid' : 'informal'
  const endpoint = doc.entities.find(e => e.id === (upstream === 'informal' ? link.source : link.target))
  if (!endpoint?.present) return false
  const current = linkBaseline(doc, link)[upstream]
  return current !== link.baseline[upstream] && current !== link.acknowledged?.[receiving]?.[upstream]
}

export interface GeneratedTraceLink { sourceId: string; targetId: string; relation?: string }

/** Resolve provenance against the post-patch index before allowing any source write. */
export function bindGeneratedTrace(before: TraceDocument, after: TraceDocument, links: GeneratedTraceLink[], sourcePath: string, targetPath: string, id: () => string): void {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const inFile = (path: string | undefined, expected: string) => !path || normalize(path) === normalize(expected) || normalize(expected).endsWith('/' + normalize(path))
  for (const input of links) {
    const source = after.entities.filter(e => e.present && e.side === 'informal' && e.locator === input.sourceId && inFile(e.documentPath, sourcePath))
    const target = after.entities.filter(e => e.present && e.side === 'hybrid' && e.locator === input.targetId && inFile(e.documentPath, targetPath))
    if (source.length !== 1 || target.length !== 1) throw new Error(`Generation provenance is unresolved: ${input.sourceId} → ${input.targetId}. Return exact source and target IDs before applying.`)
    if (after.links.some(l => l.source === source[0].id && l.target === target[0].id && l.review !== 'rejected')) continue
    const endpoints = { source: source[0].id, target: target[0].id }
    after.links.push({ ...endpoints, id: id(), relation: input.relation === 'constrains' ? 'constrains' : input.relation === 'uses' ? 'uses' : 'refines', origin: 'generated', review: 'confirmed', reason: 'Recorded with the applied modeling operation.', baseline: linkBaseline(after, endpoints) })
  }
  // Scenarios and declarations inherit explicit owner/dependency provenance, never a fuzzy name match.
  for (const entity of after.entities.filter(e => e.present && e.side === 'hybrid' && inFile(e.documentPath, targetPath))) {
    if (before.entities.some(e => e.id === entity.id && e.present) || entity.kind === 'module') continue
    if (after.links.some(l => l.target === entity.id && l.review !== 'rejected')) continue
    const owners = after.entities.filter(e => e.side === 'hybrid' && e.present && (e.dependencies.includes(entity.id) || (entity.kind === 'scenario' && entity.parent === e.locator)))
    const inherited = after.links.filter(l => l.review !== 'rejected' && owners.some(e => e.id === l.target))
    for (const owner of inherited) {
      const endpoints = { source: owner.source, target: entity.id }
      after.links.push({ ...endpoints, id: id(), relation: entity.kind === 'scenario' ? 'refines' : 'uses', origin: 'generated', review: 'confirmed', reason: 'Inherited from the modeled process dependency.', baseline: linkBaseline(after, endpoints) })
    }
    if (!inherited.length) throw new Error(`Missing generation provenance for ${entity.locator}. Include its Informal source ID in traceLinks; existing nodes keep their links.`)
  }
}
