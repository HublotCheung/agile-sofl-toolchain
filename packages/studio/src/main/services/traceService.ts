import { previewTraceStructure, prepareTraceStructure } from './traceStructure'
import type { TraceRebindPlan } from '../../shared/traceAdvanced'
import { stageTraceTransaction, updateTraceTransaction, pendingTraceTransactions, recoverTraceJournal, saveTraceFiles } from './traceTransactions'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cachedTraceCompletion, listTraceProviders } from './traceProviders'
import { validateEvidence, mergeTraceGraphs } from '../../shared/traceAdvanced'
import { refreshTrace, informalEntities, hybridEntities } from './traceEngine'
import { readTrace, writeTrace, traceStoragePath, hydrateTracePair, validateTrace } from './traceRepository'
import { acceptHybridWrite } from '../../shared/asflRepair'
import { applyTraceReplacements, linkBaseline, linkState, sameBaseline,
  type TracePrepared, type TraceDocument, type TraceEntity, type TracePair, type TraceProposal, type TraceReplacement, type TraceIdentityHint } from '../../shared/traceability'

function pairCheck(pair: TracePair): void {
  traceStoragePath(pair)
  if (typeof pair.informal !== 'string' || typeof pair.hybrid !== 'string') throw new Error('Document contents are required.')
  pair.documents=hydrateTracePair(pair).documents
}
function parseJson(content: string): Record<string, unknown> {
  return JSON.parse(content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) as Record<string, unknown>
}
function migrateLegacy(pair: TracePair, doc: TraceDocument): string[] {
  const warnings: string[] = []
  if (doc.revision || doc.links.length) return warnings
  const path = pair.informalPath + '.trace.json'
  if (!existsSync(path)) return warnings
  try {
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as { links?: Array<{ aspecId: string; asflSymbol?: string }> }
    for (const l of legacy.links ?? []) {
      const sources = doc.entities.filter(e => e.side === 'informal' && e.locator === l.aspecId)
      const targets = doc.entities.filter(e => e.side === 'hybrid' && (e.locator === l.asflSymbol || e.title === l.asflSymbol))
      if (sources.length !== 1 || targets.length !== 1) { warnings.push(`Legacy link ${l.aspecId} needs manual matching.`); continue }
      const source = sources[0]!.id, target = targets[0]!.id
      if (doc.links.some(e => e.source === source && e.target === target)) continue
      doc.links.push({ id: randomUUID(), source, target, relation: 'refines', origin: 'legacy', review: 'suggested',
        reason: 'Imported from legacy trace metadata; review against current content.', baseline: linkBaseline(doc, { source, target }) })
    }
  } catch { warnings.push('Legacy trace metadata could not be read; the original file was kept.') }
  return warnings
}
const controllers = new Map<number, AbortController>()
async function complete(owner: number, system: string, data: unknown, root: string, provider?:string): Promise<Record<string, unknown>> {
  const input = JSON.stringify(data)
  if (input.length > 180_000) throw new Error('This trace scope is too large. Select one requirement or process and try again.')
  controllers.get(owner)?.abort()
  const controller = new AbortController(); controllers.set(owner, controller)
  try {
    const response=await cachedTraceCompletion({root,system,data,provider,signal:controller.signal})
    return {...response.result,__traceRunId:response.runId}
  } finally { if (controllers.get(owner) === controller) controllers.delete(owner) }
}
function publicEntity(e: TraceEntity) { return { id: e.id, kind: e.kind, title: e.title, parent: e.parent, content: e.context } }

