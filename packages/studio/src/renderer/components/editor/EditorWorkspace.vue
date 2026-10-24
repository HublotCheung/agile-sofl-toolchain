<script setup lang="ts">
import { ref, computed, provide, watch, nextTick } from 'vue'
import { useEditorUiStore } from '../../stores/editorUi'
import { useDocumentStore } from '../../stores/document'
import { useLspDiagnosticsStore } from '../../stores/lspDiagnostics'
import { useEditorSelectionStore } from '../../stores/editorSelection'
import { useDocumentDiagnosticsStore } from '../../stores/documentDiagnostics'
import { useVisualModel } from '../../composables/useVisualModel'
import { useInformalModel } from '../../composables/useInformalModel'
import { useGuiModel } from '../../composables/useGuiModel'
import { VISUAL_MODEL_KEY } from '../../composables/visualModelContext'
import { INFORMAL_MODEL_KEY } from '../../composables/informalModelContext'
import { GUI_MODEL_KEY } from '../../composables/guiModelContext'
import {
  mergeDiagnostics,
  filterDiagnosticsBySelection,
  adjustFsfDiagnosticSeverity,
  adjustRefinementDiagnosticSeverity,
  type MergedDiagnostic
} from '@agile-sofl/editor-api'
import type { CoverageReportPayload, DiagnosticSummary } from '../../preload/index'
import { offsetAtLine } from '../../utils/sourceOffset'
import SplitPane from '../ui/SplitPane.vue'
import MonacoEditor from './MonacoEditor.vue'
import VisualEditor from './visual/VisualEditor.vue'
import InformalVisualEditor from './informal/InformalVisualEditor.vue'
import GuiVisualEditor from './gui/GuiVisualEditor.vue'
import VisualIssuesPanel from './visual/VisualIssuesPanel.vue'
import InformalRegionsPanel from './InformalRegionsPanel.vue'
import CoveragePanel from './CoveragePanel.vue'
import type { SerializableSpan } from './MonacoEditor.vue'
import { revealInCodeEditor } from '../../composables/useRevealCode'

const monacoRef = ref<InstanceType<typeof MonacoEditor> | null>(null)
const visualRef = ref<InstanceType<typeof VisualEditor> | null>(null)
const editorUi = useEditorUiStore()
const doc = useDocumentStore()
const lspDiagnostics = useLspDiagnosticsStore()
const editorSelection = useEditorSelectionStore()
const documentDiagnostics = useDocumentDiagnosticsStore()

const isAspec = computed(() => doc.activeTab?.documentKind === 'aspec')
const isAsfl = computed(() => doc.activeTab?.documentKind === 'asfl')
const isGuispec = computed(() => doc.activeTab?.documentKind === 'guispec')

const visual = useVisualModel(computed(() => (isAsfl.value ? doc.activeTabId : undefined)))
const informal = useInformalModel(computed(() => (isAspec.value ? doc.activeTabId : undefined)))
const gui = useGuiModel(computed(() => (isGuispec.value ? doc.activeTabId : undefined)))

provide(VISUAL_MODEL_KEY, visual)
provide(INFORMAL_MODEL_KEY, informal)
provide(GUI_MODEL_KEY, gui)

const showLeft = computed(() => editorUi.showMonaco())
const showRight = computed(() => editorUi.showVisual())
const isDocumentActive = computed(() => doc.activeTab?.kind === 'document')
const issuesOpen = ref(true)
const coverageOpen = ref(true)
const coverage = ref<CoverageReportPayload | null>(null)

function diagnosticSpan(source: string, line?: number, column?: number): SerializableSpan | undefined {
  if (line == null) return undefined
  const start = offsetAtLine(source, line, column ?? 1)
  const end = start + 1
  return { start, end, line, column: column ?? 1 }
}

const informalDiagnostics = computed((): MergedDiagnostic[] => {
  if (!isAspec.value) return []
  const source = doc.activeTab?.content ?? ''
  return (informal.model.value?.diagnostics ?? []).map((d) => ({
    code: d.code,
    message: d.message,
    severity: d.severity as MergedDiagnostic['severity'],
    span: diagnosticSpan(source, d.line, d.column),
    source: 'parse' as const
  }))
})

const unifiedDiagnostics = computed((): MergedDiagnostic[] => {
  if (!isDocumentActive.value) return []
  if (isAspec.value) return informalDiagnostics.value
  const visualItems = adjustRefinementDiagnosticSeverity(
    adjustFsfDiagnosticSeverity(
      (visual.diagnostics.value ?? []) as DiagnosticSummary[],
      editorUi.fsfStrictMode
    ) as DiagnosticSummary[],
    editorUi.fsfStrictMode
  ) as DiagnosticSummary[]
  return mergeDiagnostics(visualItems, lspDiagnostics.markers)
})

const filteredDiagnostics = computed(() => {
  if (isAspec.value) return unifiedDiagnostics.value
  const modules = visual.model.value?.modules ?? []
  if (!editorUi.showVisual()) {
    return unifiedDiagnostics.value
  }
  return filterDiagnosticsBySelection(
    unifiedDiagnostics.value,
    editorSelection.selection,
    modules
  )
})

watch(unifiedDiagnostics, (items) => {
  documentDiagnostics.setUnified(items)
  if (items.length > 0) issuesOpen.value = true
})

