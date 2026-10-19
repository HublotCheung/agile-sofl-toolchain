import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTrace, linkBaseline, type TracePair, type TraceDocument } from '../src/shared/traceability'
import { refreshTrace } from '../src/main/services/traceEngine'
import { writeTrace } from '../src/main/services/traceRepository'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), chat: vi.fn() }))
vi.mock('electron', () => ({ipcMain:{handle:(name:string,fn:(...args:any[])=>any) => mocks.handlers.set(name,fn)}}))
vi.mock('../src/main/services/llm/profiles',()=>({getEcnuConfig:()=>({baseUrl:'test',model:'fake'})}))
vi.mock('../src/main/services/llm/chatEcnu', () => ({chatEcnu:mocks.chat}))
import { registerTraceHandlers } from '../src/main/services/traceService'
const event = {sender:{id:99}}
const call = (name:string,...args:unknown[]) => mocks.handlers.get('studio:trace-'+name)!(event,...args)
describe('trace model adapter and legacy migration', () => {
  let pair:TracePair, doc:TraceDocument
  beforeEach(() => {
    mocks.handlers.clear(); mocks.chat.mockReset(); registerTraceHandlers()
    const root = mkdtempSync(join(tmpdir(),'sofl-trace-service-'))
    pair = {root,informalPath:join(root,'r.aspec'),hybridPath:join(root,'s.asfl'),informal:'# Functions\n## Borrow\nBorrow books.\n# Data Resources\n# Constraints\n',hybrid:'module SYSTEM_Library;\nprocess Borrow()\npost true\nend_process;\nend_module;'}
    doc = refreshTrace(emptyTrace(),pair)
    doc = writeTrace(pair,doc,0)
  })
  const response = (payload:unknown) => ({content:JSON.stringify(payload),finishReason:'stop'})
  function endpoints() { return {source:doc.entities.find(e => e.side === 'informal')!.id,target:doc.entities.find(e => e.kind === 'process' && e.side === 'hybrid')!.id} }
  it('returns evidence-backed candidates without writing any links', async () => {
    const {source,target} = endpoints()
    mocks.chat.mockResolvedValue(response({links:[{sourceId:source,targetId:target,reason:'Borrow implements borrowing.'}]}))
    const result = await call('recover',pair,[],'en')
    expect(result.links).toHaveLength(1)
    expect(result.links[0].review).toBe('suggested')
    expect(call('read',pair).document.links).toHaveLength(0)
  })
  it('rejects hallucinated endpoints and missing evidence', async () => {
    const {source,target} = endpoints()
    mocks.chat.mockResolvedValueOnce(response({links:[{sourceId:source,targetId:'invented',reason:'guess'}]}))
    await expect(call('recover',pair,[],'en')).rejects.toThrow('unknown trace endpoint')
    mocks.chat.mockResolvedValueOnce(response({links:[{sourceId:source,targetId:target,reason:''}]}))
    await expect(call('recover',pair,[],'en')).rejects.toThrow('no evidence')
  })
  it('suppresses rejected links until content changes', async () => {
    const {source,target} = endpoints()
    doc.links.push({id:'rejected',source,target,review:'rejected',origin:'recovered',relation:'refines',reason:'not related',baseline:linkBaseline(doc,{source,target})})
    doc = writeTrace(pair,doc,doc.revision)
    mocks.chat.mockResolvedValue(response({links:[{sourceId:source,targetId:target,reason:'new analysis'}]}))
    expect((await call('recover',pair,[],'en')).links).toHaveLength(0)
    const next = {...pair,informal:pair.informal.replace('Borrow books.','Borrow at most 5 books.')}
    expect((await call('recover',next,[],'en')).links).toHaveLength(1)
  })
  it('detects truncated model output', async () => {
    mocks.chat.mockResolvedValue({...response({links:[]}),finishReason:'length'})
    await expect(call('recover',pair,[],'en')).rejects.toThrow('truncated')
  })
  it('aborts the active request when Cancel is pressed', async () => {
    mocks.chat.mockImplementation(async (options:{signal:AbortSignal}) => new Promise((_resolve,reject) => {
      options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})
    }))
    const request = call('recover',pair,[],'en')
    const assertion = expect(request).rejects.toThrow('cancelled')
    call('cancel')
    await assertion
  })
  it('imports an unambiguous legacy link as a suggestion and preserves its source', () => {
    const root = mkdtempSync(join(tmpdir(),'sofl-trace-legacy-'))
    const legacyPair = {...pair,root,informalPath:join(root,'r.aspec'),hybridPath:join(root,'s.asfl')}
    const legacy = JSON.stringify({traceVersion:'1.0',links:[{aspecId:'fn-borrow',asflSymbol:'Borrow',kind:'process',status:'covered'}]})
    writeFileSync(legacyPair.informalPath+'.trace.json',legacy)
    const result = call('read',legacyPair)
    expect(result.document.links).toHaveLength(1)
    expect(result.document.links[0].origin).toBe('legacy')
    expect(result.document.links[0].review).toBe('suggested')
  })
})
