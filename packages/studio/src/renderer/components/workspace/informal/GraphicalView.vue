<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InformalNodePayload, InformalSpecPayload } from '../../../preload/index'
import { nestedNodes } from '../../../composables/useInformalSpec'
import { useWorkspaceStore } from '../../../stores/workspace'
import IconActionButton from '../../ui/IconActionButton.vue'
import InformalTreeNode, { type InformalDropHint } from './InformalTreeNode.vue'

type SectionType = 'functions' | 'data-resources' | 'constraints'
type MenuAction = 'rename' | 'duplicate' | 'delete' | 'copy'

const props = defineProps<{ spec: InformalSpecPayload | null }>()
const emit = defineEmits<{
  select: [id: string]
  move: [id: string, parentId: string, afterId?: string, beforeId?: string]
  add: [section: SectionType]
  addChild: [parentId: string]
  rename: [id: string, title: string]
  remove: [id: string]
  duplicate: [id: string]
  updateBody: [id: string, description: string]
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const selected = computed(() => workspace.informalSelectedNodeId)
const collapsed = ref<Record<SectionType, boolean>>({
  functions: false,
  'data-resources': false,
  constraints: false
})
const collapsedNodes = ref<Record<string, boolean>>({})
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const menu = ref<{ x: number; y: number; id: string } | null>(null)
const bodyDraft = ref('')
const draggingId = ref<string | null>(null)
const dropHint = ref<(InformalDropHint & { section: SectionType }) | null>(null)

const columns: Array<{ type: SectionType; tone: string; bar: string }> = [
  { type: 'functions', tone: 'text-section-functions', bar: 'bg-section-functions' },
  { type: 'data-resources', tone: 'text-section-data', bar: 'bg-section-data' },
  { type: 'constraints', tone: 'text-section-constraints', bar: 'bg-section-constraints' }
]

const selectedNode = computed(() => (selected.value ? findNode(selected.value) : null))

watch(
  () => selected.value,
  (id) => {
    bodyDraft.value = id ? findNode(id)?.description ?? '' : ''
    if (!id || !props.spec) return
    const next = { ...collapsedNodes.value }
    let changed = false
    const walk = (nodes: InformalNodePayload[], stack: string[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) {
          for (const ancestor of stack) {
            if (next[ancestor]) {
              next[ancestor] = false
              changed = true
            }
          }
          return true
        }
        if (walk(nestedNodes(node), [...stack, node.id])) return true
      }
      return false
    }
    for (const section of props.spec.sections) {
      if (!walk(section.children, [])) continue
      collapsed.value[section.type] = false
      break
    }
    if (changed) collapsedNodes.value = next
  }
)

watch(
  () => selectedNode.value?.description,
  (desc) => {
    if (renamingId.value) return
    if (document.activeElement?.getAttribute('data-informal-body') === '1') return
    bodyDraft.value = desc ?? ''
  }
)

function sectionOf(type: SectionType) {
  return props.spec?.sections.find((s) => s.type === type)
}

function nodesOf(type: SectionType): InformalNodePayload[] {
  return sectionOf(type)?.children ?? []
}

function findNode(id: string): InformalNodePayload | null {
  if (!props.spec) return null
  const walk = (nodes: InformalNodePayload[]): InformalNodePayload | null => {
    for (const node of nodes) {
      if (node.id === id) return node
      const found = walk(nestedNodes(node))
      if (found) return found
    }
    return null
  }
  for (const section of props.spec.sections) {
    const found = walk(section.children)
    if (found) return found
  }
  return null
}

function sectionTypeOf(id: string): SectionType | null {
  if (!props.spec) return null
  for (const section of props.spec.sections) {
    const walk = (nodes: InformalNodePayload[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) return true
        if (walk(nestedNodes(node))) return true
      }
      return false
    }
    if (walk(section.children)) return section.type
  }
  return null
}

function columnLabel(type: SectionType): string {
  if (type === 'functions') return t('informal.functionsColumn')
  if (type === 'data-resources') return t('informal.dataColumn')
  return t('informal.constraintsColumn')
}

function addLabel(type: SectionType): string {
  if (type === 'functions') return t('informal.function')
  if (type === 'data-resources') return t('informal.data')
  return t('informal.constraint')
}

function onSelect(id: string): void {
  emit('select', id)
}

function startRename(id: string, title: string): void {
  renamingId.value = id
  renameDraft.value = title
  menu.value = null
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>(`input[data-rename="${id}"]`)
    el?.focus()
    el?.select()
  })
}

