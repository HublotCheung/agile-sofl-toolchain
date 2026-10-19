import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyTraceReplacements, type TracePair, type TraceDocument } from '../../shared/traceability'
import { applyRebindPlan, type TraceRebindPlan, type TraceStructurePreview } from '../../shared/traceAdvanced'
import { refreshTrace } from './traceEngine'
import { atomicTraceJson } from './traceRepository'

export function previewTraceStructure(pair:TracePair,doc:TraceDocument,ids:string[],parts:Array<{title:string;description:string}>):TraceStructurePreview {
  const entities=ids.map(id=>doc.entities.find(e=>e.id===id&&e.present&&e.side==='informal'))
  if(!entities.length||entities.some(e=>!e||!e.leaf||e.start<0))throw new Error('Choose leaf requirements for splitting or merging.')
  const first=entities[0]!
  if(entities.some(e=>e!.documentId!==first.documentId||e!.parent!==first.parent||e!.kind!==first.kind))throw new Error('Merge sibling requirements from the same document.')
  if((ids.length===1&&parts.length<2)||(ids.length>1&&parts.length!==1)||parts.some(p=>!p.title.trim()||/[\r\n]/.test(p.title)||typeof p.description!=='string'))throw new Error('Supply at least two parts for a split, or one merged requirement.')
  const path=first.documentPath??pair.informalPath,source=pair.documents?.find(d=>d.path===path)?.content??pair.informal
  const heading=first.text.match(/^(#{2,})\s/)
  if(!heading)throw new Error('Use Markdown requirements for structure editing.')
  const text=parts.map(p=>`${heading[1]} ${p.title.trim()}\n${p.description.trim()}\n\n`).join('')
  const changes=[{path,side:'informal' as const,before:source,after:applyTraceReplacements(source,entities.map((e,i)=>({start:e!.start,end:e!.end,before:e!.text,after:i===0?text:''})))}]
  const documents=pair.documents?.map(d=>({...d,content:d.path===path?changes[0]!.after:d.content}))
  const main=pair.informalPath.replace(/\\/g,'/').endsWith('/'+path)||path===pair.informalPath
  const next=refreshTrace(doc,{...pair,informal:main?changes[0]!.after:pair.informal,documents})
  const targets=next.entities.filter(e=>e.present&&e.side==='informal'&&e.documentId===first.documentId&&e.parent===first.parent&&parts.some(p=>p.title.trim()===e.title&&p.description.trim()===e.shape))
  if(targets.length!==parts.length)throw new Error('The new requirement titles or content are ambiguous. Choose distinct titles.')
  const preview:TraceStructurePreview={id:randomUUID(),revision:doc.revision,from:ids,to:targets.map(e=>e.id),sources:pair.documents??[],content:main?changes[0]!.after:pair.informal,document:next,changes}
  atomicTraceJson(join(pair.root,'.agile-sofl','trace','plans',preview.id+'.json'),preview)
  return preview
}
export function prepareTraceStructure(pair:TracePair,doc:TraceDocument,id:string,plan:TraceRebindPlan):TraceStructurePreview {
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid structure plan.')
  const path=join(pair.root,'.agile-sofl','trace','plans',id+'.json')
  if(!existsSync(path))throw new Error('Structure preview no longer exists.')
  const preview=JSON.parse(readFileSync(path,'utf8')) as TraceStructurePreview
  if(doc.revision!==preview.revision||JSON.stringify(pair.documents)!==JSON.stringify(preview.sources))throw new Error('Requirements changed after the structure preview.')
  if(JSON.stringify([...plan.from].sort())!==JSON.stringify([...preview.from].sort())||plan.to.some(v=>!preview.to.includes(v)))throw new Error('Rebinding plan is outside the structure change.')
  const affected=doc.links.filter(l=>preview.from.includes(l.source)).map(l=>l.id)
  if(affected.some(id=>!plan.assignments.some(a=>a.linkId===id)))throw new Error('Assign every affected link or explicitly unlink it.')
  return {...preview,document:applyRebindPlan(preview.document,plan,()=>randomUUID())}
}
