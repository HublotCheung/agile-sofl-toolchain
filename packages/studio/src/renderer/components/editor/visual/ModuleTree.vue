<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { VisualModuleSummary } from '../../../preload/index'
import type { TreeSelection } from '../../../composables/useVisualModel'

const props = defineProps<{
  modules: VisualModuleSummary[]
  selected: TreeSelection
  searchQuery?: string
  parseFailed: boolean
  hasDiagnostics: boolean
}>()

const emit = defineEmits<{
  select: [selection: TreeSelection]
  revealSpan: [span: { start: number; end: number; line: number; column: number }]
  contextmenu: [payload: { x: number; y: number; selection: TreeSelection }]
}>()

const { t } = useI18n()
const expanded = ref<Record<string, boolean>>({})
const dragKey = ref<string | null>(null)

const q = computed(() => (props.searchQuery ?? '').trim().toLowerCase())

const filteredModules = computed(() => {
  if (!q.value) return props.modules
  return props.modules.filter((mod) => {
    const label = mod.isSystem ? `system_${mod.name}` : mod.name
    if (label.toLowerCase().includes(q.value)) return true
    return (
      mod.processes.some((p) => p.name.toLowerCase().includes(q.value)) ||
      mod.functions.some((f) => f.name.toLowerCase().includes(q.value))
    )
  })
})

function isExpanded(name: string): boolean {
  return expanded.value[name] !== false
}

function toggleExpand(name: string, e: Event): void {
  e.stopPropagation()
  expanded.value[name] = !isExpanded(name)
}

function moduleLabel(mod: VisualModuleSummary): string {
  return mod.isSystem ? `SYSTEM_${mod.name}` : mod.name
}

function isModuleSelected(modName: string): boolean {
  return props.selected?.kind === 'module' && props.selected.moduleName === modName
}

function isProcessSelected(modName: string, procName: string): boolean {
  return (
    props.selected?.kind === 'process' &&
    props.selected.moduleName === modName &&
    props.selected.processName === procName
  )
}

function isFunctionSelected(modName: string, fnName: string): boolean {
  return (
    props.selected?.kind === 'function' &&
    props.selected.moduleName === modName &&
    props.selected.functionName === fnName
  )
}

function orderKey(modName: string): string {
  return `studio-tree-order-${modName}`
}

function orderedProcesses(mod: VisualModuleSummary) {
  const raw = mod.processes
  try {
    const saved = JSON.parse(localStorage.getItem(orderKey(mod.name)) ?? '[]') as string[]
    if (!saved.length) return raw
    const map = new Map(raw.map((p) => [p.name, p]))
    const ordered = saved.map((n) => map.get(n)).filter(Boolean) as typeof raw
    for (const p of raw) {
      if (!saved.includes(p.name)) ordered.push(p)
    }
    return ordered
  } catch {
    return raw
  }
}

function saveOrder(modName: string, names: string[]): void {
  localStorage.setItem(orderKey(modName), JSON.stringify(names))
}

function onProcessDragStart(modName: string, procName: string): void {
  dragKey.value = `${modName}::${procName}`
}

function onProcessDrop(modName: string, targetName: string): void {
  const key = dragKey.value
  dragKey.value = null
  if (!key || !key.startsWith(`${modName}::`)) return
  const fromName = key.split('::')[1]
  if (fromName === targetName) return
  const mod = props.modules.find((m) => m.name === modName)
  if (!mod) return
  const names = orderedProcesses(mod).map((p) => p.name)
  const fromIdx = names.indexOf(fromName)
  const toIdx = names.indexOf(targetName)
  if (fromIdx < 0 || toIdx < 0) return
  names.splice(fromIdx, 1)
  names.splice(toIdx, 0, fromName)
  saveOrder(modName, names)
}

function onContext(e: MouseEvent, selection: TreeSelection): void {
  e.preventDefault()
  emit('select', selection)
  emit('contextmenu', { x: e.clientX, y: e.clientY, selection })
}

function onDblClick(selection: TreeSelection): void {
  emit('select', selection)
}

function processHint(mod: VisualModuleSummary, procName: string): string {
  const proc = mod.processes.find((p) => p.name === procName)
  if (!proc) return ''
  const lines: string[] = []
  const comment = proc.comment?.replace(/^comment:\s*/i, '').trim()
  const decom = proc.decom?.replace(/^decom:\s*/i, '').trim()
  if (comment) lines.push(comment)
  if (decom) lines.push(`decom: ${decom}`)
  return lines.join('\n')
}

function functionHint(mod: VisualModuleSummary, fnName: string): string {
  const fn = mod.functions.find((f) => f.name === fnName)
  return fn?.text.split('\n').slice(0, 2).join(' ').trim() ?? ''
}

function matchesSearch(text: string): boolean {
  if (!q.value) return true
  return text.toLowerCase().includes(q.value)
}
</script>

