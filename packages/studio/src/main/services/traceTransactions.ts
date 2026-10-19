import { writeModuleArtifacts } from './dualSave'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicTraceJson, projectRelative, withTraceLock, readTrace } from './traceRepository'
import type { TracePair, TraceDocument, TracePrepared } from '../../shared/traceability'

export interface TraceJournal {
  id:string; at:string; state:'prepared'|'buffers-applied'|'committed'|'discarded'
  before:TraceDocument; after:TraceDocument; changes:NonNullable<TracePrepared['changes']>
}
const directory=(root:string)=>join(root,'.agile-sofl','trace','transactions')
function journalPath(root:string,id:string):string{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid transaction.');return join(directory(root),id+'.json')}
export function stageTraceTransaction(pair:TracePair,after:TraceDocument,changes:NonNullable<TracePrepared['changes']>):TraceJournal {
  for(const c of changes)projectRelative(pair.root,c.path)
  const before=readTrace(pair)
  if(before.revision!==after.revision)throw new Error('Metadata changed before transaction staging.')
  const journal:TraceJournal={id:randomUUID(),at:new Date().toISOString(),state:'prepared',before,after,changes}
  atomicTraceJson(journalPath(pair.root,journal.id),journal)
  return journal
}
export function updateTraceTransaction(root:string,id:string,state:TraceJournal['state']):void {
  const path=journalPath(root,id),journal=JSON.parse(readFileSync(path,'utf8')) as TraceJournal
  atomicTraceJson(path,{...journal,state})
}
export function pendingTraceTransactions(pair:TracePair):Array<Omit<TraceJournal,'before'|'after'>> {
  if(!existsSync(directory(pair.root)))return []
  const out:Array<Omit<TraceJournal,'before'|'after'>>=[]
  for(const file of readdirSync(directory(pair.root)).filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))) {
    const journal=JSON.parse(readFileSync(join(directory(pair.root),file),'utf8')) as TraceJournal
    if(['committed','discarded'].includes(journal.state))continue
    for(const c of journal.changes)projectRelative(pair.root,c.path)
    if(journal.changes.every(c=>existsSync(resolve(pair.root,c.path))&&readFileSync(resolve(pair.root,c.path),'utf8')===c.after)) {
      updateTraceTransaction(pair.root,journal.id,'committed');continue
    }
    const {before:_b,after:_a,...pending}=journal;out.push(pending)
  }
  return out
}
/** Explicit Save: a recoverable, cross-file transaction with a durable prepared log.
 * Recovery never overwrites a third-party edit: it requires matching before/after text. */
export function saveTraceFiles(pair:TracePair,changes:NonNullable<TracePrepared['changes']>,expected:number):void {
  withTraceLock(pair.root,()=>{
    if(readTrace(pair).revision!==expected)throw new Error('Trace metadata changed before saving.')
    for(const c of changes){const path=resolve(pair.root,projectRelative(pair.root,c.path));if(existsSync(path)&&![c.before,c.after].includes(readFileSync(path,'utf8')))throw new Error('A file changed outside Studio. Compare it before saving: '+c.path)}
    const journal=stageTraceTransaction(pair,readTrace(pair),changes)
    for(const c of changes){const path=resolve(pair.root,projectRelative(pair.root,c.path)),temp=path+'.trace-'+journal.id+'.tmp';writeFileSync(temp,c.after,'utf8');renameSync(temp,path)}
    for(const c of changes){try{writeModuleArtifacts(resolve(pair.root,c.path),c.after)}catch{/* auxiliary XML export must not invalidate a completed source save */}}
    updateTraceTransaction(pair.root,journal.id,'committed')
  })
}
export function recoverTraceJournal(pair:TracePair,id:string,choice:'restore'|'discard'):TraceJournal {
  const journal=JSON.parse(readFileSync(journalPath(pair.root,id),'utf8')) as TraceJournal
  for(const c of journal.changes) {
    projectRelative(pair.root,c.path)
    const open=pair.documents?.find(d=>d.path===c.path||d.path.replace(/\\/g,'/').endsWith('/'+c.path))
    const path=resolve(pair.root,c.path),current=open?.content??(existsSync(path)?readFileSync(path,'utf8'):c.before)
    if(choice==='restore'&&current!==c.before&&current!==c.after)throw new Error('Recovery conflicts with newer content. Compare the saved versions before restoring: '+c.path)
  }
  if(choice==='discard')updateTraceTransaction(pair.root,id,'discarded')
  return journal
}
