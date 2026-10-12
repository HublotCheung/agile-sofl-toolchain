<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, shallowRef, computed, nextTick } from 'vue'
import type * as Monaco from 'monaco-editor'
import { monaco, initMonacoBase } from '../../monaco/setup'
import { registerLanguageConfiguration, registerTextMateTokens } from '../../monaco/textmate'
import { uriForTab } from '../../monaco/languageClient'
import { buildMinimapOptions } from '../../monaco/minimapOptions'
import { registerAgileSoflFormatProvider } from '../../monaco/formatProvider'
import { EDIT_COMMAND_IDS } from '../../composables/editCommands'
import { useDocumentStore } from '../../stores/document'
import { useHistoryStore } from '../../stores/history'
import { historyKindForDocument } from '../../history/kinds'
import { useLspStore } from '../../stores/lsp'
import { useLspDiagnosticsStore } from '../../stores/lspDiagnostics'
import type { DiagnosticSummary, HybridRegionPayload } from '../../../preload/index'
import { useEditorUiStore } from '../../stores/editorUi'
import { useSettingsStore } from '../../stores/settings'
import { monacoLanguageForDocumentKind } from '../../stores/tabUtils'

export type SerializableSpan = {
  start: number
  end: number
  line: number
  column: number
}

const props = withDefaults(defineProps<{ tabId?: string; active?: boolean }>(), {
  tabId: undefined,
  active: true
})

const container = ref<HTMLElement | null>(null)
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
const models = new Map<string, Monaco.editor.ITextModel>()
let markerSub: Monaco.IDisposable | null = null
let highlightDecorations: string[] = []
let highlightClearTimer: ReturnType<typeof setTimeout> | null = null
let suppressHistory = false

const doc = useDocumentStore()
const history = useHistoryStore()
const lsp = useLspStore()
const lspDiagnostics = useLspDiagnosticsStore()
const editorUi = useEditorUiStore()
const settings = useSettingsStore()
let resizeObserver: ResizeObserver | null = null

const activeDocumentTab = computed(() => {
  if (props.tabId) {
    const tab = doc.tabs.find((t) => t.id === props.tabId)
    return tab?.kind === 'document' ? tab : null
  }
  return doc.activeTab?.kind === 'document' ? doc.activeTab : null
})

function runCommand(cmd: string): void {
  const ed = editor.value
  if (!ed) return
  ed.focus()
  const actionId = EDIT_COMMAND_IDS[cmd] ?? cmd
  void ed.getAction(actionId)?.run()
}

function uiZoom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')
  const zoom = Number.parseFloat(raw)
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

function relayout(): void {
  const surface = container.value
  const shell = surface?.parentElement
  const ed = editor.value
  if (!surface || !shell || !ed) return
  const zoom = uiZoom()
  const width = Math.max(0, Math.floor(shell.clientWidth * zoom))
  const height = Math.max(0, Math.floor(shell.clientHeight * zoom))
  if (width < 2 || height < 2) return
  ed.layout({ width, height })
}

function applyModelValue(model: Monaco.editor.ITextModel, content: string): void {
  if (model.getValue() === content) return
  const ed = editor.value
  const pos = ed?.getModel() === model ? ed.getPosition() : null
  const sel = ed?.getModel() === model ? ed.getSelection() : null
  model.setValue(content)
  if (!ed || ed.getModel() !== model) return
  if (sel) ed.setSelection(sel)
  else if (pos) ed.setPosition(pos)
}