<template>
  <nav class="visual-panel studio-scroll h-full overflow-y-auto bg-surface-base p-2">
    <p v-if="!filteredModules.length" class="px-2 py-1 text-sm text-content-secondary">{{ t('visual.noModules') }}</p>
    <ul v-for="mod in filteredModules" :key="mod.name" class="mb-1">
      <li>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors"
          :class="
            isModuleSelected(mod.name)
              ? 'bg-accent/20 text-accent'
              : 'text-content-primary hover:bg-surface-overlay'
          "
          @click="emit('select', { kind: 'module', moduleName: mod.name })"
          @dblclick="onDblClick({ kind: 'module', moduleName: mod.name })"
          @contextmenu="onContext($event, { kind: 'module', moduleName: mod.name })"
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent/15 text-accent"
            @click="toggleExpand(mod.name, $event)"
          >
            <svg class="h-3 w-3 transition-transform" :class="isExpanded(mod.name) ? 'rotate-90' : ''" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 4l4 4-4 4V4z" />
            </svg>
          </span>
          <svg class="h-4 w-4 shrink-0 text-accent" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="12" height="10" rx="1" />
            <path d="M5 3V2h6v1M5 13v1h6v-1" />
          </svg>
          <span class="truncate">{{ moduleLabel(mod) }}</span>
        </button>

        <ul v-show="isExpanded(mod.name)" class="ml-3 mt-0.5 space-y-0.5 border-l border-border-subtle pl-2">
          <li v-if="mod.consts.length && matchesSearch('const')">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-semantic-warning hover:bg-surface-overlay"
              @click="emit('select', { kind: 'module', moduleName: mod.name })"
            >
              <span class="rounded bg-semantic-warning/15 px-1.5 py-0.5 font-medium">{{ t('visual.section.const') }}</span>
              <span class="text-content-muted">({{ mod.consts.length }})</span>
            </button>
          </li>
          <li v-if="mod.types.length && matchesSearch('type')">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-kind-type hover:bg-surface-overlay"
              @click="emit('select', { kind: 'module', moduleName: mod.name })"
            >
              <span class="rounded bg-kind-type/15 px-1.5 py-0.5 font-medium">{{ t('visual.section.type') }}</span>
              <span class="text-content-muted">({{ mod.types.length }})</span>
            </button>
          </li>
          <li v-if="mod.vars.length && matchesSearch('var')">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-kind-var hover:bg-surface-overlay"
              @click="emit('select', { kind: 'module', moduleName: mod.name })"
            >
              <span class="rounded bg-kind-var/15 px-1.5 py-0.5 font-medium">{{ t('visual.section.var') }}</span>
              <span class="text-content-muted">({{ mod.vars.length }})</span>
            </button>
          </li>
          <li v-if="mod.invCount && matchesSearch('inv')">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-semantic-error hover:bg-surface-overlay"
              @click="emit('select', { kind: 'module', moduleName: mod.name })"
            >
              <span class="rounded bg-semantic-error/15 px-1.5 py-0.5 font-medium">{{ t('visual.section.inv') }}</span>
              <span class="text-content-muted">({{ mod.invCount }})</span>
            </button>
          </li>

          <li
            v-for="proc in orderedProcesses(mod).filter((p) => matchesSearch(p.name))"
            :key="proc.name"
            draggable="true"
            :title="t('visual.treeDragHint')"
            @dragstart="onProcessDragStart(mod.name, proc.name)"
            @dragover.prevent
            @drop="onProcessDrop(mod.name, proc.name)"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors"
              :class="
                isProcessSelected(mod.name, proc.name)
                  ? 'bg-role-process/20 text-role-process'
                  : 'text-content-secondary hover:bg-surface-overlay hover:text-content-primary'
              "
              :title="processHint(mod, proc.name) || undefined"
              @click="emit('select', { kind: 'process', moduleName: mod.name, processName: proc.name })"
              @dblclick="onDblClick({ kind: 'process', moduleName: mod.name, processName: proc.name })"
              @contextmenu="onContext($event, { kind: 'process', moduleName: mod.name, processName: proc.name })"
            >
              <svg class="h-3.5 w-3.5 shrink-0 text-role-process" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="8" cy="8" r="5" />
                <path d="M8 5v3l2 1" stroke-linecap="round" />
              </svg>
              <span class="truncate">{{ proc.name }}</span>
            </button>
          </li>

          <li v-for="fn in mod.functions.filter((f) => matchesSearch(f.name))" :key="fn.name">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors"
              :class="
                isFunctionSelected(mod.name, fn.name)
                  ? 'bg-role-function/20 text-role-function'
                  : 'text-content-secondary hover:bg-surface-overlay hover:text-content-primary'
              "
              :title="functionHint(mod, fn.name) || undefined"
              @click="emit('select', { kind: 'function', moduleName: mod.name, functionName: fn.name })"
              @dblclick="onDblClick({ kind: 'function', moduleName: mod.name, functionName: fn.name })"
              @contextmenu="onContext($event, { kind: 'function', moduleName: mod.name, functionName: fn.name })"
            >
              <svg class="h-3.5 w-3.5 shrink-0 text-role-function" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M3 12h10M6 4h4v4H6z" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="truncate font-mono">{{ fn.name }}</span>
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
