import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { createPinia } from 'pinia'
import { renderToString } from '@vue/server-renderer'
import { i18n } from '../src/renderer/i18n'
vi.mock('../src/renderer/stores/app',()=>({useAppStore:()=>({theme:'light'})}))
vi.mock('vditor',()=>({default:class {}}))
vi.mock('../src/renderer/monaco/setup',()=>({monaco:{},initMonacoBase:vi.fn()}))
vi.mock('../src/renderer/monaco/textmate',()=>({registerLanguageConfiguration:vi.fn(),registerTextMateTokens:vi.fn()}))
vi.mock('../src/renderer/monaco/languageClient',()=>({uriForTab:vi.fn()}))
vi.mock('../src/renderer/monaco/formatProvider',()=>({registerAgileSoflFormatProvider:vi.fn()}))
vi.mock('../src/renderer/stores/lsp',()=>({useLspStore:()=>({running:false})}))
import DocumentView from '../src/renderer/components/workspace/informal/DocumentView.vue'
import MonacoEditor from '../src/renderer/components/editor/MonacoEditor.vue'
describe('trace editor setup lifecycle',()=>{
  it('initializes document watchers before any source tab is selected',async()=>{
    const app=createSSRApp({render:()=>h(DocumentView,{})}).use(createPinia()).use(i18n)
    expect(await renderToString(app)).toContain(i18n.global.t('workspace.noInformal'))
  })
  it('initializes code lens watchers before Monaco boots',async()=>{
    const app=createSSRApp({render:()=>h(MonacoEditor,{})}).use(createPinia()).use(i18n)
    expect(await renderToString(app)).toContain('monaco-editor-shell')
  })
})
