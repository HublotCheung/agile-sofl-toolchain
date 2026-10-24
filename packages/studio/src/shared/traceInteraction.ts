import { labelsMatch, uniqueSlug } from '@agile-sofl/editor-api'
import { linkBaseline, type TraceDocument, type TraceEntity, type TraceLink, type TraceSide } from './traceability'

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

/** Bind what can be resolved. Unresolved provenance is a warning; the specification text is still kept. */
export function bindGeneratedTraceSoft(before: TraceDocument, after: TraceDocument, links: GeneratedTraceLink[], sourcePath: string, targetPath: string, id: () => string): { warnings: string[] } {
  const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const inFile = (path: string | undefined, expected: string) => !path || normalize(path) === normalize(expected) || normalize(expected).endsWith('/' + normalize(path))
  const hybrid = after.entities.filter(e => e.present && e.side === 'hybrid' && inFile(e.documentPath, targetPath))
  const isNew = (entity: TraceEntity) => !before.entities.some(e => e.id === entity.id && e.present)
  const unresolved: string[] = []
  for (const input of links) {
    const sourceId = input.sourceId.trim(), targetId = input.targetId.trim()
    // Modules are scaffolding, not trace entities; their members carry provenance.
    if (/^mod:/i.test(targetId)) continue
    let source = after.entities.filter(e => e.present && e.side === 'informal' && e.locator === sourceId && inFile(e.documentPath, sourcePath))
    if (!source.length) source = after.entities.filter(e => e.present && e.side === 'informal' && e.locator.toLowerCase() === sourceId.toLowerCase() && inFile(e.documentPath, sourcePath))
    const target = resolveHybridTarget(hybrid, targetId, isNew)
    if (source.length !== 1 || target.length !== 1) {
      const module = /^[a-z]+:([^.]+)\./i.exec(targetId)?.[1]
      const valid = hybrid.filter(e => e.kind !== 'scenario' && (!module || sameModule(e.parent, module))).map(e => e.locator)
      unresolved.push(`${sourceId} → ${targetId}` + (source.length !== 1 ? ' (unknown Informal sourceId)' : '') + (target.length !== 1 ? ` (valid targets${module ? ' in ' + module : ''}: ${valid.slice(0, 40).join(', ') || 'none'})` : ''))
      continue
    }
    if (after.links.some(l => l.source === source[0].id && l.target === target[0].id && l.review !== 'rejected')) continue
    const endpoints = { source: source[0].id, target: target[0].id }
    after.links.push({ ...endpoints, id: id(), relation: input.relation === 'constrains' ? 'constrains' : input.relation === 'uses' ? 'uses' : 'refines', origin: 'generated', review: 'confirmed', reason: 'Recorded with the applied modeling operation.', baseline: linkBaseline(after, endpoints) })
  }
  // Scenarios and declarations inherit explicit owner/dependency provenance, never a fuzzy name match.
  const missing: string[] = []
  for (const entity of hybrid) {
    if (!isNew(entity) || entity.kind === 'module') continue
    if (after.links.some(l => l.target === entity.id && l.review !== 'rejected')) continue
    const owners = after.entities.filter(e => e.side === 'hybrid' && e.present && (e.dependencies.includes(entity.id) || (entity.kind === 'scenario' && entity.parent === e.locator)))
    const inherited = after.links.filter(l => l.review !== 'rejected' && owners.some(e => e.id === l.target))
    for (const owner of inherited) {
      const endpoints = { source: owner.source, target: entity.id }
      after.links.push({ ...endpoints, id: id(), relation: entity.kind === 'scenario' ? 'refines' : 'uses', origin: 'generated', review: 'confirmed', reason: 'Inherited from the modeled process dependency.', baseline: linkBaseline(after, endpoints) })
    }
    if (!inherited.length) missing.push(entity.locator)
  }
  // Report every problem at once so the agent can repair the whole patch in one retry.
  const problems: string[] = []
  if (unresolved.length) problems.push(`Generation provenance is unresolved: ${unresolved.join('; ')}. Return exact source and target IDs before applying.`)
  if (missing.length) problems.push(`Missing generation provenance for ${missing.join(', ')}. Include its Informal source ID in traceLinks; existing nodes keep their links.`)
  const hint = ' Target IDs: proc:/type:/var:/const:/fn:Module.Name, inv:Module.<zero-based index>; module scaffolding (mod:) needs no link.'
  return { warnings: problems.length ? [problems.join(' ') + hint] : [] }
}

/** Resolve provenance against the post-patch index. Throws when any link cannot be bound. */
export function bindGeneratedTrace(before: TraceDocument, after: TraceDocument, links: GeneratedTraceLink[], sourcePath: string, targetPath: string, id: () => string): void {
  const soft = bindGeneratedTraceSoft(before, after, links, sourcePath, targetPath, id)
  if (soft.warnings.length) throw new Error(soft.warnings.join(' '))
}

/** Exact locator first; then case-insensitive; a named invariant resolves only to the single new invariant of its module. */
function resolveHybridTarget(hybrid: TraceEntity[], targetId: string, isNew: (e: TraceEntity) => boolean): TraceEntity[] {
  const exact = hybrid.filter(e => e.locator === targetId)
  if (exact.length) return exact
  // The parsed model names the system module without its SYSTEM_ prefix.
  const key = canonicalLocator(targetId)
  const folded = hybrid.filter(e => canonicalLocator(e.locator) === key)
  if (folded.length) return folded
  const inv = /^inv:([^.]+)\.(.+)$/i.exec(targetId)
  if (inv) {
    const modName = inv[1]!
    const suffix = inv[2]!
    const inMod = hybrid.filter(e => e.kind === 'invariant' && sameModule(e.parent, modName))
    if (/^\d+$/.test(suffix)) {
      const byIndex = inMod.filter(e => canonicalLocator(e.locator) === canonicalLocator(targetId))
      if (byIndex.length) return byIndex
      const idx = parseInt(suffix, 10)
      const sorted = [...inMod].sort((a, b) => {
        const ai = parseInt(/^inv:[^.]+\.(\d+)$/i.exec(a.locator)?.[1] ?? '0', 10)
        const bi = parseInt(/^inv:[^.]+\.(\d+)$/i.exec(b.locator)?.[1] ?? '0', 10)
        return ai - bi
      })
      if (sorted[idx]) return [sorted[idx]!]
    }
    const fresh = inMod.filter(isNew)
    if (fresh.length === 1) return fresh
    if (fresh.length > 1) {
      const used = new Set<string>()
      for (const e of [...fresh].sort((a, b) => a.locator.localeCompare(b.locator))) {
        const slug = uniqueSlug(e.text.replace(/;$/g, '').trim(), used)
        if (labelsMatch(slug, suffix) || labelsMatch(e.text, suffix)) return [e]
      }
    }
  }
  return []
}
const moduleKey = (name: string) => name.replace(/^SYSTEM_/i, '').toLowerCase()
const sameModule = (a: string, b: string) => moduleKey(a) === moduleKey(b)
const canonicalLocator = (locator: string) => locator.replace(/^([a-z]+:)(?:SYSTEM_)?/i, '$1').toLowerCase()
