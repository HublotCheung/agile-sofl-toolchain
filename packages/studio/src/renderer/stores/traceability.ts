import { fileBelongsToRoot, filePathsEqual } from './tabUtils'
import { applyRebindPlan, mergeTraceGraphs, relocateTraceDocument, type TraceRebindPlan, type TraceMergeConflict, type TraceStructurePreview } from '../../shared/traceAdvanced'
import { computed, effectScope, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useWorkspaceStore } from './workspace'
import { useDocumentStore } from './document'
import { useHistoryStore } from './history'
import { bindGeneratedTraceSoft, traceNotification, type GeneratedTraceLink } from '../../shared/traceInteraction'
import { emptyTrace, linkBaseline, linkState, sameBaseline,
  type TraceDocument, type TraceEntity, type TraceLink, type TracePair, type TraceProposal, type TraceSide, type TraceIdentityHint } from '../../shared/traceability'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const useTraceabilityStore = defineStore('traceability', () => {
  const workspace = useWorkspaceStore(), documents = useDocumentStore(), history = useHistoryStore()
  const document = ref<TraceDocument>(emptyTrace())
  const error = ref(''), warnings = ref<string[]>([]), busy = ref(false), loading = ref(false)
  const proposal = ref<TraceProposal | null>(null)
  const opened = ref<TraceSide | null>(null)
  const activeAnchor = ref<string | null>(null)
  const focusedId = ref<string | null>(null)
  const followSelection = ref(false)
  const structurePreview=ref<TraceStructurePreview|null>(null)
  const graphVisible=ref(false)
  const providerId=ref('studio'),availableProviders=ref<Array<{id:string;name:string}>>([{id:'studio',name:'Studio model'}])
  const analysisMode=ref<'complete'|'focused'>('complete')
  const progress=ref<{done:number;total:number;candidates:number;cached:number;estimatedTokens:number;status:string}|null>(null)
  const recoveries=ref<Array<{id:string;at:string;state:string;changes:Array<{path:string;side:TraceSide;before:string;after:string}>}>>([])
  const mergePreview=ref<{document:TraceDocument;conflicts:TraceMergeConflict[]}|null>(null)
  let mergeBase:TraceDocument|null=null
  let remoteMerge:{base:TraceDocument;remote:TraceDocument}|null=null
  const recoveryRoots=new Set<string>()
  let started = false, timer: ReturnType<typeof setTimeout> | undefined
  const observationScope = effectScope(true)
  let disposeProgress: (()=>void)|undefined
  onScopeDispose(()=>{observationScope.stop();disposeProgress?.();if(timer)clearTimeout(timer)})
  let activeKey = '', queue: Promise<unknown> = Promise.resolve()
  const renameHints: TraceIdentityHint[] = []
  function hintRename(side: TraceSide, locator: string, title: string,newLocator?:string): void { renameHints.push({ side, locator, title,newLocator,documentPath:side==='informal'?pair.value?.informalPath:pair.value?.hybridPath }) }
  const pair = computed<TracePair | null>(() => {
    const root = workspace.activeProject?.rootPath
    const informal = workspace.informalTab, hybrid = workspace.hybridTab
    if (!root || !informal?.filePath || !hybrid?.filePath) return null
    const sources=new Map<string,{path:string;side:TraceSide;content?:string}>()
    const moduleSlice = (path: string) => /[/\\]\.agile-sofl[/\\]modules[/\\]/i.test(path)
    for(const file of workspace.scan?.files??[]) if(['aspec','asfl'].includes(file.kind) && !moduleSlice(file.path))sources.set(file.path.toLowerCase(),{path:file.path,side:file.kind==='aspec'?'informal':'hybrid'})
    for(const tab of documents.documentTabs) if(tab.filePath&&!moduleSlice(tab.filePath)&&fileBelongsToRoot(tab.filePath,root)&&['aspec','asfl'].includes(tab.documentKind))sources.set(tab.filePath.toLowerCase(),{path:tab.filePath,side:tab.documentKind==='aspec'?'informal':'hybrid',content:tab.content})
    return { root, informalPath: informal.filePath, hybridPath: hybrid.filePath, informal: informal.content, hybrid: hybrid.content,documents:[...sources.values()] }
  })
  const keyOf = (p: TracePair) => JSON.stringify([p.root.toLowerCase()])
  const effectKey = (p: TracePair) => 'trace:' + keyOf(p)
  const present = computed(() => document.value.entities.filter(e => e.present))
  const pending = computed(() => document.value.links.filter(l => l.review === 'confirmed' && linkState(document.value, l) !== 'current'
    && !sameBaseline(l.deferred, linkBaseline(document.value, l))))
  const suggested = computed(() => document.value.links.filter(l => l.review === 'suggested'))
  const notifications = (side: TraceSide) => document.value.links.filter(l => traceNotification(document.value, l, side))
  async function acknowledge(id: string, side: TraceSide): Promise<void> {
    await guarded(() => change('Acknowledge source change', doc => {
      const link = doc.links.find(l => l.id === id)
      if (link) link.acknowledged = { ...link.acknowledged, [side]: linkBaseline(doc, link) }
    }))
  }
  async function editRelated(id: string, side: TraceSide): Promise<void> {
    const link = document.value.links.find(l => l.id === id)
    const entity = document.value.entities.find(e => e.id === (side === 'informal' ? link?.source : link?.target))
    if (entity) await reveal(entity)
    opened.value = null; activeAnchor.value = null
  }
  const proposalStale = computed(() => !!proposal.value && (!pair.value || proposal.value.informal !== pair.value.informal || proposal.value.hybrid !== pair.value.hybrid || proposal.value.revision !== document.value.revision))
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = queue.then(fn)
    queue = job.catch(() => {})
    return job
  }
  function assertPair(expected: TracePair): void {
    if (!pair.value || keyOf(pair.value) !== keyOf(expected) || expected.informal !== pair.value.informal || expected.hybrid !== pair.value.hybrid || (expected.documents??[]).some(d=>d.content!==undefined&&(pair.value!.documents??[]).some(c=>filePathsEqual(absolutePath(c.path),absolutePath(d.path))&&c.content!==undefined&&c.content!==d.content))) {
      throw new Error('Documents changed while processing. Refresh and try again.')
    }
  }
  function assertSnapshots(sources:TracePair['documents']):void {
    for(const source of sources??[]) {
      const current=pair.value?.documents?.find(d=>filePathsEqual(absolutePath(d.path),absolutePath(source.path)))
      if(current?.content!==undefined&&current.content!==source.content)throw new Error('A project document changed during analysis. Refresh and retry.')
    }
  }
  function registerMetadata(p: TracePair): void {
    history.registerEffect(effectKey(p), async raw => {
      await serial(async () => {
        const savedPair = pair.value && keyOf(pair.value) === keyOf(p) ? clone(pair.value) : p
        const current = await window.studio!.traceRead(savedPair)
        const restored = JSON.parse(raw) as TraceDocument
        const saved = await window.studio!.traceSave(savedPair, restored, current.document.revision)
        if (pair.value && keyOf(pair.value) === keyOf(p)) document.value = saved
      })
    })
  }
  async function refreshNow(): Promise<void> {
    const p = pair.value ? clone(pair.value) : null
    if (!p) { activeKey = ''; document.value = emptyTrace(); proposal.value = null; return }
    if (!window.studio?.traceRead) return
    loading.value = true
    try {
      await serial(async () => {
        const hints = clone(renameHints)
        const result = await window.studio!.traceRead(p, hints)
        assertPair(p)
        // Registry snapshots persist separately from the last-confirmed link baselines.
        const changed = activeKey !== keyOf(p) || JSON.stringify(result.document.entities) !== JSON.stringify(document.value.entities)
          || JSON.stringify(result.document.links) !== JSON.stringify(document.value.links) || JSON.stringify(result.document.files)!==JSON.stringify(document.value.files)
        let saved = result.document
        if (changed) {
          try {
            saved = await window.studio!.traceSave(p, clone(result.document), result.document.revision)
          } catch (e) {
            warnings.value = [`Trace metadata was not saved: ${e instanceof Error ? e.message : String(e)}`]
            saved = result.document
          }
        }
        assertPair(p)
        renameHints.splice(0, hints.length)
        activeKey = keyOf(p); document.value = saved; warnings.value = result.warnings
        if(!mergeBase)mergeBase=clone(saved)
        if(!recoveryRoots.has(p.root)&&window.studio?.traceTransactions){recoveries.value=await window.studio.traceTransactions(p);recoveryRoots.add(p.root)}
        registerMetadata(p)
      })
    } finally { loading.value = false }
  }
  function start(): void {
    if (started) return
    started = true
    if(window.studio?.traceProviders)void window.studio.traceProviders().then(p=>{availableProviders.value=p}).catch(()=>{})
    disposeProgress=window.studio?.traceOnProgress?.(value=>{if(pair.value?.root===value.root)progress.value=value})
    observationScope.run(()=>{
    watch(pair, (next, previous) => {
      if (timer) clearTimeout(timer)
      if (!next || !previous || keyOf(next) !== keyOf(previous)) {
        document.value = emptyTrace(); proposal.value = null; focusedId.value = null; error.value = ''; activeKey = ''; renameHints.length = 0; mergeBase=null;recoveries.value=[];progress.value=null
      }
      timer = setTimeout(() => { void refreshNow().catch(e => { error.value = String(e.message ?? e) }) }, 420)
    }, { immediate: true })
    watch(() => [workspace.informalSelectedNodeId, workspace.selection] as const, () => {
      if (!followSelection.value || !opened.value) return
      const current = selectedEntity(opened.value)
      if (current) focusedId.value = current.id
    })
    })
  }
  async function guarded(fn: () => Promise<void>): Promise<void> {
    if (busy.value) return
    error.value = ''; busy.value = true
    try { await fn() } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
    finally { busy.value = false }
  }
  async function change(label: string, mutate: (doc: TraceDocument) => void, attachCommandId?: string): Promise<void> {
    if (!pair.value) throw new Error('Open a saved informal / hybrid pair first.')
    await refreshNow()
    const p = clone(pair.value!), before = clone(document.value), after = clone(before)
    mutate(after)
    await serial(async () => {
      assertPair(p)
      const saved = await window.studio!.traceSave(p, after, before.revision)
      document.value = saved
      const effects = [{ key: effectKey(p), before: JSON.stringify(before), after: JSON.stringify(saved) }]
      if (!attachCommandId || !history.attachEffects(attachCommandId, effects)) {
        history.commit({ kind: 'traceability', label, immediate: true, mutations: [], effects })
      }
    })
  }
  function selectedEntity(side: TraceSide): TraceEntity | undefined {
    if (side === 'informal') return present.value.find(e => e.side === side && e.locator === workspace.informalSelectedNodeId && (!e.documentPath || filePathsEqual(absolutePath(e.documentPath),workspace.informalTab!.filePath!)))
    const s = workspace.selection
    if (!s) return undefined
    const title = s.kind === 'process' ? s.processName : s.kind === 'function' ? s.functionName : ''
    return present.value.find(e => e.side === side && e.parent === s.moduleName && e.title === title && (!e.documentPath||filePathsEqual(absolutePath(e.documentPath),workspace.hybridTab!.filePath!)))
  }
  function open(side: TraceSide, locator?: string): void {
    activeAnchor.value = null
    proposal.value = null
    opened.value = opened.value === side && !locator ? null : side
    focusedId.value = (locator ? present.value.find(e => e.side === side && e.locator === locator && (!e.documentPath||filePathsEqual(absolutePath(e.documentPath),(side==='informal'?workspace.informalTab:workspace.hybridTab)!.filePath!))) : selectedEntity(side))?.id ?? null
  }
  function absolutePath(path:string):string { return /^(?:[A-Za-z]:|[/\\])/.test(path)?path:(pair.value!.root.replace(/[\\/]$/,'')+'/'+path) }
  async function reveal(entity: TraceEntity): Promise<void> {
    if (!entity.present || entity.start < 0 || !pair.value) return
    const path=entity.documentPath?absolutePath(entity.documentPath):(entity.side==='informal'?pair.value.informalPath:pair.value.hybridPath)
    let tab=documents.documentTabs.find(t=>t.filePath&&filePathsEqual(t.filePath,path))
    if(!tab){const file=await window.studio!.fileRead(path);tab=documents.openFromFile(path,file.content,file.title)}
    const source=tab.content
    const prefix = source.slice(0, entity.start)
    workspace.revealEditorMatch({ filePath: path,
      kind: entity.side === 'informal' ? 'aspec' : 'asfl', start: entity.start, end: entity.end,
      line: prefix.split('\n').length, column: entity.start - prefix.lastIndexOf('\n'), text: entity.text })
    if (entity.side === 'informal') workspace.informalSelectedNodeId = entity.locator
  }
  async function manual(source: string, target: string, reason: string, replaceId?: string): Promise<void> {
    await guarded(() => change('Trace link', doc => {
      if (!doc.entities.some(e => e.id === source && e.side === 'informal' && e.present) || !doc.entities.some(e => e.id === target && e.side === 'hybrid' && e.present)) throw new Error('Choose both trace endpoints.')
      if (doc.links.some(l => l.id !== replaceId && l.source === source && l.target === target && l.review !== 'rejected')) throw new Error('These items are already linked.')
      const previous = doc.links.find(l => l.id === replaceId || (l.source === source && l.target === target))
      const sourceKind = doc.entities.find(e => e.id === source)!.kind
      const relation = sourceKind === 'constraint' ? 'constrains' : ['data-resource','data-field'].includes(sourceKind) ? 'uses' : 'refines'
      const link: TraceLink = { id: previous?.id ?? crypto.randomUUID(), source, target, reason, origin: 'manual', relation, review: 'confirmed', baseline: linkBaseline(doc, { source, target }) }
      doc.links = [...doc.links.filter(l => l.id !== link.id), link]
    }))
  }
  async function review(id: string, action: 'accept' | 'reject' | 'check' | 'defer' | 'remove', note = ''): Promise<void> {
    await guarded(() => change('Review trace link', doc => {
      const link = doc.links.find(l => l.id === id)
      if (!link) throw new Error('Link no longer exists.')
      if (action === 'remove') { doc.links = doc.links.filter(l => l.id !== id); return }
      if (action === 'reject') { link.review = 'rejected'; link.baseline = linkBaseline(doc, link); return }
      if (linkState(doc, link) === 'missing') throw new Error('Relink the missing endpoint first.')
      if (action === 'defer') { link.deferred = linkBaseline(doc, link); return }
      if (action === 'check' && !note.trim()) throw new Error('Record why no further update is needed.')
      link.review = 'confirmed'; link.baseline = linkBaseline(doc, link); link.deferred = undefined; link.note = note
    }))
  }
  async function recover(locale: string, scope: string[]): Promise<void> {
    await guarded(async () => {
      await history.flushRegistered()
      await refreshNow()
      const p = clone(pair.value!)
      const result = await window.studio!.traceRecover(p, scope, locale, {mode:analysisMode.value,provider:providerId.value})
      assertPair(p);assertSnapshots(result.documents)
      if (result.revision !== document.value.revision) throw new Error('Trace links changed. Run recovery again.')
      await change('Recover trace links', doc => {
        if (doc.revision !== result.revision) throw new Error('Trace links changed. Run recovery again.')
        const ids = new Set(result.links.map(l => l.id))
        doc.links = [...doc.links.filter(l => !ids.has(l.id)), ...result.links.map(l => ({...l,review:'confirmed' as const}))]
      })
      if (!result.links.length) warnings.value = ['No new trace candidates found. You can create a link manually.']
    })
  }
  async function suggest(id: string, direction: TraceSide, locale: string): Promise<void> {
    await guarded(async () => {
      await history.flushRegistered()
      await refreshNow()
      const p = clone(pair.value!)
      const result = await window.studio!.traceSuggest(p, id, direction, locale,{provider:providerId.value})
      assertPair(p);assertSnapshots(result.documents)
      proposal.value = result
    })
  }
  async function applyProposal(selected: string[], label: string): Promise<void> {
    await guarded(async () => {
      await history.flushRegistered()
      if (!proposal.value || !selected.length) return
      const preview = clone(proposal.value), p = clone(pair.value!)
      const before = clone(document.value)
      const result = await window.studio!.tracePrepare(p, preview, selected)
      assertPair(p)
      if (preview.revision !== document.value.revision) throw new Error('Trace links changed after preview.')
      const fallback=preview.direction==='informal'?workspace.informalTab:workspace.hybridTab
      if(!fallback)throw new Error('Target document is closed.')
      const changes=result.changes??[{path:fallback.filePath!,side:preview.direction,before:fallback.content,after:result.content}]
      // A complete reviewed application establishes a new baseline only for this link.
      if (selected.length === preview.replacements.length) {
        const link = result.document.links.find(l => l.id === preview.linkId)!
        link.baseline = linkBaseline(result.document, link); link.deferred = undefined
      }
      const journalId=window.studio?.traceStage?await window.studio.traceStage(p,result.document,changes):null
      if(journalId)history.registerEffect('trace-transaction:'+journalId,async side=>{await window.studio!.traceFinish(p,journalId,side as 'buffers-applied'|'discarded')})
      await serial(async () => {
        assertPair(p)
        const saved = await window.studio!.traceSave(p, result.document, before.revision)
        try { assertPair(p) } catch (error) {
          // Text may change while the IPC write is in flight. Restore metadata and
          // leave the user's newer buffer untouched.
          document.value = await window.studio!.traceSave(p, before, saved.revision)
          if(journalId)await window.studio!.traceFinish(p,journalId,'discarded')
          throw error
        }
        const mutations=changes.map(c=>{
          const path=absolutePath(c.path)
          let tab=documents.documentTabs.find(t=>t.filePath&&filePathsEqual(t.filePath,path))
          if(!tab)tab=documents.openFromFile(path,c.before,path.split(/[/\\]/).pop()??path)
          documents.setContent(tab.id,c.after)
          return {tabId:tab.id,filePath:path,before:c.before,after:c.after}
        })
        document.value = saved
        history.commit({ kind: 'traceability', label, immediate: true,
          mutations,
          effects: [{ key: effectKey(p), before: JSON.stringify(before), after: JSON.stringify(saved) },...(journalId?[{key:'trace-transaction:'+journalId,before:'discarded',after:'buffers-applied'}]:[])] })
        if(journalId)void window.studio!.traceFinish(p,journalId,'buffers-applied').catch(e=>{error.value=String(e)})
        proposal.value = null
        void workspace.resyncModulesFromOpenTabs()
      })
    })
  }
  async function applyGeneratedContent(beforeText: string, next: string, links: GeneratedTraceLink[]): Promise<{ warnings: string[] }> {
    await history.flushRegistered()
    if (!pair.value) throw new Error('Open and save the project Informal and Hybrid files before applying modeled nodes.')
    const liveHybrid = workspace.hybridTab?.content
    const textAlreadyCommitted = liveHybrid === next
    if (liveHybrid !== beforeText && !textAlreadyCommitted) throw new Error('The specification changed. Generate a new preview.')
    await refreshNow()
    const p = clone(pair.value!), before = clone(document.value)
    const nextPair = {...p,hybrid:next,documents:p.documents?.map(d=>filePathsEqual(absolutePath(d.path),p.hybridPath)?{...d,content:next}:d)}
    const result = await window.studio!.traceRead(nextPair)
    assertPair(p)
    if (result.document.revision !== before.revision) throw new Error('Project changed during modeling. Retry the preview.')
    const soft = bindGeneratedTraceSoft(before,result.document,links,p.informalPath,p.hybridPath,()=>crypto.randomUUID())
    const warningsOut = [...soft.warnings]
    const tab = workspace.hybridTab!
    const changes = [{path:p.hybridPath,side:'hybrid' as const,before:beforeText,after:next}]
    const keepText = () => {
      if (!tab || workspace.hybridTab?.content !== beforeText) return
      documents.setContent(tab.id, next)
      history.commit({kind:'traceability',label:'Apply modeling with source bindings',immediate:true,mutations:[{tabId:tab.id,filePath:p.hybridPath,before:beforeText,after:next}],effects:[]})
    }
    let journalId: string | null = null
    try {
      journalId = window.studio?.traceStage ? await window.studio.traceStage(p,result.document,changes) : null
      await serial(async()=>{
        try {
          assertPair(p)
          if (workspace.hybridTab?.content !== beforeText && workspace.hybridTab?.content !== next) throw new Error('Documents changed while processing. Refresh and try again.')
          const saved = await window.studio!.traceSave(p,result.document,before.revision)
          try { assertPair(p) } catch(e) { document.value=await window.studio!.traceSave(p,before,saved.revision);throw e }
          if (workspace.hybridTab?.content !== beforeText && workspace.hybridTab?.content !== next) {
            document.value=await window.studio!.traceSave(p,before,saved.revision)
            throw new Error('Documents changed while processing. Refresh and try again.')
          }
          if (workspace.hybridTab?.content !== next) documents.setContent(tab.id,next)
          document.value=saved
          if(journalId)history.registerEffect('trace-transaction:'+journalId,async state=>{await window.studio!.traceFinish(p,journalId,state as 'buffers-applied'|'discarded')})
          if (!textAlreadyCommitted) history.commit({kind:'traceability',label:'Apply modeling with source bindings',immediate:true,mutations:[{tabId:tab.id,filePath:p.hybridPath,before:beforeText,after:next}],effects:[{key:effectKey(p),before:JSON.stringify(before),after:JSON.stringify(saved)},...(journalId?[{key:'trace-transaction:'+journalId,before:'discarded',after:'buffers-applied'}]:[])]})
        } catch(e) { if(journalId)await window.studio!.traceFinish(p,journalId,'discarded');throw e }
      })
      if(journalId)await window.studio!.traceFinish(p,journalId,'buffers-applied').catch(e=>{warningsOut.push(String(e))})
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/changed|preview/i.test(message)) throw e
      warningsOut.push(`Trace metadata was not updated: ${message}. The specification text was kept.`)
      keepText()
    }
    void workspace.resyncModulesFromOpenTabs()
    if (warningsOut.length) warnings.value = warningsOut
    return { warnings: warningsOut }
  }
  async function rebind(plan:TraceRebindPlan):Promise<void> {
    await guarded(()=>change('Rebind trace links',doc=>{const result=applyRebindPlan(doc,plan,()=>crypto.randomUUID());doc.links=result.links}))
  }
  async function reviewMany(ids:string[], action:'accept'|'reject'|'check'|'defer', note:string):Promise<void> {
    await guarded(()=>change('Review selected trace links',doc=>{
      if(action==='check'&&!note.trim())throw new Error('Record why no update is needed.')
      for(const l of doc.links.filter(l=>ids.includes(l.id))) {
        if(action==='reject'){l.review='rejected';l.baseline=linkBaseline(doc,l);continue}
        if(linkState(doc,l)==='missing')throw new Error('Relink missing endpoints first.')
        if(action==='defer'){l.deferred=linkBaseline(doc,l);continue}
        l.review='confirmed';l.baseline=linkBaseline(doc,l);l.deferred=undefined;l.note=note
      }
    }))
  }
  async function assess(id:string,locale:string):Promise<void>{
    await guarded(async()=>{
      await refreshNow();const p=clone(pair.value!),result=await window.studio!.traceAssess(p,id,locale,{provider:providerId.value});assertPair(p)
      await change('Assess trace coverage',doc=>{if(doc.revision!==result.revision)throw new Error('Content changed during assessment.');const l=doc.links.find(l=>l.id===id)!;l.assessment=result.assessment;l.evidence=result.evidence})
    })
  }
  async function recoverTransaction(id:string,choice:'restore'|'discard'):Promise<void>{
    await guarded(async()=>{
      const p=clone(pair.value!),journal=await window.studio!.traceRestore(p,id,choice);assertPair(p)
      if(choice==='restore'){
        const before=clone(document.value),merged=mergeTraceGraphs(journal.before,before,journal.after)
        if(merged.conflicts.length)throw new Error('Recovery metadata conflicts with newer review decisions. Use collaboration comparison first.')
        const saved=await window.studio!.traceSave(p,merged.document,before.revision)
        assertPair(p)
        const mutations=journal.changes.map(c=>{const path=absolutePath(c.path);let tab=documents.documentTabs.find(t=>t.filePath&&filePathsEqual(t.filePath,path));if(!tab)tab=documents.openFromFile(path,c.before,path.split(/[/\\]/).pop()!);const prior=tab.content;documents.setContent(tab.id,c.after);return {tabId:tab.id,filePath:path,before:prior,after:c.after}})
        document.value=saved
        history.commit({kind:'traceability',label:'Restore trace update',immediate:true,mutations,effects:[{key:effectKey(p),before:JSON.stringify(before),after:JSON.stringify(saved)}]})
        await window.studio!.traceFinish(p,id,'buffers-applied')
      }
      recoveries.value=recoveries.value.filter(j=>j.id!==id)
    })
  }
  async function saveLinkedFiles():Promise<void>{
    await guarded(async()=>{
      await history.flushRegistered();await refreshNow();const p=clone(pair.value!)
      const changes=[]
      for(const tab of documents.documentTabs.filter(t=>t.isDirty&&t.filePath&&fileBelongsToRoot(t.filePath,p.root)&&['aspec','asfl'].includes(t.documentKind))){if(tab.savedContent===undefined)throw new Error('The saved baseline is unavailable. Compare this restored buffer with its file before saving.');changes.push({path:tab.filePath!,side:tab.documentKind==='aspec'?'informal' as const:'hybrid' as const,before:tab.savedContent,after:tab.content})}
      assertPair(p);await window.studio!.traceSaveFiles(p,changes,document.value.revision);assertPair(p)
      for(const c of changes){const tab=documents.documentTabs.find(t=>t.filePath&&filePathsEqual(t.filePath,c.path))!;documents.markSaved(tab.id,c.path,tab.title)}
      recoveries.value=[]
    })
  }
  async function exportReview():Promise<void>{
    await guarded(async()=>{await refreshNow();const path=await window.studio!.fileSaveDialog('trace-review.json','json');if(path)await window.studio!.fileWrite(path,JSON.stringify({format:'agile-sofl-trace-review-v1',base:mergeBase??document.value,remote:document.value},null,2))})
  }
  async function importReview(choices:Record<string,'local'|'remote'>={}):Promise<void>{
    await guarded(async()=>{
      if(!Object.keys(choices).length){const file=await window.studio!.fileOpenDialog('json');if(!file)return;const data=JSON.parse(file.content);if(data.format!=='agile-sofl-trace-review-v1')throw new Error('Choose an exported trace review snapshot.');remoteMerge={base:data.base,remote:data.remote}}
      if(!remoteMerge)return
      mergePreview.value=await window.studio!.traceMerge(clone(pair.value!),remoteMerge.base,remoteMerge.remote,choices)
    })
  }
  async function applyMerge():Promise<void>{
    const preview=mergePreview.value
    if(!preview||preview.conflicts.length)return
    await guarded(()=>change('Merge trace reviews',doc=>{if(doc.revision!==preview.document.revision)throw new Error('Reviews changed after merge preview. Compare again.');doc.entities=preview.document.entities;doc.links=preview.document.links;doc.files=preview.document.files}))
    if(!error.value){mergePreview.value=null;remoteMerge=null}
  }
  async function previewStructure(ids:string[],parts:Array<{title:string;description:string}>):Promise<void>{
    await guarded(async()=>{await history.flushRegistered();await refreshNow();const p=clone(pair.value!);const result=await window.studio!.traceStructurePreview(p,ids,parts);assertPair(p);structurePreview.value=result})
  }
  async function applyStructure(plan:TraceRebindPlan):Promise<void>{
    await guarded(async()=>{
      if(!structurePreview.value)return
      const p=clone(pair.value!),before=clone(document.value)
      const result=await window.studio!.traceStructurePrepare(p,structurePreview.value.id,plan);assertPair(p)
      const changes=result.changes??[]
      await serial(async()=>{
        assertPair(p)
        const journalId=await window.studio!.traceStage(p,result.document,changes)
        try{
      const saved=await window.studio!.traceSave(p,result.document,before.revision)
      try{assertPair(p)}catch(e){document.value=await window.studio!.traceSave(p,before,saved.revision);await window.studio!.traceFinish(p,journalId,'discarded');throw e}
      const mutations=changes.map(c=>{const path=absolutePath(c.path);let tab=documents.documentTabs.find(t=>t.filePath&&filePathsEqual(t.filePath,path));if(!tab)tab=documents.openFromFile(path,c.before,path.split(/[/\\]/).pop()!);documents.setContent(tab.id,c.after);return {tabId:tab.id,filePath:path,before:c.before,after:c.after}})
      history.registerEffect('trace-transaction:'+journalId,async state=>{await window.studio!.traceFinish(p,journalId,state as 'buffers-applied'|'discarded')})
      document.value=saved
      history.commit({kind:'traceability',label:'Split or merge requirements',immediate:true,mutations,effects:[{key:effectKey(p),before:JSON.stringify(before),after:JSON.stringify(saved)},{key:'trace-transaction:'+journalId,before:'discarded',after:'buffers-applied'}]})
      structurePreview.value=null;void window.studio!.traceFinish(p,journalId,'buffers-applied').catch(e=>{error.value=String(e)})
        }catch(error){await window.studio!.traceFinish(p,journalId,'discarded');throw error}
      })
    })
  }
  async function relocateFile(from:string,to:string):Promise<void>{await guarded(()=>change('Relocate trace document',doc=>{const next=relocateTraceDocument(doc,from,to).document;doc.entities=next.entities;doc.links=next.links;doc.files=next.files}))}
  return { document, error, warnings, busy, loading, proposal, proposalStale, opened, focusedId, followSelection,
    pair, present, pending, suggested, notifications, acknowledge, editRelated, activeAnchor, applyGeneratedContent, start, refreshNow, open, reveal, manual, review, recover, suggest, applyProposal, hintRename, rebind, reviewMany, absolutePath, graphVisible, providerId, availableProviders, structurePreview, previewStructure, applyStructure, analysisMode, progress, assess, recoveries, recoverTransaction, saveLinkedFiles, mergePreview, importReview, exportReview, applyMerge, relocateFile }
})