function revealSpan(span: SerializableSpan, options?: { select?: boolean }): void {
  const ed = editor.value
  const model = ed?.getModel()
  if (!ed || !model) return
  relayout()
  const safeStart = Math.max(0, Math.min(span.start, model.getValueLength()))
  const safeEnd = Math.max(safeStart, Math.min(span.end, model.getValueLength()))
  const start = model.getPositionAt(safeStart)
  const end = model.getPositionAt(safeEnd)
  const shortRange =
    start.lineNumber === end.lineNumber && safeEnd - safeStart > 0 && safeEnd - safeStart <= 120
  const shouldSelect = Boolean(options?.select) || shortRange
  const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
  if (shouldSelect && safeEnd > safeStart) {
    ed.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column))
    ed.revealRangeInCenter(range)
  } else {
    ed.setPosition(start)
    ed.revealLineInCenter(start.lineNumber)
  }
  ed.focus()
  highlightDecorations = ed.deltaDecorations(highlightDecorations, [
    {
      range: new monaco.Range(start.lineNumber, 1, end.lineNumber, 1),
      options: {
        isWholeLine: true,
        className: 'studio-code-highlight-line',
        overviewRuler: {
          color: 'rgba(55, 148, 255, 0.6)',
          position: monaco.editor.OverviewRulerLane.Center
        }
      }
    }
  ])
  if (highlightClearTimer) clearTimeout(highlightClearTimer)
  highlightClearTimer = setTimeout(() => {
    highlightDecorations = ed.deltaDecorations(highlightDecorations, [])
    highlightClearTimer = null
  }, 2000)
}

defineExpose({
  runEditCommand: runCommand,
  relayout,
  flushToDocument() {
    flushEditorToDocument()
  },
  async formatDocument() {
    const { formatEditorInstance } = await import('../../composables/useFormatDocument')
    return formatEditorInstance(editor.value)
  },
  applyContent(content: string, _fromHistory = false): void {
    const tab = activeDocumentTab.value
    const ed = editor.value
    if (!tab || !ed) return
    suppressHistory = true
    doc.setContent(tab.id, content, tab.isDirty)
    const model = getOrCreateModel(tab.id, tab.uri, content, monacoLanguageForDocumentKind(tab.documentKind))
    if (ed.getModel()?.uri.toString() !== model.uri.toString()) {
      ed.setModel(model)
    }
    applyModelValue(model, content)
    model.pushStackElement()
    model.pushEditOperations([], [], () => null)
    suppressHistory = false
  },
  revealSpan
})

function getOrCreateModel(tabId: string, uri: string, content: string, language: string): Monaco.editor.ITextModel {
  let model = models.get(tabId)
  if (model) {
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
    return model
  }
  const monacoUri = uriForTab(uri)
  model = monaco.editor.getModel(monacoUri) ?? monaco.editor.createModel(content, language, monacoUri)
  if (model.getLanguageId() !== language) {
    monaco.editor.setModelLanguage(model, language)
  }
  models.set(tabId, model)
  return model
}

function applyEditorOptions(): void {
  editor.value?.updateOptions({
    minimap: buildMinimapOptions(editorUi.showMinimap),
    lineNumbers: editorUi.showLineNumbers ? 'on' : 'off'
  })
}

let hybridDecorations: string[] = []
let hybridTimer: ReturnType<typeof setTimeout> | null = null
let hybridGen = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let echoedEpoch = 0
let editorDirty = false
let unregisterHistoryFlush: (() => void) | null = null
let unregisterContentBuffer: (() => void) | null = null

const EDITOR_COMMIT_MS = 280

const HYBRID_CLASS: Record<string, string> = {
  fsf: 'studio-hybrid-fsf',
  informal: 'studio-hybrid-informal',
  comment: 'studio-hybrid-comment',
  decom: 'studio-hybrid-decom'
}

async function refreshHybridDecorations(): Promise<void> {
  const tab = activeDocumentTab.value
  const ed = editor.value
  const model = ed?.getModel()
  if (!tab || !ed || !model || tab.documentKind !== 'asfl' || !window.studio?.buildHybridRegions) {
    hybridDecorations = ed?.deltaDecorations(hybridDecorations, []) ?? []
    return
  }
  const gen = ++hybridGen
  const source = tab.content
  const regions = await window.studio.buildHybridRegions(source)
  if (gen !== hybridGen || editor.value !== ed || activeDocumentTab.value?.content !== source) return
  if (doc.hasPendingEdit(tab.id)) {
    scheduleHybridDecorations()
    return
  }
  hybridDecorations = ed.deltaDecorations(
    hybridDecorations,
    regions.map((r: HybridRegionPayload) => ({
      range: new monaco.Range(
        model.getPositionAt(r.span.start).lineNumber,
        1,
        model.getPositionAt(Math.max(r.span.end - 1, r.span.start)).lineNumber,
        1
      ),
      options: {
        isWholeLine: true,
        className: HYBRID_CLASS[r.type] ?? 'studio-hybrid-fsf'
      }
    }))
  )
}

