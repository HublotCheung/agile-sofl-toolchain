import { linkBaseline, sameBaseline, type TraceDocument, type TraceEvidence, type TraceLink, type TraceSource, type TracePrepared } from './traceability'
export interface TraceStructurePreview extends TracePrepared { id:string; revision:number; from:string[]; to:string[]; sources:TraceSource[] }

export const TRACE_RELATIONS = {
  refines: { source: 'informal', target: 'hybrid', label: 'refines' },
  constrains: { source: 'informal', target: 'hybrid', label: 'constrains' },
  uses: { source: 'informal', target: 'hybrid', label: 'uses' }
} as const
export function relocateTraceDocument(doc:TraceDocument,fromId:string,toId:string):{document:TraceDocument;matched:number;unmatched:number}{
  const next:TraceDocument=JSON.parse(JSON.stringify(doc)),from=next.files?.find(f=>f.id===fromId&&!f.present),to=next.files?.find(f=>f.id===toId&&f.present)
  if(!from||!to||from.side!==to.side)throw new Error('Choose a missing file and an existing file on the same side.')
  const previous=next.entities.filter(e=>e.documentId===fromId),fresh=next.entities.filter(e=>e.documentId===toId&&e.present)
  const remap=new Map<string,string>(),matched=new Set<string>()
  for(const e of fresh){
    const candidates=previous.filter(p=>p.kind===e.kind&&(p.locator===e.locator||!!e.shape&&p.shape===e.shape)&&!matched.has(p.id))
    if(candidates.length===1){remap.set(e.id,candidates[0]!.id);matched.add(candidates[0]!.id)}
  }
  next.entities=next.entities.filter(e=>!matched.has(e.id)).map(e=>({...e,id:remap.get(e.id)??e.id,documentId:e.documentId===toId?fromId:e.documentId,dependencies:e.dependencies.map(id=>remap.get(id)??id)}))
  next.links=next.links.map(l=>({...l,source:remap.get(l.source)??l.source,target:remap.get(l.target)??l.target}))
  const unique:TraceLink[]=[]
  for(const l of next.links){const existing=unique.find(v=>v.source===l.source&&v.target===l.target&&v.relation===l.relation);if(!existing)unique.push(l);else{existing.note=[existing.note,l.note,l.reason].filter(Boolean).join('\n');if(existing.review!==l.review){existing.review='suggested';existing.assessment=undefined}}}
  next.links=unique
  from.aliases=[...new Set([...from.aliases,from.path,...to.aliases])];from.path=to.path;from.hash=to.hash;from.present=true
  next.files=next.files!.filter(f=>f.id!==toId)
  return {document:next,matched:matched.size,unmatched:previous.length-matched.size}
}
export interface TraceRebindPlan {
  revision: number
  from: string[]
  to: string[]
  assignments: Array<{ linkId: string; endpoint: 'source' | 'target'; targets: string[] }>
  note: string
}
/** Explicit many-to-many rebinding. Empty targets means unlink; no silent assignment. */
export function applyRebindPlan(doc: TraceDocument, plan: TraceRebindPlan, newId: () => string): TraceDocument {
  if (plan.revision !== doc.revision) throw new Error('Rebinding preview is out of date.')
  if (!plan.note.trim()) throw new Error('Describe this split, merge or rebinding.')
  const next: TraceDocument = JSON.parse(JSON.stringify(doc))
  const seen = new Set<string>()
  for (const assignment of plan.assignments) {
    const original = next.links.find(l => l.id === assignment.linkId)
    if (!original || seen.has(original.id) || !plan.from.includes(original[assignment.endpoint])) throw new Error('Invalid rebinding assignment.')
    seen.add(original.id)
    const previous = next.entities.find(e => e.id === original[assignment.endpoint])!
    for (const id of assignment.targets) {
      if (!plan.to.includes(id) || !next.entities.some(e => e.id === id && e.present && e.side === previous.side)) throw new Error('Choose an existing endpoint on the same side.')
    }
    next.links = next.links.filter(l => l.id !== original.id)
    for (const [i,id] of [...new Set(assignment.targets)].entries()) {
      const copy = { ...original, id: i === 0 ? original.id : newId(), [assignment.endpoint]: id,
        review: 'suggested' as const, note: plan.note, deferred: undefined, assessment: undefined, evidence: [] }
      // A structural change needs an explicit review against its new endpoints.
      copy.baseline = linkBaseline(next, copy)
      const duplicate = next.links.find(l => l.source === copy.source && l.target === copy.target && l.relation === copy.relation)
      if (!duplicate) next.links.push(copy)
      else { duplicate.note = [duplicate.note, plan.note, original.reason].filter(Boolean).join('\n'); duplicate.review = 'suggested'; duplicate.assessment = undefined }
    }
  }
  return next
}
export function validateEvidence(doc: TraceDocument, link: TraceLink, evidence: TraceEvidence): boolean {
  const current = linkBaseline(doc,link)
  return sameBaseline(evidence.baseline,current) && !!evidence.requirementFragment.trim() && !!evidence.specificationFragment.trim()
    && current.informal.includes(evidence.requirementFragment) && current.hybrid.includes(evidence.specificationFragment)
}
export interface TraceMergeConflict { collection: 'entities' | 'links' | 'files'; id: string; base: unknown; local: unknown; remote: unknown }
export function mergeTraceGraphs(base: TraceDocument, local: TraceDocument, remote: TraceDocument, choices: Record<string,'local'|'remote'> = {}): { document: TraceDocument; conflicts: TraceMergeConflict[] } {
  const next: TraceDocument = JSON.parse(JSON.stringify(local)), conflicts: TraceMergeConflict[] = []
  for (const collection of ['entities','links'] as const) {
    const result: Array<TraceDocument[typeof collection][number]> = []
    const ids = new Set([...base[collection],...local[collection],...remote[collection]].map(x=>x.id))
    for (const id of ids) {
      const b = base[collection].find(x=>x.id===id), l=local[collection].find(x=>x.id===id), r=remote[collection].find(x=>x.id===id)
      const json=(x:unknown)=>JSON.stringify(x)
      let selected = json(l)===json(r) || json(r)===json(b) ? l : json(l)===json(b) ? r : undefined
      if (json(l)!==json(r) && json(l)!==json(b) && json(r)!==json(b)) {
        const key=collection+':'+id
        if (choices[key]) selected=choices[key]==='local'?l:r
        else { conflicts.push({collection,id,base:b,local:l,remote:r}); selected=l }
      }
      if (selected) result.push(selected)
    }
    if(collection==='entities') next.entities=result as TraceDocument['entities']
    else next.links=result as TraceDocument['links']
  }
  const mergedFiles:NonNullable<TraceDocument['files']>=JSON.parse(JSON.stringify(local.files??[]))
  next.files=mergedFiles
  for(const file of remote.files??[]){
    const previous=base.files?.find(f=>f.id===file.id),current=mergedFiles.find(f=>f.id===file.id)
    if(!current){mergedFiles.push(file);continue}
    if(current.path!==file.path&&previous&&current.path!==previous.path&&file.path!==previous.path){
      const key='files:'+file.id
      if(!choices[key])conflicts.push({collection:'files',id:file.id,base:previous,local:current,remote:file})
      else if(choices[key]==='remote')Object.assign(current,file)
    }
  }
  const deduplicated:TraceLink[]=[]
  for(const link of next.links){
    const prior=deduplicated.find(l=>l.source===link.source&&l.target===link.target&&l.relation===link.relation)
    if(!prior){deduplicated.push(link);continue}
    if(prior.review!==link.review){
      const key='links:'+prior.id
      if(!choices[key])conflicts.push({collection:'links',id:prior.id,base:undefined,local:prior,remote:link})
      else if(choices[key]==='remote')deduplicated[deduplicated.indexOf(prior)]=link
    }else prior.note=[prior.note,link.note,link.reason].filter(Boolean).join('\n')
  }
  next.links=deduplicated
  // Keep deletion-vs-link conflicts visible rather than silently removing references.
  for(const link of next.links) for(const id of [link.source,link.target]) if(!next.entities.some(e=>e.id===id)) {
    const entity=local.entities.find(e=>e.id===id)??remote.entities.find(e=>e.id===id)??base.entities.find(e=>e.id===id)
    if(entity) next.entities.push({...entity,present:false})
  }
  return {document:next,conflicts}
}
export function traceMetrics(expected: Array<{source:string;target:string}>, actual: Array<{source:string;target:string}>) {
  const keys=(v:typeof expected)=>new Set(v.map(l=>JSON.stringify([l.source,l.target])))
  const gold=keys(expected), predicted=keys(actual)
  const tp=[...predicted].filter(k=>gold.has(k)).length, fp=predicted.size-tp, fn=gold.size-tp
  const precision=predicted.size?tp/predicted.size:gold.size?0:1, recall=gold.size?tp/gold.size:1
  return {tp,fp,fn,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0}
}
