/** Versioned, provider-independent trace contract. IDs are independent of editor labels. */
export type TraceSide = 'informal' | 'hybrid'
export type TraceState = 'current' | 'informal-changed' | 'hybrid-changed' | 'conflict' | 'missing'
export interface TraceEntity {
  documentId?: string
  documentPath?: string
  id: string
  side: TraceSide
  locator: string
  kind: string
  title: string
  parent: string
  text: string
  shape: string
  context: string
  dependencies: string[]
  start: number
  end: number
  leaf: boolean
  present: boolean
}
export interface TraceBaseline { informal: string; hybrid: string }
export interface TraceLink {
  evidence?: TraceEvidence[]
  assessment?: CoverageAssessment
  id: string
  source: string
  target: string
  relation: 'refines' | 'constrains' | 'uses'
  origin: 'manual' | 'generated' | 'recovered' | 'legacy'
  review: 'confirmed' | 'suggested' | 'rejected'
  reason: string
  baseline: TraceBaseline
  deferred?: TraceBaseline
  /** Acknowledging a notification never advances the synchronization baseline. */
  acknowledged?: Partial<Record<TraceSide, TraceBaseline>>
  note?: string
}
export interface TraceDocument {
  version: 2
  revision: number
  entities: TraceEntity[]
  links: TraceLink[]
  files?: TraceFile[]
  audit?: TraceAuditEvent[]
  migrations?: string[]
}
export interface TraceFile { id: string; path: string; side: TraceSide; hash: string; aliases: string[]; present: boolean }
export interface TraceSource { path: string; side: TraceSide; content?: string; present?: boolean }
export interface TraceEvidence { requirementFragment: string; specificationFragment: string; baseline: TraceBaseline; explanation: string; runId?: string }
export interface CoverageAssessment { baseline: TraceBaseline; result: 'unassessed' | 'partial' | 'supported' | 'contradicted'; missingConstraints: string[]; explanation: string; reviewer: 'model' | 'user' }
export interface TraceAuditEvent { id: string; at: string; action: string; actor: string; links: string[]; revision: number }
export interface TracePair {
  root: string
  informalPath: string
  hybridPath: string
  informal: string
  hybrid: string
  documents?: TraceSource[]
}
export interface TraceSnapshot { document: TraceDocument; warnings: string[] }
export interface TraceIdentityHint { side: TraceSide; locator: string; title: string; newLocator?:string; documentPath?:string }
export interface TraceReplacement { entityId: string; before: string; after: string; reason: string }
export interface TraceProposal {
  linkId: string
  direction: TraceSide
  informal: string
  hybrid: string
  revision: number
  replacements: TraceReplacement[]
  explanation: string
  documents?: TraceSource[]
}
export interface TracePrepared { content: string; document: TraceDocument; changes?: Array<{ path: string; side: TraceSide; before: string; after: string }> }
export function emptyTrace(): TraceDocument { return { version: 2, revision: 0, entities: [], links: [] } }
export function canonicalTraceText(text: string): string {
  // Preserve whitespace inside predicates and string literals.
  return text.replace(/\r\n/g, '\n').split('\n').map(s => s.trimEnd()).join('\n').trim()
}
export function entityFingerprint(entity: TraceEntity): string {
  return canonicalTraceText(entity.context)
}
export function linkBaseline(doc: TraceDocument, link: Pick<TraceLink, 'source' | 'target'>): TraceBaseline {
  const source = doc.entities.find(e => e.id === link.source && e.present)
  const target = doc.entities.find(e => e.id === link.target && e.present)
  return { informal: source ? entityFingerprint(source) : '', hybrid: target ? entityFingerprint(target) : '' }
}
export function linkState(doc: TraceDocument, link: TraceLink): TraceState {
  if (![link.source, link.target].every(id => doc.entities.some(e => e.id === id && e.present))) return 'missing'
  const current = linkBaseline(doc, link)
  const a = current.informal !== link.baseline.informal
  const b = current.hybrid !== link.baseline.hybrid
  return a && b ? 'conflict' : a ? 'informal-changed' : b ? 'hybrid-changed' : 'current'
}
export function sameBaseline(a: TraceBaseline | undefined, b: TraceBaseline): boolean {
  return !!a && a.informal === b.informal && a.hybrid === b.hybrid
}
/** Match unique content before name-based locators (duplicate headings can be reordered).
 * Never guess an ambiguous rename. Missing entities remain available for manual relinking. */
export function reconcileEntities(previous: TraceEntity[], fresh: TraceEntity[], newId: () => string): TraceEntity[] {
  const claimed = new Set<string>()
  const assigned = new Map<TraceEntity, string>()
  const compatible = (a: TraceEntity, b: TraceEntity) => a.side === b.side && a.kind === b.kind && a.documentId === b.documentId
  for (const entity of fresh) {
    const candidates = previous.filter(p => compatible(p, entity) && p.shape && p.shape === entity.shape)
    const peers = fresh.filter(p => compatible(p, entity) && p.shape === entity.shape)
    if (candidates.length === 1 && peers.length === 1) {
      assigned.set(entity, candidates[0]!.id); claimed.add(candidates[0]!.id)
    }
  }
  for (const entity of fresh) {
    if (assigned.has(entity)) continue
    const matches = previous.filter(p => !claimed.has(p.id) && compatible(p, entity) && p.locator === entity.locator)
    const candidates = matches.some(p=>p.present) ? matches.filter(p=>p.present) : matches
    if (candidates.length === 1) {
      assigned.set(entity, candidates[0]!.id); claimed.add(candidates[0]!.id)
    }
  }
  return [
    ...fresh.map(e => ({ ...e, id: assigned.get(e) ?? newId(), present: true })),
    ...previous.filter(e => !claimed.has(e.id)).map(e => ({ ...e, present: false }))
  ]
}
export function applyTraceReplacements(source: string, replacements: Array<{ start: number; end: number; before: string; after: string }>): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!
    if (r.start < 0 || r.end < r.start || r.end > source.length || source.slice(r.start, r.end) !== r.before || (i && sorted[i - 1]!.end > r.start)) {
      throw new Error('Trace preview is out of date or contains overlapping edits. Generate a new preview.')
    }
  }
  return sorted.reverse().reduce((text, r) => text.slice(0, r.start) + r.after + text.slice(r.end), source)
}