async function refreshCoverage(): Promise<void> {
  const tab = doc.activeTab
  if (!tab || tab.documentKind !== 'aspec' || !window.studio?.buildCoverageReport) {
    coverage.value = null
    return
  }
  const hybrid =
    (tab.linkedDocumentId ? doc.documentTabs.find((t) => t.id === tab.linkedDocumentId) : undefined) ??
    (informal.model.value?.meta.hybridTarget
      ? doc.documentTabs.find((t) => t.filePath?.endsWith(informal.model.value!.meta.hybridTarget!.replace(/^\.\//, '')))
      : undefined)
  let traceJson: string | undefined
  if (tab.filePath && window.studio.fileRead) {
    try {
      const tr = await window.studio.fileRead(tab.filePath.replace(/\.aspec$/i, '.aspec.trace.json'))
      traceJson = tr.content
    } catch {
      traceJson = undefined
    }
  }
  const guiSource = await resolveGuiSourceForCoverage(tab)
  coverage.value = await window.studio.buildCoverageReport({
    aspecSource: tab.content,
    asflSource: hybrid?.content ?? '',
    traceJson,
    guiSource: guiSource ?? undefined
  })
}

async function resolveGuiSourceForCoverage(tab: NonNullable<typeof doc.activeTab>): Promise<string | null> {
  const guiTarget = informal.model.value?.meta.guiTarget
  if (guiTarget && tab.filePath && window.studio?.fileRead) {
    try {
      const base = tab.filePath.replace(/[/\\][^/\\]+$/, '')
      const file = await window.studio.fileRead(`${base}/${guiTarget.replace(/^\.\//, '')}`.replace(/\\/g, '/'))
      return file.content
    } catch {
      /* no external gui */
    }
  }
  const embedded = tab.content.includes('\ngui:') || tab.content.startsWith('gui:')
  if (embedded) return tab.content
  const pair = doc.documentTabs.find((t) => t.documentKind === 'guispec' && t.linkedDocumentId === tab.id)
  return pair?.content ?? null
}

watch(
  [isAspec, () => doc.activeTab?.content, () => doc.activeTab?.linkedDocumentId],
  () => void refreshCoverage()
)

function revealInformalId(aspecId: string): void {
  const source = doc.activeTab?.content ?? ''
  const pattern = new RegExp(`id:\\s*["']?${aspecId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`)
  const line = source.split(/\r?\n/).findIndex((l) => pattern.test(l))
  if (line >= 0) {
    revealSpan({ start: offsetAtLine(source, line + 1), end: offsetAtLine(source, line + 1) + 1, line: line + 1, column: 1 })
  }
}

async function revealHybridSymbol(payload: { name: string; kind: 'process' | 'function' }): Promise<void> {
  const tab = doc.activeTab
  if (!tab || tab.documentKind !== 'aspec') return
  const hybrid =
    (tab.linkedDocumentId ? doc.documentTabs.find((t) => t.id === tab.linkedDocumentId) : undefined) ??
    doc.documentTabs.find((t) => t.documentKind === 'asfl')
  if (!hybrid?.content || !window.studio?.findHybridSymbolSpan) {
    revealInformalId(payload.name)
    return
  }
  doc.setActive(hybrid.id)
  await nextTick()
  const span = await window.studio.findHybridSymbolSpan({
    source: hybrid.content,
    symbolName: payload.name,
    kind: payload.kind
  })
  if (span) revealSpan(span)
}

watch(isDocumentActive, (active) => {
  if (!active) {
    lspDiagnostics.clear()
    editorSelection.clear()
    documentDiagnostics.clear()
  }
})

function runEditCommand(cmd: string): void {
  monacoRef.value?.runEditCommand(cmd)
}

function revealSpan(span: SerializableSpan): void {
  void revealInCodeEditor(monacoRef.value, span)
}

defineExpose({
  runEditCommand,
  formatDocument() {
    return monacoRef.value?.formatDocument() ?? Promise.resolve(false)
  },
  revealSpan,
  focusCoverage: () => {
    coverageOpen.value = true
    void refreshCoverage()
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
    <SplitPane class="min-h-0 min-w-0 w-full flex-1" :show-left="showLeft" :show-right="showRight">
      <template #left>
        <MonacoEditor v-if="showLeft" ref="monacoRef" :active="showLeft" />
      </template>
      <template #right>
        <InformalVisualEditor v-if="showRight && isAspec" />
        <GuiVisualEditor v-else-if="showRight && isGuispec" />
        <VisualEditor v-else-if="showRight && isAsfl" ref="visualRef" @reveal-span="revealSpan" />
      </template>
    </SplitPane>
    <CoveragePanel
      v-if="isDocumentActive && isAspec && coverage"
      v-model:open="coverageOpen"
      :report="coverage"
      @reveal-informal="revealInformalId"
      @reveal-hybrid="revealHybridSymbol"
    />
    <InformalRegionsPanel
      v-if="isDocumentActive && isAsfl"
      @reveal-span="revealSpan"
    />
    <VisualIssuesPanel
      v-if="isDocumentActive"
      v-model:open="issuesOpen"
      :diagnostics="filteredDiagnostics"
      @reveal-span="revealSpan"
    />
  </div>
</template>
