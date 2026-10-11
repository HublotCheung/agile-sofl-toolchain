<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MonacoEditor from '../editor/MonacoEditor.vue'
import VisualEditor from '../editor/visual/VisualEditor.vue'
import AtomicityTree from '../editor/visual/AtomicityTree.vue'
import { useRefinementState } from '../../composables/useRefinementState'
import GuiViewsPanel from './GuiViewsPanel.vue'
import DockPanelChrome from './dock/DockPanelChrome.vue'
import FullscreenPanel from './FullscreenPanel.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import SegmentedSwitch from '../ui/SegmentedSwitch.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { TreeSelection } from '../../composables/useVisualModel'
import { revealInCodeEditor } from '../../composables/useRevealCode'
import { initSpecAssistProviders } from '../../specAssist/init'
import ResizeSplit from '../ui/ResizeSplit.vue'
import type { SerializableSpan } from '../editor/MonacoEditor.vue'
import { VISUAL_MODEL_KEY } from '../../composables/visualModelContext'
import { spanForHybridSelection } from '../../lib/structureNav'
import { filePathsEqual } from '../../stores/tabUtils'

initSpecAssistProviders()

defineProps<{
  title: string
  dirty?: boolean
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const visual = inject(VISUAL_MODEL_KEY, null)
const monacoRef = ref<InstanceType<typeof MonacoEditor> | null>(null)
const visualRef = ref<InstanceType<typeof VisualEditor> | null>(null)
const guiSplitRatio = ref(0.62)

const hybridTabId = computed(() => workspace.hybridTab?.id)
const mountCodeEditor = ref(workspace.hybridMode === 'code')

watch(
  () => workspace.hybridMode,
  (mode) => {
    if (mode === 'code') mountCodeEditor.value = true
  }
)

onMounted(() => {
  if (mountCodeEditor.value) return
  let idleId = 0
  let timer = 0
  const mount = () => {
    mountCodeEditor.value = true
  }
  if (typeof window.requestIdleCallback === 'function') {
    idleId = window.requestIdleCallback(mount, { timeout: 2000 })
  } else {
    timer = window.setTimeout(mount, 1200)
  }
  onUnmounted(() => {
    if (idleId) window.cancelIdleCallback(idleId)
    if (timer) window.clearTimeout(timer)
  })
})
const { state: refinementState } = useRefinementState()
const hybridViewOptions = computed(() => [
  { id: 'code', label: t('workspace.codeTab') },
  { id: 'visual', label: t('workspace.visualTab') },
  { id: 'refine', label: t('workspace.refineTab') }
])

function onHybridMode(id: string): void {
  workspace.hybridMode = id === 'code' || id === 'refine' ? id : 'visual'
  if (id === 'code') {
    void nextTick(() => monacoRef.value?.relayout())
  }
}

watch(
  () => workspace.selection,
  (sel) => {
    visualRef.value?.setSelection?.(sel)
  }
)

watch(
  () => workspace.selectedModuleName,
  async (name, prev) => {
    if (!name || name === prev || workspace.hybridMode !== 'code') return
    const mod = workspace.selectedModule
    if (!mod) return
    await nextTick()
    monacoRef.value?.relayout()
    monacoRef.value?.revealSpan({
      start: mod.spanStart,
      end: mod.spanStart,
      line: 1,
      column: 1
    })
  }
)

watch(
  () => workspace.hybridRevealNonce,
  async () => {
    const sel = workspace.selection
    if (!sel) return
    await nextTick()
    await nextTick()
    monacoRef.value?.relayout()
    let span = spanForHybridSelection(visual?.model.value ?? null, sel)
    if (
      !span &&
      (sel.kind === 'process' || sel.kind === 'function') &&
      window.studio?.findHybridSymbolSpan &&
      workspace.hybridTab
    ) {
      span = await window.studio.findHybridSymbolSpan({
        source: workspace.hybridTab.content,
        symbolName: sel.kind === 'process' ? sel.processName : sel.functionName,
        kind: sel.kind
      })
    }
    if (!span && sel.kind === 'module' && workspace.selectedModule) {
      const mod = workspace.selectedModule
      span = { start: mod.spanStart, end: mod.spanEnd, line: 1, column: 1 }
    }
    if (span) monacoRef.value?.revealSpan(span, { select: true })
  }
)

watch(
  () => workspace.editorRevealNonce,
  async () => {
    const request = workspace.editorReveal
    if (!request || request.kind !== 'asfl') return
    const tab = workspace.hybridTab
    if (tab?.filePath && !filePathsEqual(tab.filePath, request.filePath)) return
    await nextTick()
    await nextTick()
    monacoRef.value?.relayout()
    monacoRef.value?.revealSpan(
      {
        start: request.start,
        end: request.end,
        line: request.line,
        column: request.column
      },
      { select: true }
    )
  }
)

function onVisualSelect(sel: TreeSelection): void {
  if (!sel) return
  workspace.selectModule(sel.moduleName, sel)
}

function onRevealSpan(span: SerializableSpan): void {
  void revealInCodeEditor(monacoRef.value, span, { hybrid: true })
}

</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col" data-dock-host="hybrid">
    <ResizeSplit
      v-if="workspace.isGuiModuleSelected"
      direction="vertical"
      :ratio="guiSplitRatio"
      class="min-h-0 flex-1"
      @update:ratio="guiSplitRatio = $event"
    >
      <template #first>
        <FullscreenPanel panel-id="hybrid">
        <WorkspacePanel panel="hybrid" class="flex h-full min-h-0 flex-col">
          <DockPanelChrome panel="hybrid" :title="title" :dirty="dirty">
            <template #actions>
              <div class="ml-auto flex min-w-0 shrink-0 items-center">
                <SegmentedSwitch
                  class="min-w-0 shrink"
                  :model-value="workspace.hybridMode"
                  :options="hybridViewOptions"
                  @update:model-value="onHybridMode"
                />
              </div>
            </template>
          </DockPanelChrome>
          <div class="relative min-h-0 flex-1 overflow-hidden">
            <div
              class="absolute inset-0"
              :class="workspace.hybridMode === 'code' ? 'z-10' : 'invisible pointer-events-none z-0'"
            >
              <MonacoEditor
                v-if="hybridTabId && mountCodeEditor"
                ref="monacoRef"
                :tab-id="hybridTabId"
                :active="workspace.hybridMode === 'code'"
              />
            </div>
            <div
              class="absolute inset-0"
              :class="workspace.hybridMode === 'visual' ? 'z-10' : 'hidden'"
            >
              <VisualEditor
                ref="visualRef"
                hide-navigator
                :forced-selection="workspace.selection"
                @reveal-span="onRevealSpan"
                @select="onVisualSelect"
              />
            </div>
            <div v-if="workspace.hybridMode === 'refine'" class="absolute inset-0 z-10">
              <AtomicityTree class="h-full min-h-0" :state="refinementState" />
            </div>
          </div>
        </WorkspacePanel>
        </FullscreenPanel>
      </template>
      <template #second>
        <WorkspacePanel panel="gui" class="h-full min-h-0">
          <GuiViewsPanel />
        </WorkspacePanel>
      </template>
    </ResizeSplit>
    <FullscreenPanel v-if="!workspace.isGuiModuleSelected" panel-id="hybrid" class="min-h-0 flex-1">
    <WorkspacePanel panel="hybrid" class="flex h-full min-h-0 flex-col">
      <DockPanelChrome panel="hybrid" :title="title" :dirty="dirty">
        <template #actions>
          <div class="ml-auto flex min-w-0 shrink-0 items-center">
            <SegmentedSwitch
              class="min-w-0 shrink"
              :model-value="workspace.hybridMode"
              :options="hybridViewOptions"
              @update:model-value="onHybridMode"
            />
          </div>
        </template>
      </DockPanelChrome>
      <div class="relative min-h-0 flex-1 overflow-hidden">
        <div
          class="absolute inset-0"
          :class="workspace.hybridMode === 'code' ? 'z-10' : 'invisible pointer-events-none z-0'"
        >
          <MonacoEditor
            v-if="hybridTabId && mountCodeEditor"
            ref="monacoRef"
            :tab-id="hybridTabId"
            :active="workspace.hybridMode === 'code'"
          />
        </div>
        <div
          class="absolute inset-0"
          :class="workspace.hybridMode === 'visual' ? 'z-10' : 'hidden'"
        >
          <VisualEditor
            ref="visualRef"
            hide-navigator
            :forced-selection="workspace.selection"
            @reveal-span="onRevealSpan"
            @select="onVisualSelect"
          />
        </div>
        <div v-if="workspace.hybridMode === 'refine'" class="absolute inset-0 z-10">
          <AtomicityTree class="h-full min-h-0" :state="refinementState" />
        </div>
      </div>
    </WorkspacePanel>
    </FullscreenPanel>
  </div>
</template>
