<script setup lang="ts">
import { useTraceabilityStore } from '../../../stores/traceability'
import { traceNotification } from '../../../../shared/traceInteraction'
import TraceBadge from '../TraceBadge.vue'
import { filePathsEqual } from '../../../stores/tabUtils'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { useDocumentStore } from '../../../stores/document'
import { useHistoryStore } from '../../../stores/history'
import { HistoryKinds } from '../../../history/kinds'
import { useAppStore } from '../../../stores/app'
import { useWorkspaceStore } from '../../../stores/workspace'
import { findHeadingIndex, selectElementText } from '../../../lib/structureNav'
import { localeForMilkdown, type Locale } from '../../../i18n'

type InformalSection = 'functions' | 'data-resources' | 'constraints'

const props = defineProps<{ tabId?: string }>()
const emit = defineEmits<{ add: [section: InformalSection] }>()
const { t, locale } = useI18n()
const doc = useDocumentStore()
const history = useHistoryStore()
const app = useAppStore()
const workspace = useWorkspaceStore()
const trace=useTraceabilityStore()
const traceAnchors=ref<Array<{id:string;locator:string;top:number;count:number;pending:boolean}>>([])
let traceFrame=0
function syncTraceAnchors(){
  const shell=host.value?.parentElement,current=tab.value
  if(!shell||!current?.filePath)return
  const rect=shell.getBoundingClientRect(),used=new Set<string>(),anchors:typeof traceAnchors.value=[]
  for(const heading of headingElements()){
    const entity=trace.present.find(e=>e.side==='informal'&&!used.has(e.id)&&e.title===(heading.textContent??'').trim()&&e.documentPath&&filePathsEqual(trace.absolutePath(e.documentPath),current.filePath!))
    if(!entity)continue;used.add(entity.id)
    const position=heading.getBoundingClientRect(),top=position.top-rect.top
    if(top<28||top>rect.height-20)continue
    const links=trace.document.links.filter(l=>l.review!=='rejected'&&l.source===entity.id)
    if(links.length)anchors.push({id:entity.id,locator:entity.locator,top,count:links.length,pending:links.some(l=>traceNotification(trace.document,l,'informal'))})
  }
  traceAnchors.value=anchors
}
function scheduleTraceAnchors(){if(traceFrame)cancelAnimationFrame(traceFrame);traceFrame=requestAnimationFrame(syncTraceAnchors)}
const host = ref<HTMLElement | null>(null)
const isDark = ref(typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
let editor: Vditor | null = null
let applyingExternal = false
type RevealRequest = {
  span: { start: number; end: number; line: number; column: number; title?: string }
  title?: string
  text?: string
  select?: boolean
}
let pendingReveal: RevealRequest | null = null

const tab = computed(() => {
  if (!props.tabId) return null
  const found = doc.tabs.find((t) => t.id === props.tabId)
  return found?.kind === 'document' ? found : null
})

watch(()=>[trace.document.revision,tab.value?.content],()=>void nextTick(scheduleTraceAnchors))

function vditorCdn(): string {
  return new URL('vditor', window.location.href).href.replace(/\/?$/, '')
}

function syncTheme(): void {
  isDark.value = document.documentElement.classList.contains('dark')
  editor?.setTheme(isDark.value ? 'dark' : 'classic', isDark.value ? 'dark' : 'light')
}

function onChange(value: string): void {
  const current = tab.value
  if (!current || applyingExternal || history.applying) return
  if (value === current.content) return
  history.applyDocument(current.id, value, {
    kind: HistoryKinds.informalEdit,
    coalesceKey: 'informal-md',
    immediate: false
  })
}

function toolbarItem(section: InformalSection, label: string) {
  return {
    name: `add-${section}`,
    tip: label,
    tipPosition: 's' as const,
    className: 'informal-vd-tool',
    icon: `<span class="informal-vd-btn">+ ${label}</span>`,
    click() {
      emit('add', section)
    }
  }
}

function mountEditor(): void {
  if (!host.value || !tab.value) return
  editor?.destroy()
  editor = null
  const start = tab.value.content
  editor = new Vditor(host.value, {
    cdn: vditorCdn(),
    mode: 'wysiwyg',
    height: '100%',
    lang: localeForMilkdown(locale.value as Locale),
    theme: isDark.value ? 'dark' : 'classic',
    icon: 'material',
    cache: { enable: false },
    counter: { enable: false },
    outline: { enable: false },
    resize: { enable: false },
    placeholder: '# Functions',
    toolbar: [
      toolbarItem('functions', t('informal.function')),
      toolbarItem('data-resources', t('informal.data')),
      toolbarItem('constraints', t('informal.constraint'))
    ],
    preview: {
      mode: 'editor',
      actions: [],
      markdown: { toc: false, mark: true },
      theme: { current: isDark.value ? 'dark' : 'light' }
    },
    after: () => {
      applyingExternal = true
      editor?.setValue(start, true)
      applyingExternal = false
      void nextTick(() => applyPendingReveal())
    },
    input: (value: string) => onChange(value)
  })
}

function headingElements(): HTMLElement[] {
  const root = host.value
  if (!root) return []
  return Array.from(
    root.querySelectorAll(
      '.vditor-wysiwyg h1, .vditor-wysiwyg h2, .vditor-wysiwyg h3, .vditor-wysiwyg h4, .vditor-wysiwyg h5, .vditor-wysiwyg h6, .vditor-reset h1, .vditor-reset h2, .vditor-reset h3'
    )
  ) as HTMLElement[]
}

function revealTextInWysiwyg(text: string): boolean {
  const root = host.value?.querySelector('.vditor-wysiwyg, .vditor-reset')
  if (!root || !text) return false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? ''
    const index = value.indexOf(text)
    if (index < 0) continue
    const parent = node.parentElement
    if (!parent) continue
    parent.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const range = document.createRange()
    range.setStart(node, index)
    range.setEnd(node, Math.min(value.length, index + text.length))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    parent.classList.add('informal-md-flash')
    window.setTimeout(() => parent.classList.remove('informal-md-flash'), 1800)
    return true
  }
  return false
}