function scheduleHybridDecorations(): void {
  if (editorDisposed) return
  if (hybridTimer) clearTimeout(hybridTimer)
  hybridTimer = setTimeout(() => {
    hybridTimer = null
    const tab = activeDocumentTab.value
    if (tab && doc.hasPendingEdit(tab.id)) {
      scheduleHybridDecorations()
      return
    }
    void refreshHybridDecorations()
  }, 300)
}

function syncModel(): void {
  const tab = activeDocumentTab.value
  const ed = editor.value
  if (!tab || !ed) return
  const model = getOrCreateModel(
    tab.id,
    tab.uri,
    tab.content,
    monacoLanguageForDocumentKind(tab.documentKind)
  )
  if (ed.getModel()?.uri.toString() !== model.uri.toString()) {
    ed.setModel(model)
  }
  scheduleHybridDecorations()
}

function markerSeverityLabel(severity: Monaco.MarkerSeverity): string {
  if (severity === monaco.MarkerSeverity.Error) return 'error'
  if (severity === monaco.MarkerSeverity.Warning) return 'warning'
  if (severity === monaco.MarkerSeverity.Info) return 'info'
  return 'info'
}

function markersToDiagnostics(
  model: Monaco.editor.ITextModel,
  markers: Monaco.editor.IMarker[]
): DiagnosticSummary[] {
  return markers.map((m) => ({
    code: m.code?.toString() ?? 'LSP',
    message: m.message,
    severity: markerSeverityLabel(m.severity),
    source: 'lsp' as const,
    span: {
      start: model.getOffsetAt({ lineNumber: m.startLineNumber, column: m.startColumn }),
      end: model.getOffsetAt({ lineNumber: m.endLineNumber, column: m.endColumn }),
      line: m.startLineNumber,
      column: m.startColumn
    }
  }))
}

function updateMarkerDiagnostics(): void {
  const tab = activeDocumentTab.value
  const ed = editor.value
  if (!tab || !ed || tab.documentKind === 'aspec' || tab.documentKind === 'guispec') {
    lspDiagnostics.clear()
    lsp.setErrorCount(0)
    return
  }
  const model = ed.getModel()
  if (!model) {
    lspDiagnostics.clear()
    lsp.setErrorCount(0)
    return
  }
  const uri = uriForTab(tab.uri)
  const markers = monaco.editor.getModelMarkers({ resource: uri })
  const items = markersToDiagnostics(model, markers)
  lspDiagnostics.setMarkers(items)
  lsp.setErrorCount(items.filter((d) => d.severity === 'error').length)
}

function activeEpoch(): number {
  const id = activeDocumentTab.value?.id
  if (!id) return 0
  return doc.contentEpochByTab[id] ?? 0
}

function flushEditorToDocument(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  const tab = activeDocumentTab.value
  const ed = editor.value
  const tabId = tab?.id
  try {
    if (!tab || !ed || suppressHistory || history.applying || !editorDirty) return
    const value = ed.getValue()
    if (value === tab.content) {
      editorDirty = false
      return
    }
    history.applyDocument(tab.id, value, {
      kind: historyKindForDocument(tab.documentKind),
      immediate: false
    })
    editorDirty = false
    echoedEpoch = activeEpoch()
    scheduleHybridDecorations()
  } finally {
    if (tabId) doc.endPendingEdit(tabId)
  }
}

function onContentChange(): void {
  const tab = activeDocumentTab.value
  const ed = editor.value
  if (!tab || !ed || suppressHistory || history.applying) return
  editorDirty = true
  doc.beginPendingEdit(tab.id)
  doc.markDirty(tab.id)
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    flushEditorToDocument()
  }, EDITOR_COMMIT_MS)
}

let editorDisposed = false

onMounted(() => {
  echoedEpoch = activeEpoch()
  unregisterHistoryFlush = history.registerFlusher(() => flushEditorToDocument())
  unregisterContentBuffer = doc.registerContentBuffer(() => flushEditorToDocument())
  window.setTimeout(() => {
    if (!editorDisposed) void bootMonaco()
  }, 32)
})

