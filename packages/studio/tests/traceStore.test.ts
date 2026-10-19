import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTraceabilityStore } from '../src/renderer/stores/traceability'
import { useDocumentStore } from '../src/renderer/stores/document'
import { useWorkspaceStore } from '../src/renderer/stores/workspace'
import { useHistoryStore } from '../src/renderer/stores/history'
import { emptyTrace, linkBaseline, linkState, type TraceDocument, type TracePair, type TraceProposal } from '../src/shared/traceability'
import { refreshTrace } from '../src/main/services/traceEngine'
import { traceNotification } from '../src/shared/traceInteraction'
import type { StudioApi } from '../src/preload/index'

const copy = <T>(v:T):T => JSON.parse(JSON.stringify(v))
const initialInformal = '# Functions\n## Borrow\nAt most 5 books.\n# Data Resources\n# Constraints\n'
const initialHybrid = 'module SYSTEM_Library;\nprocess Borrow()\npost true\nend_process;\nend_module;'
describe('trace UI state and undo transactions', () => {
  let disk: TraceDocument
  beforeEach(() => {
    setActivePinia(createPinia()); disk = emptyTrace()
    const api = {
      traceRead: vi.fn(async (pair: TracePair) => ({ document: refreshTrace(copy(disk), pair), warnings: [] })),
      traceSave: vi.fn(async (_pair:TracePair, doc:TraceDocument, revision:number) => {
        if (disk.revision !== revision) throw new Error('revision conflict')
        disk = {...copy(doc),revision:revision+1}; return copy(disk)
      }),
      projectModuleHashes: vi.fn(async () => ({})),
      projectScan: vi.fn(async () => null)
    }
    Object.defineProperty(globalThis,'window',{value:{studio:api},writable:true,configurable:true})
    const docs = useDocumentStore(), ws = useWorkspaceStore()
    const a = docs.newTab({content:initialInformal,documentKind:'aspec'}), b = docs.newTab({content:initialHybrid,documentKind:'asfl'})
    docs.markSaved(a.id,'D:/trace-test/r.aspec','r.aspec'); docs.markSaved(b.id,'D:/trace-test/s.asfl','s.asfl')
    ws.projects = [{id:'p',name:'Trace',rootPath:'D:/trace-test',createdAt:0,lastOpenedAt:0}]
    ws.activeProjectId = 'p'
    ws.scan = {root:'D:/trace-test',manifest:{version:'1.0',name:'Trace',informal:'r.aspec',hybrid:['s.asfl']},files:[{kind:'aspec',path:a.filePath!},{kind:'asfl',path:b.filePath!}],modules:[]}
  })
  async function linked() {
    const trace = useTraceabilityStore()
    await trace.refreshNow()
    const source = trace.present.find(e => e.side === 'informal')!.id
    const target = trace.present.find(e => e.side === 'hybrid' && e.kind === 'process')!.id
    await trace.manual(source,target,'Borrowing policy')
    expect(trace.error).toBe('')
    return {trace,source,target}
  }
  it('undoes and redoes a metadata-only link without touching content', async () => {
    const {trace} = await linked(), history = useHistoryStore()
    expect(trace.document.links).toHaveLength(1)
    await history.undo()
    expect(disk.links).toHaveLength(0)
    expect(useWorkspaceStore().hybridTab?.content).toBe(initialHybrid)
    await history.redo()
    expect(disk.links).toHaveLength(1)
    expect(trace.document.links).toHaveLength(1)
  })
  it('defers only the reviewed snapshot and marks it pending again after a new change', async () => {
    const {trace} = await linked(), ws = useWorkspaceStore(), docs = useDocumentStore()
    docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','8 books'))
    await trace.refreshNow()
    expect(trace.pending).toHaveLength(1)
    await trace.review(trace.document.links[0]!.id,'defer')
    expect(trace.pending).toHaveLength(0)
    docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','9 books'))
    await trace.refreshNow()
    expect(trace.pending).toHaveLength(1)
  })
  it('applies content and baseline in one undo step, preserving both on redo', async () => {
    const {trace,target} = await linked(), history = useHistoryStore(), ws = useWorkspaceStore()
    const linkId = trace.document.links[0]!.id
    const entity = trace.present.find(e => e.id === target)!
    const proposal:TraceProposal = {linkId,direction:'hybrid',informal:initialInformal,hybrid:initialHybrid,revision:disk.revision,explanation:'Update logic',replacements:[{entityId:target,before:entity.text,after:entity.text.replace('true','false'),reason:'test'}]}
    const after = initialHybrid.replace('post true','post false')
    window.studio!.tracePrepare = vi.fn(async (pair) => ({content:after,document:refreshTrace(copy(disk),{...pair,hybrid:after})}))
    trace.proposal = proposal
    const length = history.undoStack.length
    await trace.applyProposal([target],'Apply suggestion')
    expect(trace.error).toBe('')
    expect(history.undoStack.length).toBe(length+1)
    expect(ws.hybridTab?.content).toBe(after)
    expect(linkState(disk,disk.links[0]!)).toBe('current')
    await history.undo()
    expect(ws.hybridTab?.content).toBe(initialHybrid)
    expect(disk.links[0]!.baseline.hybrid).toContain('post true')
    await history.redo()
    expect(ws.hybridTab?.content).toBe(after)
    expect(disk.links[0]!.baseline.hybrid).toContain('post false')
  })
  it('preserves an undo command and document if metadata persistence fails', async () => {
    const {trace} = await linked(), history = useHistoryStore()
    const length = history.undoStack.length
    window.studio!.traceSave = vi.fn(async () => { throw new Error('disk unavailable') })
    await expect(history.undo()).rejects.toThrow('disk unavailable')
    expect(history.undoStack.length).toBe(length)
    expect(trace.document.links).toHaveLength(1)
  })
  it('does not accept late recovery results after the user edits', async () => {
    const {trace} = await linked(), ws = useWorkspaceStore(), docs = useDocumentStore()
    window.studio!.traceRecover = vi.fn(async () => {
      docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','8 books'))
      return {links:[],informal:initialInformal,hybrid:initialHybrid,revision:disk.revision}
    })
    await trace.recover('en',[])
    expect(trace.error).toContain('Documents changed')
    expect(disk.links).toHaveLength(1)
  })
  it('never overwrites typing that arrives while proposal metadata is being saved', async () => {
    const {trace,target} = await linked(), ws = useWorkspaceStore(), docs = useDocumentStore()
    const e = trace.present.find(e => e.id === target)!
    trace.proposal = {linkId:trace.document.links[0]!.id,direction:'hybrid',informal:initialInformal,hybrid:initialHybrid,revision:disk.revision,explanation:'',replacements:[{entityId:target,before:e.text,after:e.text.replace('true','false'),reason:''}]}
    const after = initialHybrid.replace('post true','post false')
    window.studio!.tracePrepare = vi.fn(async pair => ({content:after,document:refreshTrace(copy(disk),{...pair,hybrid:after})}))
    const originalSave = window.studio!.traceSave
    let first = true
    window.studio!.traceSave = vi.fn(async (p,d,revision) => {
      const result = await originalSave(p,d,revision)
      if (first) { first = false; docs.setContent(ws.hybridTab!.id,initialHybrid+'\n// newer user text') }
      return result
    })
    await trace.applyProposal([target],'Update')
    expect(trace.error).toContain('Documents changed')
    expect(ws.hybridTab!.content).toContain('newer user text')
    expect(ws.hybridTab!.content).toContain('post true')
    expect(disk.links[0]!.baseline.hybrid).toContain('post true')
  })
  it('acknowledges only the receiving-side snapshot without declaring synchronization',async()=>{
    const {trace}=await linked(),ws=useWorkspaceStore(),docs=useDocumentStore()
    const id=trace.document.links[0]!.id,baseline=copy(trace.document.links[0]!.baseline)
    docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','8 books'));await trace.refreshNow()
    expect(trace.notifications('hybrid')).toHaveLength(1)
    expect(trace.notifications('informal')).toHaveLength(0)
    await trace.acknowledge(id,'hybrid')
    expect(trace.notifications('hybrid')).toHaveLength(0)
    expect(disk.links[0]!.baseline).toEqual(baseline)
    expect(linkState(disk,disk.links[0]!)).toBe('informal-changed')
    await useHistoryStore().undo()
    expect(trace.notifications('hybrid')).toHaveLength(1)
    await trace.acknowledge(id,'hybrid')
    docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','9 books'));await trace.refreshNow()
    expect(trace.notifications('hybrid')).toHaveLength(1)
  })
  it('keeps notifications independent when both sides change',async()=>{
    const {trace}=await linked(),ws=useWorkspaceStore(),docs=useDocumentStore()
    docs.setContent(ws.informalTab!.id,initialInformal.replace('5 books','8 books'))
    docs.setContent(ws.hybridTab!.id,initialHybrid.replace('true','false'));await trace.refreshNow()
    await trace.acknowledge(trace.document.links[0]!.id,'hybrid')
    expect(trace.notifications('hybrid')).toHaveLength(0)
    expect(trace.notifications('informal')).toHaveLength(1)
  })
  it('rejects modeled nodes without provenance before changing any text',async()=>{
    const trace=useTraceabilityStore(),ws=useWorkspaceStore()
    await trace.refreshNow()
    const next=initialHybrid.replace('end_module;','process Return()\npost true\nend_process;\nend_module;')
    await expect(trace.applyGeneratedContent(initialHybrid,next,[])).rejects.toThrow('Missing generation provenance')
    expect(ws.hybridTab!.content).toBe(initialHybrid)
    expect(disk.links).toHaveLength(0)
  })
  it('applies modeling and stable source bindings as a single undoable operation',async()=>{
    const trace=useTraceabilityStore(),ws=useWorkspaceStore(),history=useHistoryStore()
    await trace.refreshNow()
    const source=trace.present.find(e=>e.side==='informal')!,target=trace.present.find(e=>e.kind==='process')!
    const next=initialHybrid.replace('end_module;','process Return()\npost true\nend_process;\nend_module;')
    await trace.applyGeneratedContent(initialHybrid,next,[{sourceId:source.locator,targetId:target.locator.replace('Borrow','Return')}])
    expect(ws.hybridTab!.content).toBe(next)
    const newLink=trace.document.links[0]!
    expect(newLink.origin).toBe('generated');expect(newLink.review).toBe('confirmed')
    expect(traceNotification(trace.document,newLink,'informal')).toBe(false)
    await history.undo();expect(ws.hybridTab!.content).toBe(initialHybrid);expect(disk.links).toHaveLength(0)
    await history.redo();expect(ws.hybridTab!.content).toBe(next);expect(disk.links[0]!.id).toBe(newLink.id)
  })
  it('does not apply modeled text if metadata persistence fails',async()=>{
    const {trace}=await linked(),ws=useWorkspaceStore()
    window.studio!.traceSave=vi.fn(async()=>{throw new Error('disk unavailable')})
    await expect(trace.applyGeneratedContent(initialHybrid,initialHybrid.replace('true','false'),[])).rejects.toThrow('disk unavailable')
    expect(ws.hybridTab!.content).toBe(initialHybrid)
  })
  it('does not overwrite typing received during a modeling metadata write',async()=>{
    const {trace}=await linked(),ws=useWorkspaceStore(),docs=useDocumentStore()
    const save=window.studio!.traceSave;let changed=false
    window.studio!.traceSave=vi.fn(async(p,d,r)=>{const result=await save(p,d,r);if(!changed){changed=true;docs.setContent(ws.hybridTab!.id,initialHybrid+'\n// typing')}return result})
    await expect(trace.applyGeneratedContent(initialHybrid,initialHybrid.replace('true','false'),[])).rejects.toThrow('Documents changed')
    expect(ws.hybridTab!.content).toContain('// typing')
    expect(ws.hybridTab!.content).toContain('post true')
  })
})
