<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildAtomicityRows,
  initialExpandedIds,
  type AtomicityRow,
  type GateId
} from '../../../lib/atomicityTree'
import { buildRefineAgentBootstrap, refineToolsForRow, type RefineAiToolId } from '../../../lib/refineAgentTools'
import { emptyRefinementState, type RefinementStateDto } from '../../../lib/refinementTypes'
import type { Locale } from '../../../i18n'
import { useWorkspaceStore } from '../../../stores/workspace'
import StudioIcon from '../../ui/StudioIcon.vue'
import RefinementProgressChart from './RefinementProgressChart.vue'
import RefinementVerticalTree from './RefinementVerticalTree.vue'

type RefineTreeView = 'list' | 'vertical'

const props = defineProps<{
  state: RefinementStateDto | null
}>()

const { t, locale } = useI18n()
const workspace = useWorkspaceStore()
const treeView = ref<RefineTreeView>('list')
const expanded = ref<Set<string>>(new Set())
const menu = ref<{ x: number; y: number; row: AtomicityRow; tools: RefineAiToolId[] } | null>(null)
let skipClickClose = false

const model = computed(() => props.state ?? emptyRefinementState())

watch(
  () => props.state,
  (value, prev) => {
    if (!value) {
      expanded.value = new Set()
      return
    }
    if (!prev) expanded.value = new Set(initialExpandedIds(value))
  },
  { immediate: true }
)

const rows = computed(() => buildAtomicityRows(model.value, expanded.value))

const chips = computed(() => {
  const b = model.value.breakdown
  return [
    { id: 'empty', value: b.emptyModuleCount },
    { id: 'stub', value: b.stubProcessCount },
    { id: 'informal', value: b.informalAtomCount },
    { id: 'coverage', value: b.incompleteScenarioCount },
    { id: 'cond', value: b.openConditionCount },
    { id: 'boundary', value: b.unbalancedBoundaryCount },
    { id: 'undeclared', value: b.undeclaredAtomicCount }
  ]
})

