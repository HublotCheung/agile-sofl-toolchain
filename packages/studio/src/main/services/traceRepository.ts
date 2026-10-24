import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, extname } from 'node:path'
import { emptyTrace, type TraceDocument, type TracePair, type TraceSource } from '../../shared/traceability'

export function projectRelative(rootPath: string, path: string): string {
  const root = resolve(rootPath), absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Trace files must belong to the active project.')
  if (existsSync(absolute) && existsSync(root)) {
    const actual = relative(realpathSync(root), realpathSync(absolute))
    if (actual === '..' || actual.startsWith('..\\') || actual.startsWith('../') || isAbsolute(actual)) throw new Error('Trace file resolves outside the project.')
  }
  return rel.replace(/\\/g, '/')
}
export function traceStoragePath(pair: Pick<TracePair, 'root' | 'informalPath' | 'hybridPath'>): string {
  const paths = [pair.informalPath,pair.hybridPath].map(path=>projectRelative(pair.root,path))
  if (extname(paths[0]!).toLowerCase() !== '.aspec' || extname(paths[1]!).toLowerCase() !== '.asfl') throw new Error('Select an informal / hybrid document pair.')
  return join(resolve(pair.root), '.agile-sofl', 'trace', 'workspace-v3.json')
}
export function hydrateTracePair(pair: TracePair): TracePair {
  traceStoragePath(pair)
  const inputs = new Map<string,TraceSource>()
  const add = (path:string, side:TraceSource['side'], content?:string) => {
    const rel = projectRelative(pair.root,path)
    if (!['.aspec','.asfl'].includes(extname(rel).toLowerCase())) throw new Error('Unsupported trace source.')
    const key=rel.toLowerCase(), previous=inputs.get(key)
    const absolute=resolve(pair.root,rel)
    inputs.set(key,{path:rel,side,content:content??previous?.content??(existsSync(absolute)?readFileSync(absolute,'utf8'):undefined),present:content!==undefined||previous?.content!==undefined||existsSync(absolute)})
  }
  const manifest=join(pair.root,'.agile-sofl.json')
  if(existsSync(manifest)) {
    const m=JSON.parse(readFileSync(manifest,'utf8')) as {informal?:string;hybrid?:string[]}
    if(m.informal) add(m.informal,'informal')
    for(const path of m.hybrid??[]) add(path,'hybrid')
  }
  for(const source of pair.documents??[]) add(source.path,source.side,source.content)
  add(pair.informalPath,'informal',pair.informal);add(pair.hybridPath,'hybrid',pair.hybrid)
  return {...pair,documents:[...inputs.values()]}
}
export function withTraceLock<T>(root:string, fn:()=>T):T {
  const directory=join(resolve(root),'.agile-sofl','trace');mkdirSync(directory,{recursive:true})
  const lock=join(directory,'workspace.lock')
  for(let attempt=0;;attempt++) {
    try { writeFileSync(lock,JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});break }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error
      let dead=false
      try { const data=JSON.parse(readFileSync(lock,'utf8'));process.kill(data.pid,0) }
      catch(e) { dead=(e as NodeJS.ErrnoException).code==='ESRCH' }
      if(dead&&attempt===0){unlinkSync(lock);continue}
      throw new Error('Another process is writing trace metadata. Refresh and retry.')
    }
  }
  try{return fn()}finally{unlinkSync(lock)}
}
export function atomicTraceJson(path:string, value:unknown):void {
  mkdirSync(dirname(path),{recursive:true})
  const temp=path+'.'+randomUUID()+'.tmp'
  try {writeFileSync(temp,JSON.stringify(value,null,2)+'\n','utf8');renameSync(temp,path)}
  finally {if(existsSync(temp))unlinkSync(temp)}
}
export function validateTrace(value: unknown): asserts value is TraceDocument {
  const d = value as TraceDocument
  if (!d || d.version !== 2 || !Number.isSafeInteger(d.revision) || d.revision < 0 || !Array.isArray(d.entities) || !Array.isArray(d.links)) throw new Error('Unsupported or damaged trace metadata. The original file has been kept.')
  const ids = new Set<string>()
  for (const e of d.entities) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || !['informal', 'hybrid'].includes(e.side)
      || !['locator','kind','title','parent','text','shape','context'].every(k => typeof (e as unknown as Record<string, unknown>)[k] === 'string')
      || !Array.isArray(e.dependencies) || !e.dependencies.every(x => typeof x === 'string')
      || !Number.isInteger(e.start) || !Number.isInteger(e.end) || typeof e.present !== 'boolean' || typeof e.leaf !== 'boolean') throw new Error('Invalid trace entity metadata.')
    ids.add(e.id)
  }
  const links = new Set<string>()
  if(d.files){
    const files=new Set<string>()
    for(const f of d.files){if(!f||typeof f.id!=='string'||files.has(f.id)||typeof f.path!=='string'||!['informal','hybrid'].includes(f.side)||typeof f.hash!=='string'||!Array.isArray(f.aliases)||!f.aliases.every(a=>typeof a==='string')||typeof f.present!=='boolean')throw new Error('Invalid trace document index.');files.add(f.id)}
    for(const e of d.entities)if(e.documentId&&!files.has(e.documentId))throw new Error('Unknown document identity in trace graph.')
  }
  for (const l of d.links) {
    if (!l || typeof l.id !== 'string' || links.has(l.id) || !ids.has(l.source) || !ids.has(l.target)
      || !['confirmed','suggested','rejected'].includes(l.review) || !['manual','generated','recovered','legacy'].includes(l.origin)
      || !['refines','constrains','uses'].includes(l.relation) || typeof l.reason !== 'string'
      || typeof l.baseline?.informal !== 'string' || typeof l.baseline?.hybrid !== 'string'
      || d.entities.find(e => e.id === l.source)?.side !== 'informal' || d.entities.find(e => e.id === l.target)?.side !== 'hybrid') throw new Error('Invalid trace link metadata.')
    links.add(l.id)
    for(const snapshot of Object.values(l.acknowledged??{}))if(!snapshot||typeof snapshot.informal!=='string'||typeof snapshot.hybrid!=='string')throw new Error('Invalid notification acknowledgement.')
    for(const e of l.evidence??[]){if(typeof e.requirementFragment!=='string'||typeof e.specificationFragment!=='string'||typeof e.baseline?.informal!=='string'||typeof e.baseline?.hybrid!=='string'||!e.baseline.informal.includes(e.requirementFragment)||!e.baseline.hybrid.includes(e.specificationFragment))throw new Error('Invalid trace evidence.')}
    if(l.assessment&&(!['unassessed','partial','supported','contradicted'].includes(l.assessment.result)||!['model','user'].includes(l.assessment.reviewer)||typeof l.assessment.baseline?.informal!=='string'||typeof l.assessment.baseline?.hybrid!=='string'||!Array.isArray(l.assessment.missingConstraints)||!l.assessment.missingConstraints.every(v=>typeof v==='string')))throw new Error('Invalid coverage assessment.')
  }
}
export function readTrace(pair: Pick<TracePair, 'root' | 'informalPath' | 'hybridPath'>): TraceDocument {
  const path = traceStoragePath(pair)
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path,'utf8')) as {version?:number;graph?:unknown}
    const d=raw.version===3?raw.graph:raw
    validateTrace(d)
    return d
  }
  // Import previous pair graphs without modifying their files. Entity identity is
  // shared across known pairs; ambiguous old endpoints remain separate for review.
  const graph=emptyTrace(), sources=hydrateTracePair({...pair,informal:'',hybrid:''}).documents??[]
  const informal=sources.filter(s=>s.side==='informal'),hybrid=sources.filter(s=>s.side==='hybrid')
  const ids=new Map<string,string>(),files:NonNullable<TraceDocument['files']>=[]
  for(const source of sources) files.push({id:randomUUID(),path:source.path,side:source.side,hash:'',aliases:[],present:source.present!==false})
  for(const a of informal) for(const b of hybrid) {
    const key=createHash('sha256').update(a.path+'\n'+b.path).digest('hex').slice(0,24)
    const old=join(dirname(path),key+'.json')
    if(!existsSync(old))continue
    const prior:unknown=JSON.parse(readFileSync(old,'utf8'));validateTrace(prior)
    const remap=new Map<string,string>()
    for(const e of prior.entities) {
      const file=files.find(f=>f.path===(e.side==='informal'?a.path:b.path))!
      const identity=file.id+':'+e.locator+':'+e.shape
      const collision=graph.entities.find(v=>v.id===e.id&&v.documentId!==file.id)
      const id=ids.get(identity)??(collision?randomUUID():e.id);ids.set(identity,id);remap.set(e.id,id)
      if(!graph.entities.some(v=>v.id===id))graph.entities.push({...e,id,documentId:file.id,documentPath:file.path})
    }
    for(const l of prior.links) {
      const migrated={...l,source:remap.get(l.source)!,target:remap.get(l.target)!}
      const duplicate=graph.links.find(v=>v.source===migrated.source&&v.target===migrated.target&&v.relation===migrated.relation)
      if(!duplicate){if(graph.links.some(v=>v.id===migrated.id))migrated.id=randomUUID();graph.links.push(migrated)}
      else if(duplicate.review!==migrated.review||JSON.stringify(duplicate.baseline)!==JSON.stringify(migrated.baseline)){
        duplicate.note=[duplicate.note,'Imported pair reviews differ; inspect before confirming.',migrated.reason].filter(Boolean).join('\n');duplicate.review='suggested';duplicate.assessment=undefined
        graph.migrations=[...(graph.migrations??[]),'Conflicting pair reviews retained as a suggestion: '+duplicate.id]
      }
    }
    graph.migrations=[...(graph.migrations??[]),'Imported '+key+'; original pair metadata preserved.']
  }
  if(graph.entities.length)graph.files=files
  return graph
}
function coerceEntity(e: TraceDocument['entities'][number]): TraceDocument['entities'][number] {
  return {
    ...e,
    side: e.side === 'hybrid' ? 'hybrid' : 'informal',
    locator: String(e.locator ?? ''),
    kind: String(e.kind ?? 'unknown'),
    title: String(e.title ?? ''),
    parent: String(e.parent ?? ''),
    text: String(e.text ?? ''),
    shape: String(e.shape ?? ''),
    context: String(e.context ?? ''),
    dependencies: Array.isArray(e.dependencies) ? e.dependencies.filter((x) => typeof x === 'string') : [],
    start: Number.isInteger(e.start) ? e.start : 0,
    end: Number.isInteger(e.end) ? e.end : 0,
    present: e.present !== false,
    leaf: e.leaf !== false
  }
}

