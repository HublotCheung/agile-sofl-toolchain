import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTrace, linkBaseline, linkState, reconcileEntities, applyTraceReplacements, type TracePair, type TraceEntity, type TraceLink } from '../src/shared/traceability'
import { refreshTrace, hybridEntities, informalEntities } from '../src/main/services/traceEngine'
import { readTrace, writeTrace, traceStoragePath } from '../src/main/services/traceRepository'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
import { prepareTraceProposal } from '../src/main/services/traceService'

const informal = '# Functions\n\n## Borrow\nBorrow at most 5 books.\n\n## Return\nReturn borrowed books.\n\n# Data Resources\n\n# Constraints\n'
const hybrid = `module SYSTEM_Library;\nconst\n  limit = 5;\nvar\n  count: nat;\nprocess Borrow()\npost count <= limit\nend_process;\nprocess Return()\npost true\nend_process;\nend_module;\n`
function pair(extra: Partial<TracePair> = {}): TracePair {
  const root = join(tmpdir(), 'sofl-trace-example')
  return { root, informalPath: join(root,'requirements.aspec'), hybridPath: join(root,'spec.asfl'), informal, hybrid, ...extra }
}
function setup(p = pair()) {
  const doc = refreshTrace(emptyTrace(), p)
  const source = doc.entities.find(e => e.side === 'informal' && e.title === 'Borrow')!.id
  const target = doc.entities.find(e => e.side === 'hybrid' && e.title === 'Borrow')!.id
  const link: TraceLink = { id: 'link', source, target, origin: 'manual', review: 'confirmed', relation: 'refines', reason: '', baseline: linkBaseline(doc, { source, target }) }
  doc.links.push(link)
  return { doc, link, p }
}
describe('trace lifecycle', () => {
  it('distinguishes current, single-sided, conflict and missing', () => {
    const {doc,link,p} = setup()
    expect(linkState(doc,link)).toBe('current')
    const a = refreshTrace(doc,{...p,informal: informal.replace('5 books','8 books')})
    expect(linkState(a,link)).toBe('informal-changed')
    const b = refreshTrace(doc,{...p,hybrid:hybrid.replace('limit = 5','limit = 8')})
    expect(linkState(b,link)).toBe('hybrid-changed')
    const c = refreshTrace(a,{...p,informal: informal.replace('5 books','8 books'),hybrid:hybrid.replace('limit = 5','limit = 8')})
    expect(linkState(c,link)).toBe('conflict')
    const d = refreshTrace(doc,{...p,hybrid:hybrid.replace(/process Borrow[\s\S]*?end_process;\n/,'')})
    expect(linkState(d,link)).toBe('missing')
  })
  it('does not stale an unrelated link when another process changes', () => {
    const {doc,link,p} = setup()
    expect(linkState(refreshTrace(doc,{...p,hybrid:hybrid.replace('post true','post false')}),link)).toBe('current')
  })
  it('retains stable identities across rename, reorder and moves', () => {
    const {doc,link,p} = setup()
    const renamed = refreshTrace(doc,{...p,informal:informal.replace('## Borrow','## Checkout'),hybrid:hybrid.replace('process Borrow','process Checkout')})
    expect(renamed.entities.find(e => e.id === link.source)?.title).toBe('Checkout')
    expect(renamed.entities.find(e => e.id === link.target)?.title).toBe('Checkout')
    expect(renamed.entities.find(e => e.id === link.target)?.present).toBe(true)
    const moved = refreshTrace(doc,{...p,informal:informal.replace('## Borrow\nBorrow at most 5 books.\n\n','').replace('Return borrowed books.','Return borrowed books.\n\n### Borrow\nBorrow at most 5 books.')})
    expect(moved.entities.find(e => e.id === link.source)?.present).toBe(true)
  })
  it('keeps empty descriptions stable through an explicit rename hint', () => {
    const p = pair({informal: informal.replace('Borrow at most 5 books.','')})
    const {doc,link} = setup(p)
    const current = refreshTrace(doc,{...p,informal:p.informal.replace('## Borrow','## Checkout')},[{side:'informal',locator:'fn-borrow',title:'Checkout'}])
    expect(current.entities.find(e => e.id === link.source)?.title).toBe('Checkout')
  })
  it('preserves duplicate-heading identities by unique content when reordered', () => {
    const old = informalEntities('# Functions\n## Same\nfirst\n## Same\nsecond\n# Data Resources\n# Constraints\n')
    const fresh = informalEntities('# Functions\n## Same\nsecond\n## Same\nfirst\n# Data Resources\n# Constraints\n')
    old.forEach((e,i) => { e.id = String(i) })
    const reconciled = reconcileEntities(old,fresh,()=> 'new')
    expect(reconciled.find(e => e.text.includes('second') && e.present)?.id).toBe('1')
    expect(reconciled.find(e => e.text.includes('first') && e.present)?.id).toBe('0')
  })
  it('does not guess ambiguous identical renames', () => {
    const {doc,p} = setup()
    const next = refreshTrace(doc,{...p,informal:informal.replace('Borrow at most 5 books.','same').replace('Return borrowed books.','same')})
    const renamed = refreshTrace(next,{...p,informal: '# Functions\n## A\nsame\n## B\nsame\n# Data Resources\n# Constraints\n'})
    expect(renamed.entities.filter(e => !e.present && e.side === 'informal')).toHaveLength(2)
  })
})
describe('dependency context', () => {
  it('includes shared constants and excludes unrelated process bodies', () => {
    const {entities} = hybridEntities(hybrid)
    const borrow = entities.find(e => e.kind === 'process' && e.title === 'Borrow')!
    const ret = entities.find(e => e.kind === 'process' && e.title === 'Return')!
    expect(borrow.context).toContain('limit = 5')
    expect(ret.context).not.toContain('limit = 5')
    expect(borrow.context).not.toContain('process Return')
  })
  it('includes inherited requirement descriptions and global constraints', () => {
    const e = informalEntities('# Functions\n## Accounts\nAuthenticated users only.\n### Borrow\nBorrow books.\n# Data Resources\n# Constraints\n## Capacity\nAt most 5.\n')
    const borrow = e.find(e => e.title === 'Borrow')!
    expect(borrow.context).toContain('Authenticated users only')
    expect(borrow.context).toContain('At most 5')
    expect(borrow.leaf).toBe(true)
    expect(e.find(e => e.title === 'Accounts')?.leaf).toBe(false)
  })
})
describe('persistence', () => {
  it('round trips pending states and never acknowledges on save', () => {
    const root = mkdtempSync(join(tmpdir(),'sofl-trace-test-'))
    const {doc,link,p} = setup(pair({root,informalPath:join(root,'r.aspec'),hybridPath:join(root,'s.asfl')}))
    const changed = refreshTrace(doc,{...p,informal:informal.replace('5 books','8 books')})
    const saved = writeTrace(p,changed,0)
    expect(saved.revision).toBe(1)
    expect(linkState(readTrace(p),link)).toBe('informal-changed')
    expect(() => writeTrace(p,changed,0)).toThrow('another window')
  })
  it('rejects path traversal and keeps damaged metadata intact', () => {
    const root = mkdtempSync(join(tmpdir(),'sofl-trace-test-'))
    const {doc,p} = setup(pair({root,informalPath:join(root,'r.aspec'),hybridPath:join(root,'s.asfl')}))
    expect(() => traceStoragePath({...p,hybridPath:join(root,'..','outside.asfl')})).toThrow('active project')
    writeTrace(p,doc,0)
    const path = traceStoragePath(p)
    writeFileSync(path,'{"broken":true}')
    expect(() => readTrace(p)).toThrow('damaged')
    expect(readFileSync(path,'utf8')).toBe('{"broken":true}')
  })
})
describe('reviewed patches', () => {
  it('rejects stale, overlapping and out-of-scope edits', () => {
    expect(() => applyTraceReplacements('abcdef',[{start:1,end:3,before:'bc',after:'X'},{start:2,end:4,before:'cd',after:'Y'}])).toThrow('overlapping')
    expect(() => applyTraceReplacements('abcdef',[{start:1,end:3,before:'wrong',after:'X'}])).toThrow('out of date')
    const {doc,p,link} = setup()
    const e = doc.entities.find(e => e.id === link.target)!
    const proposal = {linkId:link.id,direction:'hybrid' as const,informal,hybrid,revision:0,explanation:'',replacements:[{entityId:e.id,before:e.text,after:e.text.replace('<=','<'),reason:'constraint'}]}
    expect(prepareTraceProposal(p,doc,proposal,[e.id]).content).toContain('count < limit')
    expect(() => prepareTraceProposal({...p,hybrid:hybrid+'\n'},doc,proposal,[e.id])).toThrow('after preview')
    const other = doc.entities.find(e => e.side === 'hybrid' && e.title === 'Return')!
    expect(() => prepareTraceProposal(p,doc,{...proposal,replacements:[{entityId:other.id,before:other.text,after:other.text.replace('true','false'),reason:''}]},[other.id])).toThrow('outside')
  })
  it('allows a shared dependency edit and keeps other links stale', () => {
    const {doc,p,link} = setup()
    const constant = doc.entities.find(e => e.kind === 'constant')!
    const proposal = {linkId:link.id,direction:'hybrid' as const,informal,hybrid,revision:0,explanation:'',replacements:[{entityId:constant.id,before:constant.text,after:constant.text.replace('5','8'),reason:'capacity'}]}
    const result = prepareTraceProposal(p,doc,proposal,[constant.id])
    expect(result.content).toContain('limit = 8')
    expect(linkState(result.document,link)).toBe('hybrid-changed')
  })
  it('supports reverse natural language updates without rewriting headings', () => {
    const {doc,p,link} = setup()
    const e = doc.entities.find(e => e.id === link.source)!
    const proposal = {linkId:link.id,direction:'informal' as const,informal,hybrid,revision:0,explanation:'',replacements:[{entityId:e.id,before:e.text,after:e.text.replace('5 books','8 books'),reason:'capacity'}]}
    expect(prepareTraceProposal(p,doc,proposal,[e.id]).content).toContain('8 books')
    expect(() => prepareTraceProposal(p,doc,{...proposal,replacements:[{...proposal.replacements[0]!,after:'## New\nOther text\n'}]},[e.id])).toThrow('structure')
  })
})