function toggle(row: AtomicityRow): void {
  if (skipClickClose) return
  menu.value = null
  if (!row.expandable) return
  const next = new Set(expanded.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.add(row.id)
  expanded.value = next
}

function rowLabel(row: AtomicityRow): string {
  if (row.kind === 'process-root') return t('visual.atomicity.processRoot', { count: model.value.processAmbiguity })
  if (row.kind === 'data-root') return t('visual.atomicity.dataRoot', { count: model.value.dataAmbiguity })
  if (row.kind === 'log-root') return t('visual.atomicity.logRoot', { count: model.value.log.length })
  if (row.kind === 'gap' && row.isEmpty && row.label === 'empty-module') return t('visual.atomicity.gap.emptyModule')
  if (row.kind === 'gap' && row.label === 'missing-module') {
    return t('visual.atomicity.gap.missingModule', { name: row.moduleName ?? '' })
  }
  if (row.kind === 'gate' && row.gateId) return t(`visual.atomicity.gate.${row.gateId}` as `visual.atomicity.gate.${GateId}`)
  if (row.kind === 'data') {
    const kindLabel = row.dataKind ? t(`visual.atomicity.dataKind.${row.dataKind}`) : ''
    return kindLabel ? `${kindLabel} · ${row.label}` : row.label
  }
  return row.label
}

function statusTitle(row: AtomicityRow): string {
  if (row.status === 'atomic') return t('visual.atomicity.status.atomic')
  if (row.status === 'ready') return t('visual.atomicity.status.ready')
  if (row.status === 'open') return t('visual.atomicity.status.open')
  if (row.status === 'pass') return t('visual.atomicity.gatePass')
  if (row.status === 'fail') return t('visual.atomicity.gateFail')
  if (row.status === 'done') return t('visual.atomicity.data.discharged')
  return ''
}

function isOpen(id: string): boolean {
  return expanded.value.has(id)
}

function onContextMenu(event: MouseEvent, row: AtomicityRow): void {
  const tools = refineToolsForRow(row)
  if (!tools.length) return
  event.preventDefault()
  event.stopPropagation()
  skipClickClose = true
  const pad = 8
  const width = 220
  const height = tools.length * 32 + 8
  const x = Math.min(event.clientX, window.innerWidth - width - pad)
  const y = Math.min(event.clientY, window.innerHeight - height - pad)
  menu.value = { x: Math.max(pad, x), y: Math.max(pad, y), row, tools }
}

function closeMenu(): void {
  if (skipClickClose) {
    skipClickClose = false
    return
  }
  menu.value = null
}

function pickTool(tool: RefineAiToolId): void {
  if (!menu.value) return
  workspace.requestAgentLaunch(buildRefineAgentBootstrap(tool, menu.value.row, locale.value as Locale))
  menu.value = null
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface-base text-content-primary">
    <RefinementProgressChart :state="props.state" />
    <header class="shrink-0 border-b border-border-subtle px-3 py-2">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[13px] font-semibold">{{ t('visual.atomicity.title') }}</p>
        <div class="flex shrink-0 rounded-md border border-border-subtle p-0.5">
          <button
            type="button"
            class="rounded px-2 py-0.5 text-[11px] transition-colors"
            :class="
              treeView === 'list'
                ? 'bg-surface-raised text-content-primary shadow-sm'
                : 'text-content-secondary hover:text-content-primary'
            "
            @click="treeView = 'list'"
          >
            {{ t('visual.refineVertical.viewList') }}
          </button>
          <button
            type="button"
            class="rounded px-2 py-0.5 text-[11px] transition-colors"
            :class="
              treeView === 'vertical'
                ? 'bg-surface-raised text-content-primary shadow-sm'
                : 'text-content-secondary hover:text-content-primary'
            "
            @click="treeView = 'vertical'"
          >
            {{ t('visual.refineVertical.viewVertical') }}
          </button>
        </div>
      </div>
      <p class="mt-0.5 text-[11px] text-content-muted">
        {{ treeView === 'list' ? t('visual.atomicity.menuHint') : t('visual.refineVertical.hint') }}
      </p>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <span
          v-for="chip in chips"
          :key="chip.id"
          class="rounded-md border border-border-subtle bg-surface-raised px-2 py-0.5 text-[11px] text-content-secondary"
        >
          {{ t(`visual.atomicity.chip.${chip.id}`) }}
          <span class="font-medium tabular-nums text-content-primary">{{ chip.value }}</span>
        </span>
      </div>
    </header>
    <RefinementVerticalTree v-if="treeView === 'vertical'" :state="props.state" />
    <div v-else class="studio-scroll min-h-0 flex-1 overflow-auto py-1">
      <p
        v-if="!props.state"
        class="px-3 py-6 text-center text-[12px] text-content-muted"
      >
        {{ t('visual.atomicity.empty') }}
      </p>
      <div
        v-for="row in rows"
        :key="row.id"
        role="treeitem"
        :aria-expanded="row.expandable ? isOpen(row.id) : undefined"
        class="flex w-full cursor-default items-center gap-1.5 px-2 py-1 text-left text-[12px] hover:bg-surface-overlay"
        :class="row.problem ? 'text-content-primary' : ''"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        @click="toggle(row)"
        @contextmenu="onContextMenu($event, row)"
      >
        <span class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-content-muted">
          <StudioIcon
            v-if="row.expandable"
            :icon="isOpen(row.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
            :size="12"
          />
        </span>
        <svg
          v-if="row.kind === 'leaf' || row.kind === 'data' || row.kind === 'gap'"
          class="h-3 w-3 shrink-0"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <circle
            cx="6"
            cy="6"
            r="4.25"
            :fill="row.status === 'atomic' || row.status === 'done' ? 'var(--accent)' : 'transparent'"
            :stroke="
              row.kind === 'gap' || row.status === 'fail' || row.status === 'open'
                ? 'var(--semantic-warning)'
                : row.status === 'atomic' || row.status === 'ready' || row.status === 'done'
                  ? 'var(--accent)'
                  : 'var(--text-muted)'
            "
            stroke-width="1.5"
          />
        </svg>
        <span
          v-else-if="row.kind === 'gate'"
          class="w-3 shrink-0 text-center text-[11px] font-semibold"
          :style="{ color: row.status === 'fail' ? 'var(--semantic-error)' : 'var(--text-muted)' }"
        >
          {{ row.status === 'fail' ? '×' : '✓' }}
        </span>
        <span
          class="min-w-0 flex-1 truncate"
          :class="row.problem ? 'text-[color:var(--semantic-warning)]' : ''"
          :title="row.kind === 'data' ? row.summary : statusTitle(row)"
        >
          {{ rowLabel(row) }}
        </span>
        <span
          v-if="row.kind === 'atom' && row.summary"
          class="shrink-0 text-[10px] uppercase tracking-wide text-content-muted"
        >
          {{ row.summary }}
        </span>
        <span
          v-else-if="row.summary && row.kind !== 'leaf' && row.kind !== 'data' && row.kind !== 'log'"
          class="shrink-0 tabular-nums text-[11px] text-content-secondary"
        >
          {{ row.kind === 'process-root' || row.kind === 'data-root' || row.kind === 'log-root' ? '' : row.summary }}
        </span>
        <span
          v-else-if="row.kind === 'leaf'"
          class="shrink-0 text-[10px] text-content-secondary"
        >
          {{ t(`visual.atomicity.status.${row.status}`) }}
        </span>
        <span
          v-if="row.isStub"
          class="shrink-0 rounded border border-border-subtle px-1 text-[9px] uppercase tracking-wide text-content-muted"
        >
          {{ t('visual.atomicity.stub') }}
        </span>
        <span
          v-if="row.audit"
          class="max-w-[40%] shrink-0 truncate font-mono text-[10px] text-content-muted"
          :title="row.audit"
        >
          {{ row.audit }}
        </span>
      </div>
      <p
        v-if="props.state && rows.some((r) => r.kind === 'data-root') && model.dataItems.length === 0 && expanded.has('data-root')"
        class="px-8 py-1 text-[11px] text-content-muted"
      >
        {{ t('visual.atomicity.dataEmpty') }}
      </p>
    </div>
    <div
      v-if="menu"
      class="fixed z-50 min-w-[200px] rounded-md border border-border-subtle bg-surface-raised py-1 shadow-lg"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <p class="px-3 py-1 text-[10px] uppercase tracking-wide text-content-muted">
        {{ t('visual.atomicity.menuTitle') }}
      </p>
      <button
        v-for="tool in menu.tools"
        :key="tool"
        type="button"
        class="block w-full px-3 py-1.5 text-left text-[12px] text-content-primary hover:bg-surface-overlay"
        @click="pickTool(tool)"
      >
        {{ t(`visual.atomicity.tool.${tool}`) }}
      </button>
    </div>
  </div>
</template>
