import { randomUUID, createHash } from 'node:crypto'
import { parseAspec, aspecToInformal, parseInformalSpec, detectAspecFormat } from '@agile-sofl/aspec'
import { buildVisualModelTolerant, type VisualModelResult } from '@agile-sofl/editor-api'
import type { HybridSpecificationIR } from '@agile-sofl/aspec'
import type { GeneratedTraceLink } from '../../shared/traceInteraction'
import { asflSafeInvariant } from '@agile-sofl/aspec/dist/refine/refineToAsfl.js'
import {
  canonicalTraceText, reconcileEntities, type TraceDocument, type TraceEntity, type TracePair, type TraceIdentityHint
} from '../../shared/traceability'

/** Rule/IR generators know provenance already; convert it to exact printed inventory IDs. */
export function generatedIRTraceLinks(ir: HybridSpecificationIR, source: string): GeneratedTraceLink[] {
  const entities = hybridEntities(source).entities
  const modules = ir.modules?.length ? ir.modules : [{name:ir.moduleName,...ir}]
  const normalize = (name:string)=>name.replace(/^SYSTEM_/,'').toLowerCase()
  const links: GeneratedTraceLink[] = []
  for(const module of modules) {
    const groups = [['process',module.processes],['type',module.types],['variable',module.variables],['invariant',module.invariants]] as const
    for(const [kind,members] of groups) for(const [index,member] of members.entries()) {
      if(!member.informalId)continue
      const scoped=entities.filter(e=>e.kind===kind&&normalize(e.parent)===normalize(module.name))
      const predicate='description' in member?canonicalTraceText(asflSafeInvariant(String(member.description))).replace(/;$/,''):''
      const matches=kind==='invariant'
        ? scoped.length===members.length&&canonicalTraceText(scoped[index]?.text??'').replace(/;$/,'')===predicate ? [scoped[index]] : scoped.filter(e=>canonicalTraceText(e.text).replace(/;$/,'')===predicate)
        : scoped.filter(e=>e.title===member.name)
      if(matches.length!==1)throw new Error(`Cannot resolve generated provenance for ${module.name}.${member.name}.`)
      links.push({sourceId:member.informalId,targetId:matches[0].locator,relation:kind==='invariant'?'constrains':kind==='process'?'refines':'uses'})
    }
  }
  return links
}