async function bootMonaco(): Promise<void> {
  if (!container.value || editorDisposed) return
  initMonacoBase()
  registerAgileSoflFormatProvider()
  try {
    await registerTextMateTokens()
    await registerLanguageConfiguration()
  } catch (err) {
    console.error('[studio] TextMate setup failed:', err)
  }

  if (editorDisposed || !container.value) return
  const isDark = document.documentElement.classList.contains('dark')
  if (container.value) {
    editor.value = monaco.editor.create(container.value, {
      theme: isDark ? 'agile-sofl-dark' : 'agile-sofl-light',
      automaticLayout: false,
      fontSize: 14,
      minimap: buildMinimapOptions(editorUi.showMinimap),
      lineNumbers: editorUi.showLineNumbers ? 'on' : 'off',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 4,
      padding: { top: 8, bottom: 16 },
      scrollbar: {
        vertical: 'auto',
        horizontal: 'auto',
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        alwaysConsumeMouseWheel: true,
        useShadows: false
      }
    })
    editor.value.onDidChangeModelContent(onContentChange)
    editor.value.onDidBlurEditorText(() => flushEditorToDocument())
    syncModel()
    resizeObserver = new ResizeObserver(() => relayout())
    resizeObserver.observe(container.value.parentElement ?? container.value)
    void nextTick(relayout)
  }

  await lsp.refresh()
  if (lsp.running) await lsp.ensureClient()
  else {
    const unsub = window.studio?.lspOnStatusChanged(async (s: { running: boolean; message?: string }) => {
      if (s.running) {
        await lsp.ensureClient()
        unsub?.()
      }
    })
  }

  if (editorDisposed) return
  markerSub = monaco.editor.onDidChangeMarkers(() => updateMarkerDiagnostics())
}

watch([() => doc.activeTabId, () => props.tabId], () => {
  syncModel()
  updateMarkerDiagnostics()
  highlightDecorations = editor.value?.deltaDecorations(highlightDecorations, []) ?? []
})

watch(activeEpoch, (epoch) => {
  if (epoch === echoedEpoch) return
  const tab = activeDocumentTab.value
  const ed = editor.value
  if (!tab || !ed) return
  const model = models.get(tab.id)
  if (!model || model.getValue() === tab.content) return
  editorDirty = false
  suppressHistory = true
  applyModelValue(model, tab.content)
  model.pushStackElement()
  suppressHistory = false
})

watch([() => editorUi.showMinimap, () => editorUi.showLineNumbers], () => {
  applyEditorOptions()
  void nextTick(relayout)
})

watch(() => settings.zoom, () => void nextTick(relayout))

watch(
  () => props.active,
  (active) => {
    if (!active) return
    void nextTick(relayout)
  }
)

onUnmounted(() => {
  editorDisposed = true
  unregisterHistoryFlush?.()
  unregisterContentBuffer?.()
  unregisterHistoryFlush = null
  unregisterContentBuffer = null
  if (!history.applying) flushEditorToDocument()
  resizeObserver?.disconnect()
  resizeObserver = null
  markerSub?.dispose()
  const ed = editor.value
  editor.value = null
  ed?.dispose()
  for (const model of models.values()) {
    const stillAttached = monaco.editor.getEditors().some((other) => other.getModel() === model)
    if (!stillAttached) model.dispose()
  }
  models.clear()
})
</script>

<template>
  <div class="monaco-editor-shell">
    <div ref="container" class="monaco-editor-surface" />
  </div>
</template>

<style>
.monaco-editor .studio-code-highlight-line {
  background: rgba(55, 148, 255, 0.12);
}
.monaco-editor .studio-hybrid-fsf {
  border-left: 3px solid rgba(0, 120, 212, 0.5);
}
.monaco-editor .studio-hybrid-informal {
  background: rgba(206, 145, 120, 0.15);
}
.monaco-editor .studio-hybrid-comment {
  background: rgba(106, 153, 85, 0.12);
}
.monaco-editor .studio-hybrid-decom {
  background: rgba(204, 167, 0, 0.12);
}
</style>
