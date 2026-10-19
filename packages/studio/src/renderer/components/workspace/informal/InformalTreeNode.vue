<script setup lang="ts">
import TraceBadge from '../TraceBadge.vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { nestedNodes } from '../../../composables/useInformalSpec'
import type { InformalNodePayload } from '../../../../preload/index'

type SectionType = 'functions' | 'data-resources' | 'constraints'
type Placement = 'before' | 'into' | 'after'

export type InformalDropHint = {
  parentId: string
  afterId?: string
  beforeId?: string
  into: boolean
}

const props = defineProps<{
  node: InformalNodePayload
  section: SectionType
  parentId: string
  depth: number
  selectedId: string | null
  renamingId: string | null
  renameDraft: string
  collapsed: Record<string, boolean>
  dropHint: InformalDropHint | null
}>()

const emit = defineEmits<{
  select: [id: string]
  toggle: [id: string]
  menu: [event: MouseEvent, id: string]
  'start-rename': [id: string, title: string]
  'commit-rename': []
  'cancel-rename': []
  'update:renameDraft': [value: string]
  'add-child': [id: string]
  'drag-start': [event: DragEvent, id: string, section: SectionType]
  'drag-end': []
  'node-dragover': [
    event: DragEvent,
    hint: { section: SectionType; parentId: string; targetId: string; placement: Placement }
  ]
  'node-drop': [event: DragEvent]
}>()

const { t } = useI18n()
const children = computed(() => nestedNodes(props.node))
const collapsedSelf = computed(() => Boolean(props.collapsed[props.node.id]))
const selected = computed(() => props.selectedId === props.node.id)
const nesting = computed(() => Boolean(props.dropHint?.into && props.dropHint.parentId === props.node.id))

function onDragStart(event: DragEvent): void {
  if (props.renamingId === props.node.id) {
    event.preventDefault()
    return
  }
  emit('drag-start', event, props.node.id, props.section)
}

function onDragOver(event: DragEvent): void {
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 1
  const placement: Placement = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'into'
  emit('node-dragover', event, {
    section: props.section,
    parentId: props.parentId,
    targetId: props.node.id,
    placement
  })
}
</script>

<template>
  <li>
    <div
      class="group relative cursor-grab text-content-primary transition-colors active:cursor-grabbing"
      :class="
        depth === 0
          ? [
              'rounded-lg border px-2 py-1.5 text-[12px]',
              nesting
                ? 'border-accent/50 bg-accent/10 shadow-sm'
                : selected
                  ? 'border-accent/40 bg-accent/10 shadow-sm'
                  : 'border-transparent bg-surface-overlay/80 hover:border-border-subtle hover:bg-surface-overlay'
            ]
          : [
              'rounded-md px-1.5 py-1 text-[11px]',
              nesting
                ? 'bg-accent/15 text-accent ring-1 ring-accent/40'
                : selected
                  ? 'bg-accent/15 text-accent'
                  : 'text-content-secondary hover:bg-surface-base'
            ]
      "
      :draggable="renamingId !== node.id"
      @click="emit('select', node.id)"
      @contextmenu="emit('menu', $event, node.id)"
      @dblclick.stop="emit('start-rename', node.id, node.title)"
      @dragstart="onDragStart"
      @dragend="emit('drag-end')"
      @dragover="onDragOver"
      @drop="emit('node-drop', $event)"
    >
      <span
        v-if="dropHint?.beforeId === node.id"
        class="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-accent"
      />
      <span
        v-if="dropHint?.afterId === node.id"
        class="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-accent"
      />
      <input
        v-if="renamingId === node.id"
        :value="renameDraft"
        class="w-full rounded border border-field-border bg-field-bg px-1 py-0.5 text-[12px] text-content-primary"
        :data-rename="node.id"
        @click.stop
        @input="emit('update:renameDraft', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('commit-rename')"
        @keydown.esc="emit('cancel-rename')"
        @blur="emit('commit-rename')"
      />
      <div v-else class="flex items-start gap-1">
        <button
          v-if="children.length"
          type="button"
          class="mt-0.5 w-3 shrink-0 text-center font-mono text-[10px] text-content-muted"
          :aria-expanded="!collapsedSelf"
          :title="collapsedSelf ? t('informal.expandSection') : t('informal.collapseSection')"
          @click.stop="emit('toggle', node.id)"
          @dblclick.stop
        >
          {{ collapsedSelf ? '▸' : '▾' }}
        </button>
        <span v-else class="mt-0.5 w-3 shrink-0 text-center text-[10px] text-content-muted">·</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate" :class="depth === 0 ? 'font-medium' : ''">{{ node.title }}</span>
          <span
            v-if="node.description"
            class="mt-0.5 text-content-muted"
            :class="depth === 0 ? 'line-clamp-2 text-[11px]' : 'line-clamp-1 text-[10px]'"
          >
            {{ node.description }}
          </span>
        </span>
        <TraceBadge side="informal" :locator="node.id" />
        <button
          type="button"
          class="shrink-0 rounded px-1 text-[12px] font-medium text-accent opacity-0 hover:bg-accent/10 group-hover:opacity-100"
          :title="t('informal.addChild')"
          @click.stop="emit('add-child', node.id)"
          @dblclick.stop
        >
          +
        </button>
      </div>
    </div>
    <ul
      v-if="children.length && !collapsedSelf"
      class="ml-3 mt-0.5 space-y-0.5 border-l border-border-subtle pl-1"
      @dragover.stop
    >
      <InformalTreeNode
        v-for="child in children"
        :key="child.id"
        :node="child"
        :section="section"
        :parent-id="node.id"
        :depth="depth + 1"
        :selected-id="selectedId"
        :renaming-id="renamingId"
        :rename-draft="renameDraft"
        :collapsed="collapsed"
        :drop-hint="dropHint"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @menu="(event, id) => emit('menu', event, id)"
        @start-rename="(id, title) => emit('start-rename', id, title)"
        @commit-rename="emit('commit-rename')"
        @cancel-rename="emit('cancel-rename')"
        @update:rename-draft="emit('update:renameDraft', $event)"
        @add-child="emit('add-child', $event)"
        @drag-start="(event, id, sectionName) => emit('drag-start', event, id, sectionName)"
        @drag-end="emit('drag-end')"
        @node-dragover="(event, hint) => emit('node-dragover', event, hint)"
        @node-drop="emit('node-drop', $event)"
      />
    </ul>
  </li>
</template>