function commitRename(): void {
  const id = renamingId.value
  const title = renameDraft.value.trim()
  renamingId.value = null
  if (!id || !title) return
  const node = findNode(id)
  if (node && node.title !== title) emit('rename', id, title)
}

function openMenu(e: MouseEvent, id: string): void {
  e.preventDefault()
  e.stopPropagation()
  onSelect(id)
  menu.value = { x: e.clientX, y: e.clientY, id }
}

function onMenu(action: MenuAction): void {
  const id = menu.value?.id
  menu.value = null
  if (!id) return
  const node = findNode(id)
  if (!node) return
  if (action === 'rename') {
    startRename(id, node.title)
    return
  }
  if (action === 'duplicate') {
    emit('duplicate', id)
    return
  }
  if (action === 'delete') {
    emit('remove', id)
    return
  }
  if (action === 'copy') {
    void navigator.clipboard.writeText([node.title, node.description].filter(Boolean).join('\n'))
  }
}

function onDragStart(e: DragEvent, id: string, section: SectionType): void {
  draggingId.value = id
  e.dataTransfer?.setData('text/informal-id', id)
  e.dataTransfer?.setData('text/informal-section', section)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnd(): void {
  draggingId.value = null
  dropHint.value = null
}

function containsNode(rootId: string, targetId: string): boolean {
  if (rootId === targetId) return true
  const root = findNode(rootId)
  if (!root) return false
  const walk = (nodes: InformalNodePayload[]): boolean =>
    nodes.some((node) => node.id === targetId || walk(nestedNodes(node)))
  return walk(nestedNodes(root))
}

function countNodes(nodes: InformalNodePayload[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(nestedNodes(node)), 0)
}

function toggleNode(id: string): void {
  collapsedNodes.value = { ...collapsedNodes.value, [id]: !collapsedNodes.value[id] }
}

function onAddChild(id: string): void {
  menu.value = null
  const section = sectionTypeOf(id)
  if (section) collapsed.value[section] = false
  collapsedNodes.value = { ...collapsedNodes.value, [id]: false }
  emit('addChild', id)
}

function onDragOver(e: DragEvent, section: SectionType): void {
  const dragSection = sectionTypeOf(draggingId.value ?? '')
  if (dragSection && dragSection !== section) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    return
  }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropHint.value = { section, parentId: section, into: false }
}

function onNodeDragOver(
  e: DragEvent,
  hint: { section: SectionType; parentId: string; targetId: string; placement: 'before' | 'into' | 'after' }
): void {
  e.stopPropagation()
  const dragId = draggingId.value
  const dragSection = sectionTypeOf(dragId ?? '')
  if (!dragId || dragSection !== hint.section || containsNode(dragId, hint.targetId)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dropHint.value = null
    return
  }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (hint.placement === 'into') {
    dropHint.value = { section: hint.section, parentId: hint.targetId, into: true }
    return
  }
  if (hint.placement === 'before') {
    dropHint.value = { section: hint.section, parentId: hint.parentId, beforeId: hint.targetId, into: false }
    return
  }
  dropHint.value = { section: hint.section, parentId: hint.parentId, afterId: hint.targetId, into: false }
}

function onDrop(e: DragEvent, section: SectionType): void {
  e.preventDefault()
  const id = e.dataTransfer?.getData('text/informal-id') || draggingId.value
  const fromSection = sectionTypeOf(id ?? '')
  const hint = dropHint.value
  draggingId.value = null
  dropHint.value = null
  if (!id || fromSection !== section) return
  if (hint && hint.section === section) {
    if (id === hint.afterId || id === hint.beforeId || id === hint.parentId) return
    if (hint.into) collapsedNodes.value = { ...collapsedNodes.value, [hint.parentId]: false }
    emit('move', id, hint.parentId, hint.afterId, hint.beforeId)
    return
  }
  emit('move', id, section)
}

function onNodeDrop(e: DragEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const section = dropHint.value?.section
  if (!section) {
    draggingId.value = null
    dropHint.value = null
    return
  }
  onDrop(e, section)
}

function commitBody(): void {
  const id = selected.value
  if (!id) return
  const node = findNode(id)
  const next = bodyDraft.value
  if (!node || (node.description ?? '') === next) return
  emit('updateBody', id, next)
}

function onAdd(type: SectionType): void {
  collapsed.value[type] = false
  emit('add', type)
}

