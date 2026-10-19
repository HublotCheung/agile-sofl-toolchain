import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { renderToString } from '@vue/server-renderer'
import { i18n } from '../src/renderer/i18n'
import { refreshTrace } from '../src/main/services/traceEngine'
import { emptyTrace, linkBaseline } from '../src/shared/traceability'
import { useTraceabilityStore } from '../src/renderer/stores/traceability'
import { useDocumentStore } from '../src/renderer/stores/document'
import { useWorkspaceStore } from '../src/renderer/stores/workspace'
import TraceWorkbench from '../src/renderer/components/workspace/TraceWorkbench.vue'
vi.mock('../src/renderer/stores/app',()=>({useAppStore:()=>({theme:'light'})}))
describe('lightweight trace interaction',()=>{
  it('exposes three contextual actions instead of relationship management controls',async()=>{
    const pinia=createPinia();setActivePinia(pinia)
    const trace=useTraceabilityStore()
    const pair={root:'D:/trace-ux',informalPath:'D:/trace-ux/r.aspec',hybridPath:'D:/trace-ux/s.asfl',informal:'# Functions\n## Borrow\nFive books.\n# Data Resources\n# Constraints\n',hybrid:'module SYSTEM_Library;\nprocess Borrow()\npost true\nend_process;\nend_module;'}
    const doc=refreshTrace(emptyTrace(),pair),source=doc.entities.find(e=>e.side==='informal')!,target=doc.entities.find(e=>e.kind==='process')!
    doc.links=[{id:'l',source:source.id,target:target.id,relation:'refines',origin:'generated',review:'confirmed',reason:'',baseline:linkBaseline(doc,{source:source.id,target:target.id})}]
    trace.document=refreshTrace(doc,{...pair,informal:pair.informal.replace('Five','Eight')});trace.opened='hybrid'
    const documents=useDocumentStore(),workspace=useWorkspaceStore()
    const a=documents.newTab({content:pair.informal,documentKind:'aspec'}),b=documents.newTab({content:pair.hybrid,documentKind:'asfl'})
    documents.markSaved(a.id,pair.informalPath,'r.aspec');documents.markSaved(b.id,pair.hybridPath,'s.asfl')
    workspace.projects=[{id:'p',name:'UX',rootPath:pair.root,createdAt:0,lastOpenedAt:0}];workspace.activeProjectId='p'
    workspace.scan={root:pair.root,manifest:{version:'1.0',name:'UX',informal:'r.aspec',hybrid:['s.asfl']},files:[{kind:'aspec',path:pair.informalPath},{kind:'asfl',path:pair.hybridPath}],modules:[]}
    const app=createSSRApp({render:()=>h(TraceWorkbench,{side:'hybrid'})}).use(pinia).use(i18n)
    const html=await renderToString(app)
    for(const key of ['trace.acknowledge','trace.editManually','trace.aiEdit'])expect(html).toContain(i18n.global.t(key))
    for(const key of ['trace.accept','trace.reject','trace.assess','trace.rebindPlan','trace.relink','trace.unlink'])expect(html).not.toContain('>'+i18n.global.t(key)+'</button>')
  })
})