export function registerTraceHandlers(): void {
  ipcMain.handle('studio:trace-providers',()=>listTraceProviders())
  ipcMain.handle('studio:trace-structure-preview',(_event,pair:TracePair,ids:string[],parts:Array<{title:string;description:string}>)=>{pairCheck(pair);return previewTraceStructure(pair,refreshTrace(readTrace(pair),pair),ids,parts)})
  ipcMain.handle('studio:trace-structure-prepare',(_event,pair:TracePair,id:string,plan:TraceRebindPlan)=>{pairCheck(pair);return prepareTraceStructure(pair,refreshTrace(readTrace(pair),pair),id,plan)})
  ipcMain.handle('studio:trace-stage',(_event,pair:TracePair,document:TraceDocument,changes:NonNullable<TracePrepared['changes']>)=>{pairCheck(pair);validateTrace(document);return stageTraceTransaction(pair,document,changes).id})
  ipcMain.handle('studio:trace-finish',(_event,pair:TracePair,id:string,state:'buffers-applied'|'discarded')=>{pairCheck(pair);updateTraceTransaction(pair.root,id,state)})
  ipcMain.handle('studio:trace-transactions',(_event,pair:TracePair)=>{pairCheck(pair);return pendingTraceTransactions(pair)})
  ipcMain.handle('studio:trace-restore',(_event,pair:TracePair,id:string,choice:'restore'|'discard')=>{pairCheck(pair);return recoverTraceJournal(pair,id,choice)})
  ipcMain.handle('studio:trace-save-files',(_event,pair:TracePair,changes:NonNullable<TracePrepared['changes']>,revision:number)=>{pairCheck(pair);saveTraceFiles(pair,changes,revision)})
  ipcMain.handle('studio:trace-read', (_event, pair: TracePair, hints: TraceIdentityHint[] = []) => {
    pairCheck(pair)
    const document = refreshTrace(readTrace(pair), pair, hints)
    const warnings = migrateLegacy(pair, document)
    return { document, warnings }
  })
  ipcMain.handle('studio:trace-save', (_event, pair: TracePair, document: TraceDocument, expected: number) => {
    pairCheck(pair)
    return writeTrace(pair, document, expected)
  })
  ipcMain.handle('studio:trace-cancel', event => { controllers.get(event.sender.id)?.abort() })
  ipcMain.handle('studio:trace-recover', async (event, pair: TracePair, scope: string[], locale: string, options: {provider?:string;mode?:'complete'|'focused';refresh?:boolean} = {}) => {
    pairCheck(pair)
    const doc=refreshTrace(readTrace(pair),pair)
    const roots=doc.entities.filter(e=>scope.includes(e.id))
    const sources=doc.entities.filter(e=>e.present&&e.side==='informal'&&e.kind==='function'&&e.leaf&&(!scope.length||scope.includes(e.id)||roots.some(r=>e.dependencies.includes(r.id))))
    const allTargets=doc.entities.filter(e=>e.present&&e.side==='hybrid'&&e.kind==='process')
    const links:TraceDocument['links']=[]
    controllers.get(event.sender.id)?.abort()
    const controller=new AbortController();controllers.set(event.sender.id,controller)
    const jobId=randomUUID();let cached=0,estimatedTokens=0
    const publish=(done:number,status:string)=>event.sender.send?.('studio:trace-progress',{jobId,root:pair.root,done,total:sources.length,candidates:links.length,cached,estimatedTokens,status})
    publish(0,'running')
    try{
      for(const [i,source] of sources.entries()) {
        if(controller.signal.aborted)throw new Error('Trace analysis cancelled.')
        let targets=allTargets
        if(options.mode==='focused'&&targets.length>12){
          const words=new Set(source.context.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[])
          targets=[...targets].sort((a,b)=>{
            const score=(e:TraceEntity)=>[...words].filter(w=>e.context.toLowerCase().includes(w)).length
            return score(b)-score(a)
          }).slice(0,12)
          for(const l of doc.links.filter(l=>l.source===source.id)) {const t=allTargets.find(e=>e.id===l.target);if(t&&!targets.includes(t))targets.push(t)}
        }
        const response=await cachedTraceCompletion({root:pair.root,provider:options.provider,refresh:options.refresh,signal:controller.signal,
          system:'Recover trace links from leaf natural-language functional requirements to SOFL process specifications together with their associated declarations. Compare meaning and constraints, not names alone. Multiple process targets are allowed. Correspondence is not proof of full satisfaction. Return {"links":[{"sourceId":"...","targetId":"...","reason":"specific rationale","requirementFragment":"exact quote from requirement context","specificationFragment":"exact quote from process context","coverage":"unassessed|partial|supported|contradicted","missingConstraints":["..."]}]}. Never invent endpoints or quotes. Return no link when uncertain.',
          data:{locale,requirements:[publicEntity(source)],specifications:targets.map(publicEntity)},
          validate:value=>{
            if(!Array.isArray(value.links))throw new Error('The model did not return trace candidates.')
            for(const raw of value.links as Array<Record<string,unknown>>)if(raw.sourceId!==source.id||!targets.some(e=>e.id===raw.targetId)||typeof raw.reason!=='string'||!raw.reason.trim())throw new Error('The model returned an unknown trace endpoint or no evidence.')
          }})
        cached+=response.cached?1:0;estimatedTokens+=response.estimatedTokens
        if(!Array.isArray(response.result.links))throw new Error('The model did not return trace candidates.')
        for(const raw of response.result.links as Array<Record<string,unknown>>) {
          const sourceId=String(raw.sourceId),target=String(raw.targetId)
          if(sourceId!==source.id||!targets.some(e=>e.id===target)||typeof raw.reason!=='string'||!raw.reason.trim())throw new Error('The model returned an unknown trace endpoint or no evidence.')
          const baseline=linkBaseline(doc,{source:sourceId,target}),old=doc.links.find(l=>l.source===sourceId&&l.target===target)
          if(old&&(old.review!=='rejected'||sameBaseline(old.baseline,baseline)))continue
          if(links.some(l=>l.source===sourceId&&l.target===target))continue
          const link:TraceDocument['links'][number]={id:old?.id??randomUUID(),source:sourceId,target,baseline,reason:raw.reason,review:'suggested',origin:'recovered',relation:'refines'}
          const evidence={requirementFragment:String(raw.requirementFragment??''),specificationFragment:String(raw.specificationFragment??''),baseline,explanation:raw.reason,runId:response.runId}
          link.evidence=validateEvidence(doc,link,evidence)?[evidence]:[]
          const result=['partial','supported','contradicted'].includes(String(raw.coverage))&&link.evidence.length?raw.coverage as 'partial'|'supported'|'contradicted':'unassessed'
          link.assessment={baseline,result,missingConstraints:Array.isArray(raw.missingConstraints)?raw.missingConstraints.filter((v):v is string=>typeof v==='string'):[],explanation:raw.reason,reviewer:'model'}
          links.push(link)
        }
        publish(i+1,'running')
      }
      publish(sources.length,'complete')
      return {links,informal:pair.informal,hybrid:pair.hybrid,revision:doc.revision,documents:pair.documents,cached,estimatedTokens,mode:options.mode??'complete'}
    }catch(error){publish(links.length,'interrupted');throw error}
    finally{if(controllers.get(event.sender.id)===controller)controllers.delete(event.sender.id)}
  })
  ipcMain.handle('studio:trace-assess',async(event,pair:TracePair,linkId:string,locale:string,options:{provider?:string}={})=>{
    pairCheck(pair)
    const doc=refreshTrace(readTrace(pair),pair),link=doc.links.find(l=>l.id===linkId)
    if(!link||linkState(doc,link)==='missing')throw new Error('Select an available link.')
    const baseline=linkBaseline(doc,link)
    const response=await complete(event.sender.id,'Assess a requirements-to-SOFL trace link. Evaluate each explicit requirement constraint against the process and its declarations. Return {"result":"unassessed|partial|supported|contradicted","explanation":"...","missingConstraints":["..."],"requirementFragment":"exact quote","specificationFragment":"exact quote"}. This is an inspection aid, not a formal proof. Never invent quotes.',{locale,requirement:baseline.informal,specification:baseline.hybrid},pair.root,options.provider)
    const raw=response,evidence={requirementFragment:String(raw.requirementFragment??''),specificationFragment:String(raw.specificationFragment??''),baseline,explanation:String(raw.explanation??''),runId:String(response.__traceRunId??'')}
    const valid=validateEvidence(doc,link,evidence),result=valid&&['partial','supported','contradicted'].includes(String(raw.result))?raw.result as 'partial'|'supported'|'contradicted':'unassessed'
    return {revision:doc.revision,documents:pair.documents,evidence:valid?[evidence]:[],assessment:{baseline,result,missingConstraints:Array.isArray(raw.missingConstraints)?raw.missingConstraints.filter((v):v is string=>typeof v==='string'):[],explanation:String(raw.explanation??''),reviewer:'model' as const}}
  })
  ipcMain.handle('studio:trace-merge',(_event,pair:TracePair,base:TraceDocument,remote:TraceDocument,choices:Record<string,'local'|'remote'>)=>{
    pairCheck(pair);validateTrace(base);validateTrace(remote)
    const merged=mergeTraceGraphs(base,readTrace(pair),remote,choices);return {...merged,document:refreshTrace(merged.document,pair)}
  })
  ipcMain.handle('studio:trace-suggest', async (event, pair: TracePair, linkId: string, direction: 'informal' | 'hybrid', locale: string, options:{provider?:string}={}) => {
    pairCheck(pair)
    const doc = refreshTrace(readTrace(pair), pair)
    const link = doc.links.find(l => l.id === linkId && l.review === 'confirmed')
    if (!link || linkState(doc, link) === 'missing') throw new Error('Select a confirmed link with both endpoints present.')
    const endpoint = doc.entities.find(e => e.id === (direction === 'hybrid' ? link.target : link.source))!
    const target = endpoint.kind === 'scenario' ? doc.entities.find(e => endpoint.dependencies.includes(e.id) && ['process','function'].includes(e.kind))! : endpoint
    const allowed = doc.entities.filter(e => e.present && e.side === direction && (e.id === target.id || (direction === 'hybrid' && target.dependencies.includes(e.id))))
    const result = await complete(event.sender.id,
      'Propose minimal updates to the selected linked specification. Preserve unrelated content and user design. Explain new restrictions or ambiguity. You must only replace allowed entity blocks. Do not delete or rename entities, add processes, or replace a document. A shared declaration may affect other processes: explain that impact. Return {"explanation":"...","replacements":[{"entityId":"...","after":"complete replacement block","reason":"..."}]}. Return an empty list if no edit is needed and explain why. SOFL syntax uses <> for inequality, conc for sequences; preserve existing language conventions.',
      { locale, direction, state: linkState(doc, link), previous: link.baseline,
        current: { informal: doc.entities.find(e => e.id === link.source)?.context, hybrid: doc.entities.find(e => e.id === link.target)?.context },
        allowed: allowed.map(e => ({ ...publicEntity(e), text: e.text })),
        sharedWith: doc.entities.filter(e => e.present && e.side === 'hybrid' && e.dependencies.some(d => allowed.some(a => a.id === d))).map(e => ({ title: e.title, parent: e.parent })) }, pair.root, options.provider)
    if (!Array.isArray(result.replacements) || typeof result.explanation !== 'string') throw new Error('Invalid update suggestion.')
    const replacements: TraceReplacement[] = []
    for (const raw of result.replacements as Array<Record<string, unknown>>) {
      const e = allowed.find(a => a.id === raw.entityId)
      if (!e || e.start < 0 || typeof raw.after !== 'string' || !raw.after.trim() || typeof raw.reason !== 'string' || replacements.some(r => r.entityId === e.id)) throw new Error('Invalid or duplicate update target.')
      if (raw.after !== e.text) replacements.push({ entityId: e.id, before: e.text, after: raw.after, reason: raw.reason })
    }
    const proposal: TraceProposal = { linkId, direction, informal: pair.informal, hybrid: pair.hybrid, revision: doc.revision, replacements, explanation: result.explanation, documents: pair.documents }
    prepareTraceProposal(pair, doc, proposal, replacements.map(r => r.entityId))
    return proposal
  })
  ipcMain.handle('studio:trace-prepare', (_event, pair: TracePair, proposal: TraceProposal, selected: string[]) => {
    pairCheck(pair)
    const doc = refreshTrace(readTrace(pair), pair)
    return prepareTraceProposal(pair, doc, proposal, selected)
  })
}
export function prepareTraceProposal(pair: TracePair, doc: TraceDocument, proposal: TraceProposal, selected: string[]): TracePrepared {
  if(proposal.informal!==pair.informal||proposal.hybrid!==pair.hybrid||proposal.revision!==doc.revision)throw new Error('Documents or links changed after preview. Generate a new suggestion.')
  const sources=pair.documents??[{path:pair.informalPath,side:'informal' as const,content:pair.informal},{path:pair.hybridPath,side:'hybrid' as const,content:pair.hybrid}]
  if(proposal.documents&&proposal.documents.some(d=>!sources.some(s=>s.path===d.path&&s.content===d.content&&s.present===d.present)))throw new Error('A project document changed after preview.')
  const link=doc.links.find(l=>l.id===proposal.linkId&&l.review==='confirmed')
  if(!link||linkState(doc,link)==='missing'||!['informal','hybrid'].includes(proposal.direction))throw new Error('The selected link is unavailable.')
  const endpoint=doc.entities.find(e=>e.id===(proposal.direction==='hybrid'?link.target:link.source))!
  const target=endpoint.kind==='scenario'?doc.entities.find(e=>endpoint.dependencies.includes(e.id)&&['process','function'].includes(e.kind))!:endpoint
  if(new Set(selected).size!==selected.length||selected.some(id=>!proposal.replacements.some(r=>r.entityId===id)))throw new Error('Invalid selection in trace preview.')
  const groups=new Map<string,Array<{start:number;end:number;before:string;after:string}>>()
  for(const r of proposal.replacements.filter(r=>selected.includes(r.entityId))) {
    const e=doc.entities.find(e=>e.id===r.entityId&&e.present&&e.side===proposal.direction)
    if(!e||(e.id!==target.id&&!(proposal.direction==='hybrid'&&target.dependencies.includes(e.id))))throw new Error('Update is outside the linked scope.')
    const path=e.documentPath??(proposal.direction==='hybrid'?pair.hybridPath:pair.informalPath)
    const edits=groups.get(path)??[];edits.push({...r,start:e.start,end:e.end});groups.set(path,edits)
  }
  const changes:NonNullable<TracePrepared['changes']>=[]
  for(const [path,edits] of groups) {
    const source=sources.find(s=>s.path===path)
    if(!source||typeof source.content!=='string')throw new Error('The target document is unavailable.')
    const before=source.content,after=applyTraceReplacements(before,edits)
    let written = after
    if(proposal.direction==='hybrid') {
      const gate=acceptHybridWrite(before,after)
      written = gate.content
      const structure=(text:string)=>hybridEntities(text).entities.filter(e=>e.kind!=='scenario').map(e=>e.locator).sort()
      if(JSON.stringify(structure(before))!==JSON.stringify(structure(written)))throw new Error('Suggestion changes specification structure. Use the editor to rename, split or add entities.')
    } else if(JSON.stringify(informalEntities(before).map(e=>e.locator).sort())!==JSON.stringify(informalEntities(after).map(e=>e.locator).sort()))throw new Error('Suggestion changes requirement structure. Use the editor to rename, split or add requirements.')
    changes.push({path,side:source.side,before,after:written})
  }
  const documents=sources.map(d=>({...d,content:changes.find(c=>c.path===d.path)?.after??d.content}))
  const path=proposal.direction==='hybrid'?pair.hybridPath:pair.informalPath
  const content=changes.find(c=>c.path===path||path.replace(/\\/g,'/').endsWith('/'+c.path))?.after??pair[proposal.direction]
  const nextPair={...pair,[proposal.direction]:content,...(pair.documents?{documents}:{})}
  return {content,document:refreshTrace(doc,nextPair),changes}
}