/** Drop entities/links that cannot satisfy the trace schema instead of failing the spec write. */
export function sanitizeTraceDocument(document: TraceDocument): TraceDocument {
  const seen = new Set<string>()
  const entities: TraceDocument['entities'] = []
  for (const raw of document.entities ?? []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue
    seen.add(raw.id)
    entities.push(coerceEntity(raw))
  }
  const links = (document.links ?? []).filter((l) => {
    if (!l || typeof l.id !== 'string') return false
    if (!seen.has(l.source) || !seen.has(l.target)) return false
    if (typeof l.reason !== 'string') return false
    if (typeof l.baseline?.informal !== 'string' || typeof l.baseline?.hybrid !== 'string') return false
    const source = entities.find((e) => e.id === l.source)
    const target = entities.find((e) => e.id === l.target)
    return source?.side === 'informal' && target?.side === 'hybrid'
  })
  return { ...document, entities, links }
}

export function writeTrace(pair: TracePair, document: TraceDocument, expected: number): TraceDocument {
  const sanitized = sanitizeTraceDocument(document)
  validateTrace(sanitized)
  document = sanitized
  const path=traceStoragePath(pair)
  for(const file of document.files??[])projectRelative(pair.root,file.path)
  for(const entity of document.entities)if(entity.documentPath)projectRelative(pair.root,entity.documentPath)
  return withTraceLock(pair.root,()=>{
    const current=readTrace(pair)
    if(current.revision!==expected)throw new Error('Trace metadata changed in another window. Refresh before continuing.')
    const changed=document.links.filter(l=>JSON.stringify(l)!==JSON.stringify(current.links.find(v=>v.id===l.id))).map(l=>l.id)
    const removed=current.links.filter(l=>!document.links.some(v=>v.id===l.id)).map(l=>l.id)
    const audit=[...(current.audit??[])]
    if(changed.length||removed.length)audit.push({id:randomUUID(),at:new Date().toISOString(),action:removed.length?'links-removed':'links-reviewed',actor:'local-user',links:[...changed,...removed],revision:expected+1})
    const next={...document,revision:expected+1,audit:audit.slice(-5000)}
    atomicTraceJson(path,{version:3,graph:next})
    return next
  })
}