function base(side: TraceEntity['side'], locator: string, kind: string, title: string, parent: string, text: string, start: number, end: number): TraceEntity {
  return { id: '', side, locator, kind, title, parent, text, shape: '', context: text,
    dependencies: [], start, end, leaf: true, present: true }
}
export function informalEntities(source: string): TraceEntity[] {
  const spec = detectAspecFormat(source) === 'yaml'
    ? (() => { const { document } = parseAspec(source); return document ? aspecToInformal(document) : null })()
    : parseInformalSpec(source).specification
  if (!spec) throw new Error('Cannot read informal specification. Fix its structure before tracing.')
  const headings = [...source.matchAll(/^(#{2,})\s+(.+?)\s*\r?$/gm)].map(m => ({
    start: m.index!, title: m[2]!.replace(/<!--\s*@id:[^>]+-->/g, '').trim()
  }))
  const allHeadings = [...source.matchAll(/^#+\s+.+\r?$/gm)].map(m => m.index!)
  const used = new Set<number>()
  const out: TraceEntity[] = []
  const walk = (nodes: typeof spec.sections[0]['children'], ancestors: TraceEntity[], section: string) => {
    for (const node of nodes) {
      const heading = headings.find(h => !used.has(h.start) && h.title === node.title)
      if (heading) used.add(heading.start)
      const start = heading?.start ?? -1
      const end = start < 0 ? -1 : allHeadings.find(n => n > start) ?? source.length
      const text = start < 0 ? `${node.title}\n${node.description ?? ''}` : source.slice(start, end)
      const e = base('informal', node.id, node.type, node.title, ancestors[ancestors.length - 1]?.locator ?? section, text, start, end)
      const nested = (node.metadata?.nested ?? []) as typeof nodes
      e.leaf = nested.length === 0
      e.shape = canonicalTraceText(node.description ?? '')
      e.context = [...ancestors.map(a => a.text), text].join('\n')
      e.dependencies = ancestors.map(a => a.locator)
      out.push(e)
      walk(nested, [...ancestors, e], section)
    }
  }
  for (const section of spec.sections) walk(section.children, [], section.type)
  // The Constraints section (including its decomposed constraints) applies to the specification as a whole.
  const constraints = out.filter(e => e.kind === 'constraint')
  for (const e of out.filter(e => e.kind === 'function')) {
    e.context += constraints.length ? '\nConstraints:\n' + constraints.map(c => c.text).join('\n') : ''
    e.dependencies.push(...constraints.map(c => c.locator))
    const referenced = out.filter(d => ['data-resource','data-field'].includes(d.kind) && d.title.length > 1 && e.context.includes(d.title))
    const resources = out.filter(d => referenced.includes(d) || referenced.some(r => d.dependencies.includes(r.locator)))
    if (resources.length) e.context += '\nData resources:\n' + resources.map(d => d.text).join('\n')
    e.dependencies.push(...resources.map(d => d.locator))
  }
  return out
}
function tokens(text: string): Set<string> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"/g, '""')
  return new Set(code.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [])
}
export function hybridEntities(source: string): { entities: TraceEntity[]; model: VisualModelResult } {
  const model = buildVisualModelTolerant(source)
  if (source.trim() && model.parseFailed) throw new Error('Cannot read hybrid specification. Fix syntax before tracing.')
  const entities: TraceEntity[] = []
  for (const mod of model.modules) {
    const groups = [
      ['process', 'proc', mod.processes], ['function', 'fn', mod.functions],
      ['type', 'type', mod.types], ['variable', 'var', mod.vars], ['constant', 'const', mod.consts]
    ] as const
    for (const [kind, prefix, items] of groups) {
      for (const item of items) {
        const text = source.slice(item.span.start, item.span.end)
        const e = base('hybrid', `${prefix}:${mod.name}.${item.name}`, kind, item.name, mod.name, text, item.span.start, item.span.end)
        const i = text.indexOf(item.name)
        e.shape = canonicalTraceText(i < 0 ? text : text.slice(0, i) + '@self' + text.slice(i + item.name.length))
        entities.push(e)
      }
    }
    for (const [i, inv] of mod.invariants.entries()) {
      const e = base('hybrid', `inv:${mod.name}.${i}`, 'invariant', `${mod.name} inv ${i + 1}`, mod.name,
        source.slice(inv.span.start, inv.span.end), inv.span.start, inv.span.end)
      e.shape = canonicalTraceText(e.text); entities.push(e)
    }
  }
  const declarations = entities.filter(e => e.kind !== 'process')
  for (const entity of entities) {
    const collected = new Set<TraceEntity>([entity])
    const visit = (item: TraceEntity) => {
      for (const token of tokens(item.text)) {
        let matches = declarations.filter(d => d.title === token && d.parent === item.parent)
        // Unique cross-module references are retained; ambiguous names are never guessed.
        if (!matches.length) matches = declarations.filter(d => d.title === token)
        if (matches.length !== 1 || collected.has(matches[0]!)) continue
        collected.add(matches[0]!); visit(matches[0]!)
      }
    }
    visit(entity)
    const relevant = new Set([...collected].flatMap(e => [...tokens(e.text)]))
    for (const inv of declarations.filter(d => d.kind === 'invariant' && d.parent === entity.parent)) {
      if ([...tokens(inv.text)].some(t => relevant.has(t) && declarations.some(d => d.title === t))) {
        collected.add(inv); visit(inv)
      }
    }
    const deps = [...collected].filter(e => e !== entity).sort((a,b) => a.locator.localeCompare(b.locator))
    entity.dependencies = deps.map(e => e.locator)
    entity.context = [entity.text, ...deps.map(e => `[${e.locator}]\n${e.text}`)].join('\n')
  }
  // Derived scenarios may share a predicate span. They are navigable trace targets;
  // updates use their owning process so a derived item never rewrites a shared span.
  for (const fsf of model.fsfModels) {
    const owner = entities.find(e => e.parent === fsf.moduleName && e.title === (fsf.functionName ?? fsf.processName) && e.kind === (fsf.functionName ? 'function' : 'process'))
    if (!owner) continue
    const scenarios = [...fsf.scenarios, ...(fsf.exceptionalScenarios ?? [])]
    for (const [i, scenario] of scenarios.entries()) {
      const label = scenario.name || `${scenario.kind === 'exceptional' ? 'Exception' : 'Scenario'} ${i + 1}`
      const e = base('hybrid', `scn:${owner.parent}.${owner.title}.${scenario.id}`, 'scenario', label, owner.locator,
        `${scenario.guard ?? scenario.test}\n${scenario.definingCondition ?? scenario.def}`, scenario.span.start, scenario.span.end)
      e.shape = canonicalTraceText(e.text)
      e.dependencies = [owner.locator, ...owner.dependencies]
      e.context = `${e.text}\nOwner context:\n${owner.context}`
      entities.push(e)
    }
  }
  return { entities, model }
}
export function refreshTrace(document: TraceDocument, pair: TracePair, hints: TraceIdentityHint[] = []): TraceDocument {
  let files=document.files
  let fresh:TraceEntity[]
  if(pair.documents?.length) {
    const normalized=(path:string)=>path.replace(/\\/g,'/').toLowerCase()
    const samePath=(a:string,b:string)=>normalized(a)===normalized(b)||normalized(a).endsWith('/'+normalized(b))
    const sources=pair.documents.map(d=>({...d,content:samePath(pair.informalPath,d.path)?pair.informal:samePath(pair.hybridPath,d.path)?pair.hybrid:d.content})).filter(d=>d.present!==false&&typeof d.content==='string')
    const previousFiles=document.files??[]
    files=[]
    const claimed=new Set<string>()
    for(const source of sources) {
      const hash=createHash('sha256').update(source.content!).digest('hex')
      let file=previousFiles.find(f=>f.side===source.side&&f.path.toLowerCase()===source.path.toLowerCase())
      if(!file) {
        const candidates=previousFiles.filter(f=>!claimed.has(f.id)&&f.side===source.side&&f.hash===hash&&!sources.some(s=>s.path.toLowerCase()===f.path.toLowerCase()))
        if(candidates.length===1)file=candidates[0]
      }
      const id=file?.id??randomUUID();claimed.add(id)
      files.push({id,path:source.path,side:source.side,hash,aliases:[...new Set([...(file?.aliases??[]),...(file&&file.path!==source.path?[file.path]:[])])],present:true})
    }
    files.push(...previousFiles.filter(f=>!claimed.has(f.id)).map(f=>({...f,present:false})))
    fresh=[]
    for(const source of sources) {
      const file=files.find(f=>f.present&&f.path===source.path)!
      const entities=source.side==='informal'?informalEntities(source.content!):hybridEntities(source.content!).entities
      fresh.push(...entities.map(e=>({...e,documentId:file.id,documentPath:file.path})))
    }
  } else fresh=[...informalEntities(pair.informal),...hybridEntities(pair.hybrid).entities]
  const previous=document.entities.map(e=>{
    if(e.documentId||!files)return {...e}
    const candidates=files.filter(f=>f.present&&f.side===e.side)
    const mainPath=(e.side==='informal'?pair.informalPath:pair.hybridPath).replace(/\\/g,'/')
    const file=candidates.find(f=>mainPath.endsWith('/'+f.path))??(candidates.length===1?candidates[0]:undefined)
    return {...e,...(file?{documentId:file.id,documentPath:file.path}:{})}
  })
  for(const hint of hints) {
    const old=previous.find(e=>e.present&&e.side===hint.side&&e.locator===hint.locator&&(!hint.documentPath||!e.documentPath||hint.documentPath.replace(/\\/g,'/').toLowerCase().endsWith('/'+e.documentPath.toLowerCase())||hint.documentPath===e.documentPath))
    const candidates=fresh.filter(e=>e.side===hint.side&&e.kind===old?.kind&&e.title===hint.title&&e.documentId===old?.documentId&&(!hint.newLocator||e.locator===hint.newLocator))
    if(old&&candidates.length===1){old.locator=candidates[0]!.locator;old.shape=candidates[0]!.shape}
  }
  const entities=reconcileEntities(previous,fresh,()=>randomUUID())
  const active=entities.filter(e=>e.present)
  for(const e of active) e.dependencies=e.dependencies.map(locator=>active.find(d=>d.side===e.side&&d.documentId===e.documentId&&d.locator===locator)?.id??locator)
  // Extend each process's local dependence graph across specification files. Resolve
  // local declarations first and never choose between ambiguous external symbols.
  const declarations=active.filter(e=>e.side==='hybrid'&&!['process','scenario'].includes(e.kind))
  for(const e of active.filter(e=>e.side==='hybrid')) {
    const found=new Set<TraceEntity>()
    const visit=(item:TraceEntity)=>{
      for(const token of tokens(item.text)) {
        let candidates=declarations.filter(d=>d.title===token&&d.parent===item.parent&&d.documentId===item.documentId)
        if(!candidates.length)candidates=declarations.filter(d=>d.title===token)
        if(candidates.length===1&&candidates[0]!==e&&!found.has(candidates[0]!)) {found.add(candidates[0]!);visit(candidates[0]!)}
      }
    }
    visit(e)
    for(const inv of declarations.filter(d=>d.kind==='invariant')){
      if([...found].some(d=>d.documentId===inv.documentId&&tokens(inv.text).has(d.title))){found.add(inv);visit(inv)}
    }
    const external=[...found].filter(d=>d.documentId!==e.documentId)
    e.dependencies=[...new Set([...e.dependencies,...[...found].map(d=>d.id)])]
    if(external.length)e.context+='\nExternal declarations:\n'+external.sort((a,b)=>a.id.localeCompare(b.id)).map(d=>`[${d.locator}]\n${d.text}`).join('\n')
  }
  return {...document,entities,...(files?{files}:{})}
}
