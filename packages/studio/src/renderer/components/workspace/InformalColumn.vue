<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DocumentView from './informal/DocumentView.vue'
import GraphicalView from './informal/GraphicalView.vue'
import AgentPanel from './agent/AgentPanel.vue'
import HybridGenerateDialog from './HybridGenerateDialog.vue'
import VerticalResizeSplit from '../ui/VerticalResizeSplit.vue'
import SegmentedSwitch from '../ui/SegmentedSwitch.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import PanelTitle from './PanelTitle.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { nestedNodes, useInformalSpec } from '../../composables/useInformalSpec'
import { childNodeType, locateInformalNode, subtreePatchNode } from '../../lib/informalOutline'
import { duplicateTitle, nextIndexedTitle } from '../../lib/informalTitles'
import { applyHybridDocumentPatch } from '../../lib/applyHybridDocumentPatch'
import type { InformalPatchPayload } from '../../../preload/index'

type SectionType = 'functions' | 'data-resources' | 'constraints'

const { t } = useI18n()
const workspace = useWorkspaceStore()
const tabId = computed(() => workspace.informalTab?.id)
const { spec, tab, addNode, applyPatch, selectNode, revealNode } = useInformalSpec(tabId)
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
  if (span) documentRef.value?.revealSpan(span)
}

async function onMove(id: string, parentId: string, afterId?: string, beforeId?: string): Promise<void> {
  const section = spec.value?.sections.find((s) => s.id === parentId || s.type === parentId)
  await applyPatch({
    operations: [{ op: 'move', id, parentId: section?.type ?? parentId, afterId, beforeId }]
  })
}

async function onApplyPatch(
  patch: InformalPatchPayload
): Promise<{ ok: boolean; error?: string; applied?: boolean }> {
  return applyPatch(patch)
}

async function onApplyHybridPatch(
  patch: InformalPatchPayload
): Promise<{ ok: boolean; error?: string; applied?: boolean }> {
  return applyHybridDocumentPatch(patch, {
    noTab: t('agent.noHybridTab'),
    applyFailed: t('agent.applyFailed')
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
  <section class="flex h-full min-h-0 flex-col bg-surface-base">
    <VerticalResizeSplit
      class="min-h-0 flex-1"
      :ratio="workspace.agentSplitRatio"
      :min-top="0.32"
      :min-bottom="0.22"
      @update:ratio="workspace.agentSplitRatio = $event"
    >
      <template #top>
        <WorkspacePanel panel="informal" class="flex flex-col">
          <header class="flex h-[32px] min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border-subtle px-2">
            <PanelTitle :title="t('workspace.informalSpec')" :dirty="workspace.isInformalDirty()" />
            <SegmentedSwitch
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
          </header>
          <div class="min-h-0 flex-1">
            <DocumentView
              v-show="workspace.informalViewMode === 'document'"
              ref="documentRef"
              :tab-id="tabId"
              @add="onAdd"
            />
            <GraphicalView
              v-show="workspace.informalViewMode === 'graphical'"
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
        </WorkspacePanel>
      </template>
      <template #bottom>
        <WorkspacePanel panel="agent">
          <AgentPanel
            :informal-markdown="tab?.content ?? ''"
            :on-apply-patch="onApplyPatch"
            :on-apply-hybrid-patch="onApplyHybridPatch"
          />
        </WorkspacePanel>
      </template>
    </VerticalResizeSplit>
    <HybridGenerateDialog v-if="showGenerate" :source="tab?.content ?? ''" @close="showGenerate = false" />
  </section>
</template>