function placeholderCount(type: SectionType): string {
  return String(countNodes(nodesOf(type)))
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface-base" @mousedown="menu = null">
    <div class="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-hidden p-2">
      <section
        v-for="col in columns"
        :key="col.type"
        class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-surface-raised shadow-sm transition-colors"
        :class="dropHint?.section === col.type ? 'border-accent/50' : 'border-border-subtle'"
        @dragover="onDragOver($event, col.type)"
        @drop="onDrop($event, col.type)"
      >
        <header class="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="col.bar" />
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-[11px] font-semibold"
            :class="col.tone"
            :title="collapsed[col.type] ? t('informal.expandSection') : t('informal.collapseSection')"
            @click="collapsed[col.type] = !collapsed[col.type]"
          >
            <span class="mr-1 text-content-muted">{{ collapsed[col.type] ? '▸' : '▾' }}</span>
            {{ columnLabel(col.type) }}
            <span class="ml-1 font-normal text-content-muted">{{ placeholderCount(col.type) }}</span>
          </button>
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10"
            :title="t('informal.addItem', { name: addLabel(col.type) })"
            @click="onAdd(col.type)"
          >
            +
          </button>
        </header>
        <div v-if="!collapsed[col.type]" class="min-h-0 flex-1 overflow-auto p-1.5 studio-scroll">
          <p v-if="!nodesOf(col.type).length" class="px-2 py-6 text-center text-[11px] text-content-muted">
            {{ t('informal.emptySection') }}
          </p>
          <ul v-else class="space-y-1">
            <InformalTreeNode
              v-for="node in nodesOf(col.type)"
              :key="node.id"
              :node="node"
              :section="col.type"
              :parent-id="col.type"
              :depth="0"
              :selected-id="selected"
              :renaming-id="renamingId"
              :rename-draft="renameDraft"
              :collapsed="collapsedNodes"
              :drop-hint="dropHint"
              @select="onSelect"
              @toggle="toggleNode"
              @menu="openMenu"
              @start-rename="startRename"
              @commit-rename="commitRename"
              @cancel-rename="renamingId = null"
              @update:rename-draft="renameDraft = $event"
              @add-child="onAddChild"
              @drag-start="onDragStart"
              @drag-end="onDragEnd"
              @node-dragover="onNodeDragOver"
              @node-drop="onNodeDrop"
            />
          </ul>
        </div>
      </section>
    </div>
    <aside
      v-if="selectedNode"
      class="flex shrink-0 flex-col border-t border-border-subtle bg-surface-raised"
      :class="workspace.informalGraphBodyVisible ? 'max-h-[42%] min-h-[120px]' : ''"
    >
      <header
        class="flex h-8 shrink-0 items-center gap-2 px-2"
        :class="workspace.informalGraphBodyVisible ? 'border-b border-border-subtle' : ''"
      >
        <span class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">{{
          t('informal.itemBody')
        }}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-content-primary">{{
          selectedNode.title
        }}</span>
        <IconActionButton
          v-if="workspace.informalGraphBodyVisible"
          icon="lucide:panel-bottom-close"
          :label="t('informal.hideBodyPanel')"
          @click="workspace.informalGraphBodyVisible = false"
        />
        <IconActionButton
          v-else
          icon="lucide:panel-bottom-open"
          :label="t('informal.showBodyPanel', { title: selectedNode.title })"
          variant="accent"
          @click="workspace.informalGraphBodyVisible = true"
        />
      </header>
      <textarea
        v-if="workspace.informalGraphBodyVisible"
        v-model="bodyDraft"
        data-informal-body="1"
        class="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 text-[13px] leading-relaxed text-content-primary outline-none studio-scroll"
        :placeholder="t('informal.bodyPlaceholder')"
        @blur="commitBody"
      />
    </aside>
    <div
      v-if="menu"
      class="fixed z-[120] min-w-[148px] rounded-lg border border-border-subtle bg-surface-raised py-1 shadow-lg"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @mousedown.stop
    >
      <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onAddChild(menu.id)">
        {{ t('informal.addChild') }}
      </button>
      <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('rename')">
        {{ t('informal.rename') }}
      </button>
      <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('duplicate')">
        {{ t('informal.duplicate') }}
      </button>
      <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('copy')">
        {{ t('informal.copyText') }}
      </button>
      <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] text-danger hover:bg-surface-overlay" @click="onMenu('delete')">
        {{ t('informal.delete') }}
      </button>
    </div>
  </div>
</template>
