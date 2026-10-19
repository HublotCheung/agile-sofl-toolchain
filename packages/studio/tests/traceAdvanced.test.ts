import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { emptyTrace, linkBaseline, linkState, type TracePair, type TraceLink } from '../src/shared/traceability'
import { applyRebindPlan, mergeTraceGraphs, relocateTraceDocument, validateEvidence, traceMetrics } from '../src/shared/traceAdvanced'
import { evaluateTraceCases } from '../src/shared/traceEvaluation'
import { hydrateTracePair, readTrace, writeTrace, atomicTraceJson, withTraceLock, traceStoragePath } from '../src/main/services/traceRepository'
import { prepareTraceProposal } from '../src/main/services/traceService'
import { refreshTrace } from '../src/main/services/traceEngine'
import { previewTraceStructure, prepareTraceStructure } from '../src/main/services/traceStructure'
import { stageTraceTransaction, pendingTraceTransactions, recoverTraceJournal, saveTraceFiles } from '../src/main/services/traceTransactions'
import { cachedTraceCompletion, registerTraceProvider } from '../src/main/services/traceProviders'
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()},ipcMain:{handle:vi.fn()}}))
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sofl-workspace-'))
  const informal='# Functions\n## Borrow\nBorrow books.\n## Return\nReturn books.\n# Data Resources\n# Constraints\n'
  const hybrid='module SYSTEM_Library;\nprocess Borrow(id: BookId)\npost true\nend_process;\nend_module;'
  const shared='module Shared;\ntype\nBookId = nat;\nend_module;'
  writeFileSync(join(root,'r.aspec'),informal);writeFileSync(join(root,'s.asfl'),hybrid);writeFileSync(join(root,'shared.asfl'),shared)
  writeFileSync(join(root,'.agile-sofl.json'),JSON.stringify({version:'1.0',name:'Library',informal:'r.aspec',hybrid:['s.asfl','shared.asfl']}))
  const pair:TracePair={root,informalPath:join(root,'r.aspec'),hybridPath:join(root,'s.asfl'),informal,hybrid}
  const full=hydrateTracePair(pair),doc=refreshTrace(emptyTrace(),full)
  const source=doc.entities.find(e=>e.side==='informal'&&e.title==='Borrow')!.id,target=doc.entities.find(e=>e.kind==='process'&&e.title==='Borrow')!.id
  const link:TraceLink={id:'link',source,target,origin:'manual',review:'confirmed',relation:'refines',reason:'Books',baseline:linkBaseline(doc,{source,target})};doc.links.push(link)
  return {pair,full,doc,link,root,shared}
}
describe('project trace identity and dependencies',()=>{
  it('uses one graph for all document pairs and preserves cross-file dependencies',()=>{
    const {pair,full,doc,link,root,shared}=fixture()
    const saved=writeTrace(full,doc,0)
    expect(doc.files).toHaveLength(3)
    const target=doc.entities.find(e=>e.id===link.target)!,type=doc.entities.find(e=>e.title==='BookId')!
    expect(target.dependencies).toContain(type.id);expect(target.context).toContain('BookId = nat')
    writeFileSync(join(root,'shared.asfl'),shared.replace('nat','int'))
    const next=refreshTrace(saved,hydrateTracePair(pair))
    expect(linkState(next,link)).toBe('hybrid-changed')
    expect(readTrace({...pair,hybridPath:join(root,'shared.asfl')}).links).toHaveLength(1)
  })
  it('prepares an update to a declaration in another file without rewriting the active file',()=>{
    const {full,doc,link}=fixture(),type=doc.entities.find(e=>e.title==='BookId')!
    const proposal={linkId:link.id,direction:'hybrid' as const,informal:full.informal,hybrid:full.hybrid,documents:full.documents,revision:doc.revision,explanation:'Change shared type',replacements:[{entityId:type.id,before:type.text,after:type.text.replace('nat','int'),reason:'shared declaration'}]}
    const result=prepareTraceProposal(full,doc,proposal,[type.id])
    expect(result.content).toBe(full.hybrid)
    expect(result.changes?.[0]?.path).toBe('shared.asfl')
    expect(result.document.entities.find(e=>e.id===link.target)?.context).toContain('BookId = int')
  })
  it('retains document and entity identities when a file is moved externally',()=>{
    const {pair,full,doc,root}=fixture(),saved=writeTrace(full,doc,0)
    const type=doc.entities.find(e=>e.title==='BookId')!
    renameSync(join(root,'shared.asfl'),join(root,'types.asfl'))
    writeFileSync(join(root,'.agile-sofl.json'),JSON.stringify({informal:'r.aspec',hybrid:['s.asfl','types.asfl']}))
    const next=refreshTrace(saved,hydrateTracePair(pair)),moved=next.entities.find(e=>e.id===type.id)!
    expect(moved.present).toBe(true);expect(moved.documentPath).toBe('types.asfl')
    expect(next.files?.find(f=>f.id===type.documentId)?.aliases).toContain('shared.asfl')
  })
  it('preserves renamed processes even when several process bodies are identical',()=>{
    const {pair}=fixture()
    const hybrid='module SYSTEM_Library;\nprocess Borrow()\npost true\nend_process;\nprocess Return()\npost true\nend_process;\nend_module;'
    const before=refreshTrace(emptyTrace(),{...pair,hybrid})
    const old=before.entities.find(e=>e.side==='hybrid'&&e.kind==='process'&&e.title==='Borrow')!
    const after=refreshTrace(before,{...pair,hybrid:hybrid.replace('process Borrow','process Checkout')},[{side:'hybrid',locator:old.locator,title:'Checkout',newLocator:'proc:Library.Checkout'}])
    expect(after.entities.find(e=>e.id===old.id)?.title).toBe('Checkout')
    expect(after.entities.find(e=>e.id===old.id)?.present).toBe(true)
  })
  it('preserves old pair graphs during migration into the shared index',()=>{
    const {full,doc,pair}=fixture(),old=clone(doc)
    old.entities=old.entities.filter(e=>e.documentPath!=='shared.asfl').map(e=>{delete e.documentId;delete e.documentPath;return e});delete old.files
    const key=createHash('sha256').update('r.aspec\ns.asfl').digest('hex').slice(0,24)
    const path=join(dirname(traceStoragePath(full)),key+'.json');atomicTraceJson(path,old)
    const migrated=readTrace(pair)
    expect(migrated.links).toHaveLength(1);expect(migrated.links[0]!.id).toBe('link')
    expect(migrated.migrations?.length).toBe(1);expect(existsSync(path)).toBe(true)
  })
  it('previews explicit file relocation when a move and edit cannot be identified by hash',()=>{
    const {doc,full,root,pair,shared}=fixture(),saved=writeTrace(full,doc,0)
    renameSync(join(root,'shared.asfl'),join(root,'types.asfl'));writeFileSync(join(root,'types.asfl'),shared.replace('nat','int'))
    writeFileSync(join(root,'.agile-sofl.json'),JSON.stringify({informal:'r.aspec',hybrid:['s.asfl','types.asfl']}))
    const fresh=refreshTrace(saved,hydrateTracePair(pair)),from=fresh.files!.find(f=>f.path==='shared.asfl')!,to=fresh.files!.find(f=>f.path==='types.asfl')!
    const preview=relocateTraceDocument(fresh,from.id,to.id)
    expect(preview.matched).toBeGreaterThan(0)
    const old=doc.entities.find(e=>e.title==='BookId')!
    expect(preview.document.entities.find(e=>e.id===old.id)?.present).toBe(true)
    expect(preview.document.files?.find(f=>f.id===from.id)?.path).toBe('types.asfl')
  })
  it('honors unsaved buffers for non-selected files',()=>{
    const {pair,doc,shared}=fixture()
    const full=hydrateTracePair({...pair,documents:[{path:'shared.asfl',side:'hybrid',content:shared.replace('nat','int')}]})
    expect(refreshTrace(doc,full).entities.find(e=>e.kind==='process')?.context).toContain('BookId = int')
  })
  it('does not overwrite another process while holding the workspace lock',()=>{
    const {pair,full,doc}=fixture()
    expect(()=>withTraceLock(pair.root,()=>writeTrace(full,doc,0))).toThrow('Another process')
    expect(writeTrace(full,doc,0).revision).toBe(1)
  })
  it('records local review actions without source prompts or credentials',()=>{
    const {full,doc,root}=fixture(),saved=writeTrace(full,doc,0)
    saved.links[0]!.review='rejected'
    const next=writeTrace(full,saved,saved.revision)
    expect(next.audit?.length).toBe(2)
    expect(JSON.stringify(next.audit)).not.toContain('Borrow books.')
    expect(JSON.parse(readFileSync(traceStoragePath(full),'utf8')).version).toBe(3)
    expect(existsSync(join(root,'.agile-sofl','trace','workspace.lock'))).toBe(false)
  })
})
describe('structural plans and transactions',()=>{
  it('previews a split and requires explicit assignment before application',()=>{
    const {full,doc,link}=fixture(),saved=writeTrace(full,doc,0)
    const preview=previewTraceStructure(full,saved,[link.source],[{title:'Check limit',description:'Check borrowing limit.'},{title:'Record loan',description:'Store the loan.'}])
    expect(preview.to).toHaveLength(2)
    expect(readTrace(full).entities.find(e=>e.id===link.source)?.present).toBe(true)
    const plan={revision:saved.revision,from:preview.from,to:preview.to,note:'Split borrowing',assignments:[]}
    expect(()=>prepareTraceStructure(full,saved,preview.id,plan)).toThrow('Assign every')
    const applied=prepareTraceStructure(full,saved,preview.id,{...plan,assignments:[{linkId:link.id,endpoint:'source',targets:preview.to}]})
    expect(applied.document.links).toHaveLength(2)
    expect(applied.document.links.every(l=>l.review==='suggested')).toBe(true)
    expect(applied.changes![0]!.after).toContain('## Check limit')
  })
  it('merges sibling leaves and keeps duplicate trace decisions pending',()=>{
    const {full,doc,link}=fixture(),other=doc.entities.find(e=>e.side==='informal'&&e.title==='Return')!
    doc.links.push({...clone(link),id:'other',source:other.id})
    const preview=previewTraceStructure(full,doc,[link.source,other.id],[{title:'Circulation',description:'Borrow and return books.'}])
    const merged=applyRebindPlan(preview.document,{revision:doc.revision,from:preview.from,to:preview.to,note:'Merge functions',assignments:doc.links.map(l=>({linkId:l.id,endpoint:'source' as const,targets:preview.to}))},()=>crypto.randomUUID())
    expect(merged.links).toHaveLength(1);expect(merged.links[0]!.review).toBe('suggested')
  })
  it('restores an interrupted update without overwriting later user edits',()=>{
    const {full,doc}=fixture();writeTrace(full,doc,0)
    const current=readTrace(full),change={path:'s.asfl',side:'hybrid' as const,before:full.hybrid,after:full.hybrid.replace('true','false')}
    const journal=stageTraceTransaction(full,current,[change])
    expect(pendingTraceTransactions(full)).toHaveLength(1)
    expect(recoverTraceJournal(full,journal.id,'restore').changes[0]!.after).toContain('false')
    expect(()=>recoverTraceJournal({...full,documents:full.documents!.map(d=>d.path==='s.asfl'?{...d,content:d.content+'\n// newer'}:d)},journal.id,'restore')).toThrow('newer content')
  })
  it('saves multiple specification files through a recoverable journal',()=>{
    const {full,doc,root,shared}=fixture(),saved=writeTrace(full,doc,0)
    const changes=[{path:'s.asfl',side:'hybrid' as const,before:full.hybrid,after:full.hybrid.replace('true','false')},{path:'shared.asfl',side:'hybrid' as const,before:shared,after:shared.replace('nat','int')}]
    saveTraceFiles(full,changes,saved.revision)
    expect(readFileSync(join(root,'s.asfl'),'utf8')).toContain('false')
    expect(readFileSync(join(root,'shared.asfl'),'utf8')).toContain('int')
    expect(pendingTraceTransactions(full)).toHaveLength(0)
    expect(()=>saveTraceFiles(full,[{...changes[0]!,before:'different'}],saved.revision)).not.toThrow()
  })
})
describe('evidence, concurrent reviews, evaluation and providers',()=>{
  it('validates exact evidence and invalidates it when the baseline changes',()=>{
    const {doc,link}=fixture(),baseline=linkBaseline(doc,link)
    expect(validateEvidence(doc,link,{baseline,requirementFragment:'Borrow books.',specificationFragment:'post true',explanation:'evidence'})).toBe(true)
    expect(validateEvidence(doc,link,{baseline,requirementFragment:'invented quote',specificationFragment:'post true',explanation:''})).toBe(false)
  })
  it('requires an explicit decision for reject-versus-accept conflicts',()=>{
    const {doc}=fixture(),local=clone(doc),remote=clone(doc)
    local.links[0]!.review='rejected';remote.links[0]!.note='Confirmed by another reviewer'
    const preview=mergeTraceGraphs(doc,local,remote)
    expect(preview.conflicts).toHaveLength(1)
    const resolved=mergeTraceGraphs(doc,local,remote,{'links:link':'remote'})
    expect(resolved.conflicts).toHaveLength(0);expect(resolved.document.links[0]!.note).toContain('another reviewer')
  })
  it('reports false positives, false negatives and many-to-many recall',()=>{
    const metrics=traceMetrics([{source:'a',target:'x'},{source:'a',target:'y'}],[{source:'a',target:'x'},{source:'b',target:'z'}])
    expect(metrics).toMatchObject({tp:1,fp:1,fn:1,precision:.5,recall:.5,f1:.5})
    expect(evaluateTraceCases([{name:'negative',requirements:[{id:'r',title:'Email',content:'notify'}],processes:[{id:'p',title:'Withdraw',content:'cash'}],expected:[],predicted:[]}],'supplied').micro.f1).toBe(1)
  })
  it('caches provider results by model, prompt version and dependency context',async()=>{
    const {root}=fixture(),complete=vi.fn(async()=>({links:[]})),remove=registerTraceProvider({id:'offline-test',identity:()=> 'model-v1',complete})
    try{
      const request={root,provider:'offline-test',system:'recover',data:{context:'limit=5'}}
      expect((await cachedTraceCompletion(request)).cached).toBe(false)
      expect((await cachedTraceCompletion(request)).cached).toBe(true)
      await cachedTraceCompletion({...request,data:{context:'limit=8'}})
      expect(complete).toHaveBeenCalledTimes(2)
      const controller=new AbortController();controller.abort()
      await expect(cachedTraceCompletion({...request,signal:controller.signal})).rejects.toThrow('cancelled')
    }finally{remove()}
  })
})
