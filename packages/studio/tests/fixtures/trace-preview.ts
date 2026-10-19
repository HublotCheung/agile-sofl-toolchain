/** Browser fixture for visual verification. Uses the real components and stores; no LLM/network writes. */
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../../src/renderer/i18n'
import TraceWorkbench from '../../src/renderer/components/workspace/TraceWorkbench.vue'
import TraceBadge from '../../src/renderer/components/workspace/TraceBadge.vue'
import { useTraceabilityStore } from '../../src/renderer/stores/traceability'
import { useDocumentStore } from '../../src/renderer/stores/document'
import { useWorkspaceStore } from '../../src/renderer/stores/workspace'
import { emptyTrace, linkBaseline, type TraceEntity, type TraceDocument } from '../../src/shared/traceability'
import '../../src/renderer/styles/main.css'
const pinia = createPinia(); setActivePinia(pinia)
const clone = <T>(v:T):T => JSON.parse(JSON.stringify(v))
const informal = '# Functions\n## 借阅图书\n每位读者最多借阅 8 本图书。\n# Data Resources\n# Constraints\n'
const hybrid = 'module SYSTEM_Library;\nconst maxBooks = 5;\nprocess Borrow()\npost borrowed <= maxBooks\nend_process;\nend_module;'
let disk:TraceDocument = emptyTrace()
const a:TraceEntity = {id:'r1',side:'informal',locator:'fn-借阅图书',kind:'function',title:'借阅图书',parent:'functions',text:'每位读者最多借阅 8 本图书。',context:'每位读者最多借阅 8 本图书。',shape:'',dependencies:[],start:12,end:36,leaf:true,present:true}
const b:TraceEntity = {id:'p1',side:'hybrid',locator:'proc:Library.Borrow',kind:'process',title:'Borrow',parent:'Library',text:'process Borrow()\npost borrowed <= maxBooks\nend_process;',context:'process Borrow()\npost borrowed <= maxBooks\nend_process;\nconst maxBooks = 5;',shape:'',dependencies:['c1'],start:47,end:100,leaf:true,present:true}
const c:TraceEntity = {...b,id:'c1',locator:'const:Library.maxBooks',kind:'constant',title:'maxBooks',text:'maxBooks = 5;',context:'maxBooks = 5;',dependencies:[],start:29,end:42}
Object.assign(a,{documentId:'doc-r',documentPath:'r.aspec'})
Object.assign(b,{documentId:'doc-s',documentPath:'s.asfl'})
Object.assign(c,{documentId:'doc-s',documentPath:'s.asfl'})
disk.files=[{id:'doc-r',side:'informal',path:'r.aspec',hash:'r',aliases:[],present:true},{id:'doc-s',side:'hybrid',path:'s.asfl',hash:'s',aliases:[],present:true}]
disk.entities = [a,b,c]
disk.links = [{id:'l1',source:a.id,target:b.id,relation:'refines',origin:'manual',review:'confirmed',reason:'Borrow 的借阅数量条件对应需求中的借阅上限。共享常量 maxBooks 当前为 5，需求已经调整为 8。',baseline:{informal:a.context.replace('8','5'),hybrid:b.context}}]
const currentBaseline=linkBaseline(disk,disk.links[0]!)
disk.links[0]!.evidence=[{baseline:currentBaseline,requirementFragment:'最多借阅 8 本',specificationFragment:'maxBooks = 5;',explanation:'约束数值不一致'}]
disk.links[0]!.assessment={baseline:currentBaseline,result:'partial',missingConstraints:['需求中的 8 本上限尚未反映到共享常量。'],explanation:'借阅上限需更新。',reviewer:'model'}
window.studio = {
 traceProviders:async()=>[{id:'studio',name:'Studio model'}],
 traceOnProgress:()=>()=>{},
 traceTransactions:async()=>[],
 traceFinish:async()=>{},
 traceStage:async()=>crypto.randomUUID(),
 traceSaveFiles:async()=>{},
 traceRead:async()=>({document:clone(disk),warnings:[]}),
 traceSave:async(_p,d,revision)=>{disk={...clone(d),revision:revision+1};return clone(disk)},
 traceRecover:async()=>({links:[],informal,hybrid,revision:disk.revision}),
 traceCancel:async()=>{},
 traceSuggest:async(_p,linkId,direction)=>({linkId,direction,informal,hybrid,revision:disk.revision,explanation:'需求将上限从 5 本调整为 8 本。建议仅修改共享常量 maxBooks；Borrow 的条件继续引用该常量。',replacements:[{entityId:'c1',before:c.text,after:'maxBooks = 8;',reason:'使借阅上限与已修改的需求一致。'}]})
} as typeof window.studio
const doc = useDocumentStore(),ws = useWorkspaceStore()
const at=doc.newTab({content:informal,documentKind:'aspec'}),bt=doc.newTab({content:hybrid,documentKind:'asfl'})
doc.markSaved(at.id,'D:/trace-preview/r.aspec','r.aspec');doc.markSaved(bt.id,'D:/trace-preview/s.asfl','s.asfl')
ws.projects=[{id:'preview',name:'Library',rootPath:'D:/trace-preview',createdAt:0,lastOpenedAt:0}];ws.activeProjectId='preview'
ws.scan={root:'D:/trace-preview',manifest:{version:'1.0',name:'Library',informal:'r.aspec',hybrid:['s.asfl']},files:[{kind:'aspec',path:at.filePath!},{kind:'asfl',path:bt.filePath!}],modules:[]}
const trace=useTraceabilityStore();await trace.refreshNow();trace.opened='informal'
createApp({render:()=>h('main',{class:'mx-auto my-6 max-w-3xl rounded-xl border border-border-subtle bg-surface-base p-4 text-content-primary'},[
 h('header',{class:'mb-3 flex items-center gap-3'},[h('h1',{class:'text-lg font-semibold'},'Agile SOFL Studio · Library'),h(TraceBadge,{side:'informal'})]),
 h(TraceWorkbench,{side:'informal'}),h('p',{class:'p-5 text-content-muted'},'Informal / Hybrid editor area — visual verification fixture')
])}).use(pinia).use(i18n).mount('#app')
