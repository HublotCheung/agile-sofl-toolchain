<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DocumentView from './informal/DocumentView.vue'
import GraphicalView from './informal/GraphicalView.vue'
import HybridGenerateDialog from './HybridGenerateDialog.vue'
import SegmentedSwitch from '../ui/SegmentedSwitch.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import DockPanelChrome from './dock/DockPanelChrome.vue'
import FullscreenPanel from './FullscreenPanel.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { nestedNodes, useInformalSpec } from '../../composables/useInformalSpec'
import { childNodeType, locateInformalNode, subtreePatchNode } from '../../lib/informalOutline'
import { duplicateTitle, nextIndexedTitle } from '../../lib/informalTitles'
import type { InformalPatchPayload } from '../../../preload/index'
import { filePathsEqual } from '../../stores/tabUtils'

type SectionType = 'functions' | 'data-resources' | 'constraints'

defineProps<{
  title: string
  dirty?: boolean
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const tabId = computed(() => workspace.informalTab?.id)
const { spec, addNode, applyPatch, selectNode, revealNode } = useInformalSpec(tabId)
const documentRef = ref<InstanceType<typeof DocumentView> | null>(null)
const showGenerate = ref(false)

const viewOptions = computed(() => [
  { id: 'document', label: t('informal.documentView') },
  { id: 'graphical', label: t('informal.graphicalView') }
])

function onSelect(id: string): void {
  selectNode(id)
  if (workspace.informalViewMode !== 'document') return
  const span = revealNode(id)
  if (span) documentRef.value?.revealSpan(span, { title: span.title, select: true })
}

watch(
  () => workspace.informalRevealNonce,
  async () => {
    const id = workspace.informalSelectedNodeId
    if (!id) return
    await nextTick()
    await nextTick()
    const span = revealNode(id)
    if (!span) return
    documentRef.value?.revealSpan(span, { title: span.title, select: true })
  }
)

watch(
  () => workspace.editorRevealNonce,
  async () => {
    const request = workspace.editorReveal
    if (!request || request.kind !== 'aspec') return
    const tab = workspace.informalTab
    if (!tab?.filePath || !filePathsEqual(tab.filePath, request.filePath)) return
    workspace.informalViewMode = 'document'
    await nextTick()
    await nextTick()
    documentRef.value?.revealSpan(
      {
        start: request.start,
        end: request.end,
        line: request.line,
        column: request.column
      },
      { text: request.text, select: true }
    )
  }
)

async function onMove(id: string, parentId: string, afterId?: string, beforeId?: string): Promise<void> {
  const section = spec.value?.sections.find((s) => s.id === parentId || s.type === parentId)
  await applyPatch({
    operations: [{ op: 'move', id, parentId: section?.type ?? parentId, afterId, beforeId }]
  })
}

function onAdd(section: SectionType): void {
  const titles = spec.value?.sections.find((s) => s.type === section)?.children.map((c) => c.title) ?? []
  const prefix =
    section === 'functions'
      ? t('informal.numberedFunction')
      : section === 'data-resources'
        ? t('informal.numberedData')
        : t('informal.numberedConstraint')
  const title = nextIndexedTitle(titles, prefix)
  const description =
    section === 'functions'
      ? t('informal.defaultBodyFunction')
      : section === 'data-resources'
        ? t('informal.defaultBodyData')
        : t('informal.defaultBodyConstraint')
  void addNode(section, title, description)
}

async function onRename(id: string, title: string): Promise<void> {
  await applyPatch({ operations: [{ op: 'update', id, title }] })
}

async function onRemove(id: string): Promise<void> {
  await applyPatch({ operations: [{ op: 'remove', id }] })
  if (workspace.informalSelectedNodeId === id) selectNode(null)
}

function childCopy(section: SectionType, nested: boolean): { type: ReturnType<typeof childNodeType>; prefix: string; description: string } {
  const type = childNodeType(section, nested)
  if (type === 'function') {
    return { type, prefix: t('informal.numberedFunction'), description: t('informal.defaultBodyFunction') }
  }
  if (type === 'constraint') {
    return { type, prefix: t('informal.numberedConstraint'), description: t('informal.defaultBodyConstraint') }
  }
  if (type === 'data-field') {
    return { type, prefix: t('informal.numberedField'), description: t('informal.defaultBodyData') }
  }
  return { type, prefix: t('informal.numberedData'), description: t('informal.defaultBodyData') }
}

async function onAddChild(parentId: string): Promise<void> {
  const located = locateInformalNode(spec.value, parentId)
  if (!located) return
  const draft = childCopy(located.section, true)
  const title = nextIndexedTitle(nestedNodes(located.node).map((node) => node.title), draft.prefix)
  const result = await applyPatch({
    operations: [
      {
        op: 'add',
        target: parentId,
        node: { type: draft.type, title, description: draft.description }
      }
    ]
  })
  if (!result.ok) return
  const created = nestedNodes(locateInformalNode(spec.value, parentId)?.node ?? located.node).find(
    (node) => node.title === title
  )
  if (created) selectNode(created.id)
}

async function onDuplicate(id: string): Promise<void> {
  const located = locateInformalNode(spec.value, id)
  if (!located) return
  await applyPatch({
    operations: [
      {
        op: 'add',
        target: located.parentId,
        afterId: id,
        node: subtreePatchNode(located.node, duplicateTitle(located.node.title, t('informal.copySuffix')))
      }
    ]
  })
}

async function onUpdateBody(id: string, description: string): Promise<void> {
  await applyPatch({ operations: [{ op: 'update', id, description }] })
}

function onViewMode(id: string): void {
  workspace.informalViewMode = id === 'graphical' ? 'graphical' : 'document'
}
</script>

<template>
  <FullscreenPanel panel-id="informal">
  <WorkspacePanel panel="informal" class="relative flex h-full min-h-0 flex-col" data-dock-host="informal">
    <DockPanelChrome panel="informal" :title="title" :dirty="dirty">
      <template #actions>
        <div class="flex min-w-0 items-center gap-2">
          <SegmentedSwitch
            class="min-w-0 shrink"
            :model-value="workspace.informalViewMode"
            :options="viewOptions"
            @update:model-value="onViewMode"
          />
          <button
            type="button"
            class="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg shadow-sm hover:opacity-90"
            @click="showGenerate = true"
          >
            {{ t('informal.generateHybrid') }}
          </button>
        </div>
      </template>
    </DockPanelChrome>
    <div class="relative z-0 min-h-0 flex-1 overflow-hidden">
      <DocumentView
        v-if="workspace.informalViewMode === 'document'"
        ref="documentRef"
        :tab-id="tabId"
        @add="onAdd"
      />
      <GraphicalView
        v-else
        :spec="spec"
        @select="onSelect"
        @move="onMove"
        @add="onAdd"
        @add-child="onAddChild"
        @rename="onRename"
        @remove="onRemove"
        @duplicate="onDuplicate"
        @update-body="onUpdateBody"
      />
    </div>
    <HybridGenerateDialog v-if="showGenerate" :source="workspace.informalTab?.content ?? ''" @close="showGenerate = false" />
  </WorkspacePanel>
  </FullscreenPanel>
</template>