function applyPendingReveal(): void {
  const request = pendingReveal
  if (!request || !host.value) return
  if (request.text && revealTextInWysiwyg(request.text)) {
    pendingReveal = null
    return
  }
  const headings = headingElements()
  const idx = findHeadingIndex(headings, {
    title: request.title ?? request.span.title,
    line: request.span.line
  })
  const target = idx >= 0 ? headings[idx] : undefined
  if (!target) return
  pendingReveal = null
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (request.select !== false) selectElementText(target)
  target.classList.add('informal-md-flash')
  window.setTimeout(() => target.classList.remove('informal-md-flash'), 1800)
}

function revealSpan(
  span: { start: number; end: number; line: number; column: number; title?: string },
  options?: { title?: string; select?: boolean; text?: string }
): void {
  pendingReveal = {
    span,
    title: options?.title ?? span.title,
    text: options?.text,
    select: options?.select
  }
  applyPendingReveal()
}

watch(
  () => tab.value?.id,
  async () => {
    await nextTick()
    mountEditor()
  }
)

watch(
  () => tab.value?.content,
  (content) => {
    if (content == null || !editor) return
    if (content === editor.getValue()) return
    applyingExternal = true
    editor.setValue(content, true)
    applyingExternal = false
    void nextTick(() => applyPendingReveal())
  }
)

watch(() => app.theme, syncTheme)
watch(locale, () => void mountEditor())
watch(
  () => workspace.fullscreenPanel,
  async () => {
    await nextTick()
    if (tab.value) mountEditor()
  }
)

onMounted(() => {
  trace.start()
  host.value?.addEventListener('scroll',scheduleTraceAnchors,true)
  const traceObserver=new MutationObserver(scheduleTraceAnchors)
  if(host.value)traceObserver.observe(host.value,{subtree:true,childList:true,characterData:true})
  const traceResize=new ResizeObserver(scheduleTraceAnchors)
  if(host.value)traceResize.observe(host.value)
  syncTheme()
  const observer = new MutationObserver(syncTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  let idleId = 0
  let timer = 0
  const start = () => mountEditor()
  if (typeof window.requestIdleCallback === 'function') {
    idleId = window.requestIdleCallback(start, { timeout: 500 })
  } else {
    timer = window.setTimeout(start, 32)
  }
  onUnmounted(() => {
    if (idleId) window.cancelIdleCallback(idleId)
    if (timer) window.clearTimeout(timer)
    observer.disconnect()
    traceObserver.disconnect();traceResize.disconnect()
    host.value?.removeEventListener('scroll',scheduleTraceAnchors,true)
    if(traceFrame)cancelAnimationFrame(traceFrame)
    editor?.destroy()
    editor = null
  })
})

defineExpose({ revealSpan })
</script>

<template>
  <div v-if="tabId && tab" class="informal-md-shell relative h-full min-h-0 min-w-0">
    <div ref="host" class="informal-vditor h-full min-h-0" />
    <div class="pointer-events-none absolute inset-0 z-10" :aria-label="t('trace.links')">
      <div v-for="a in traceAnchors" :key="a.id" class="pointer-events-auto absolute right-2" :style="{top:a.top+'px'}" @mousedown.prevent><TraceBadge side="informal" :locator="a.locator" /></div>
    </div>
  </div>
  <p v-else class="p-4 text-xs text-content-muted">{{ $t('workspace.noInformal') }}</p>
</template>

<style scoped>
.informal-md-shell {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--gui-canvas);
}

.informal-vditor {
  min-height: 0;
  flex: 1;
}

.informal-md-shell :deep(.vditor) {
  position: relative;
  z-index: 0;
  height: 100%;
  border: none;
  background: var(--gui-canvas);
}

.informal-md-shell :deep(.vditor--fullscreen) {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  z-index: 0 !important;
}

.informal-md-shell :deep(.vditor-toolbar) {
  border-bottom: 1px solid var(--gui-hairline);
  background: var(--gui-canvas-soft);
  padding: 2px 6px;
}

.informal-md-shell :deep(.informal-vd-tool) {
  padding: 0 2px !important;
  width: auto !important;
}

.informal-md-shell :deep(.informal-vd-tool .vditor-tooltipped) {
  height: auto;
  width: auto !important;
  line-height: 1;
  padding: 0;
}

.informal-md-shell :deep(.informal-vd-btn) {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-secondary);
  white-space: nowrap;
}

.informal-md-shell :deep(.informal-vd-tool:hover .informal-vd-btn) {
  background: var(--surface-overlay);
  color: var(--text-primary);
}

.informal-md-shell :deep(.vditor-content),
.informal-md-shell :deep(.vditor-wysiwyg),
.informal-md-shell :deep(.vditor-reset) {
  background: var(--gui-canvas);
  color: var(--gui-ink);
  font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Source Serif 4', serif;
  font-size: 15px;
  line-height: 1.7;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

.informal-md-shell :deep(.vditor-content::-webkit-scrollbar),
.informal-md-shell :deep(.vditor-wysiwyg::-webkit-scrollbar),
.informal-md-shell :deep(.vditor-reset::-webkit-scrollbar) {
  width: var(--scrollbar-size);
  height: var(--scrollbar-size);
}

.informal-md-shell :deep(.vditor-content::-webkit-scrollbar-track),
.informal-md-shell :deep(.vditor-wysiwyg::-webkit-scrollbar-track),
.informal-md-shell :deep(.vditor-reset::-webkit-scrollbar-track) {
  background: var(--scrollbar-track);
  border-radius: 999px;
}

.informal-md-shell :deep(.vditor-content::-webkit-scrollbar-thumb),
.informal-md-shell :deep(.vditor-wysiwyg::-webkit-scrollbar-thumb),
.informal-md-shell :deep(.vditor-reset::-webkit-scrollbar-thumb) {
  background: var(--scrollbar-thumb);
  border-radius: 999px;
  border: 1px solid transparent;
  background-clip: padding-box;
}

.informal-md-shell :deep(.vditor-content::-webkit-scrollbar-thumb:hover),
.informal-md-shell :deep(.vditor-wysiwyg::-webkit-scrollbar-thumb:hover),
.informal-md-shell :deep(.vditor-reset::-webkit-scrollbar-thumb:hover) {
  background: var(--scrollbar-thumb-hover);
  background-clip: padding-box;
}

.informal-md-shell :deep(.vditor-outline),
.informal-md-shell :deep(.vditor-counter),
.informal-md-shell :deep(.vditor-resize) {
  display: none;
}

.informal-md-shell :deep(.informal-vd-tool .vditor-tooltipped::after),
.informal-md-shell :deep(.informal-vd-tool .vditor-tooltipped::before) {
  display: none !important;
}

.informal-md-shell :deep(.informal-md-flash) {
  background: color-mix(in srgb, var(--text-primary) 10%, transparent);
  transition: background 1.4s ease;
}
</style>
