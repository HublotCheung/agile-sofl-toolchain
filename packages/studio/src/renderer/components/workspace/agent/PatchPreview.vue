<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InformalPatchPayload } from '../../../../preload/index'
import { groupPatchOperations, sectionStartsOpen } from './patchSections'
import { formatAgentToolError } from './agentToolUx'

const props = defineProps<{
  patch: InformalPatchPayload
  disabled?: boolean
  pending?: boolean
  autoApplying?: boolean
  resolution?: 'applied' | 'rejected' | 'answered' | 'error'
  toolError?: string
  toolWarning?: string
}>()
const emit = defineEmits<{ apply: []; reject: [] }>()
const { t } = useI18n()

const target = computed(() =>
  props.patch.target === 'hybrid' ? 'hybrid' : props.patch.target === 'gui' ? 'gui' : 'informal'
)
const sourceMode = computed(() => props.patch.mode === 'source')
const sections = computed(() => groupPatchOperations(props.patch.operations ?? []))
const sectionOverride = ref<Record<string, boolean>>({})
const explanationOpen = ref(false)
const explanationLong = computed(() => (props.patch.explanation ?? '').trim().length > 80)
const friendlyToolError = computed(() => formatAgentToolError(props.toolError))

function isSectionOpen(id: string, count: number): boolean {
  const value = sectionOverride.value[id]
  if (value != null) return value
  return sectionStartsOpen(count)
}

function toggleSection(id: string, count: number): void {
  sectionOverride.value = { ...sectionOverride.value, [id]: !isSectionOpen(id, count) }
}

function sectionTitle(id: string): string {
  if (id === 'functions') return t('agent.sectionFunctions')
  if (id === 'data') return t('agent.sectionData')
  if (id === 'constraints') return t('agent.sectionConstraints')
  if (id === 'source') return t('agent.patchModeSource')
  if (id === 'other') return t('agent.sectionOther')
  return id.replace(/[-_]/g, ' ')
}

function verb(op: Record<string, unknown>): string {
  const kind = String(op.op || '')
  if (kind === 'add') return '+'
  if (kind === 'remove') return '−'
  if (kind === 'move') return '↕'
  if (kind === 'replace-document') return '⟳'
  if (kind === 'replace-process-body') return '≡'
  if (kind === 'replace') return '↔'
  if (kind === 'append') return '⤵'
  return '~'
}

function clip(text: unknown, n = 72): string {
  const compact = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (compact.length <= n) return compact
  return `${compact.slice(0, Math.max(0, n - 1))}…`
}

function label(op: Record<string, unknown>): string {
  const node = op.node as { title?: string; type?: string } | undefined
  if (op.op === 'replace-document') {
    return clip(op.text ?? op.asflText ?? 'whole document', 96)
  }
  if (op.op === 'replace') {
    return `${clip(op.oldText ?? op.from, 40)} → ${clip(op.newText ?? op.to, 40)}`
  }
  if (op.op === 'append') return clip(op.text ?? 'append', 96)
  if (op.op === 'replace-process-body') return String(op.id || 'process body')
  if (op.op === 'update') {
    const bits = [op.id, op.name, op.title, op.pre, op.post, op.description].filter(
      (v) => v != null && String(v).trim()
    )
    return bits.map(String).join(' · ')
  }
  if (node?.title) return `${node.type ?? ''} ${node.title}`.trim()
  if (op.name) return `${op.kind ?? ''} ${op.name}`.trim()
  if (op.title) return String(op.title)
  if (op.id) return String(op.id)
  return String(op.target || op.kind || op.op)
}

function tone(op: Record<string, unknown>): string {
  const kind = String(op.op || '')
  if (kind === 'add' || kind === 'append' || kind === 'add-screen' || kind === 'add-widget' || kind === 'insert-html')
    return 'text-semantic-success'
  if (kind === 'remove' || kind === 'remove-screen' || kind === 'remove-node') return 'text-semantic-error'
  if (kind === 'replace' || kind === 'replace-document' || kind === 'replace-html' || kind === 'replace-screen-html')
    return 'text-semantic-warning'
  return 'text-content-secondary'
}
</script>

<template>
  <div class="agent-bubble mt-1 min-w-0 max-w-full overflow-hidden rounded-lg bg-surface-raised px-2.5 py-2">
    <div class="flex items-start justify-between gap-2">
      <p class="min-w-0 text-[11px] font-semibold uppercase tracking-wide text-content-secondary">
        {{ $t('agent.proposedChanges') }}
        <span class="ml-1 font-normal normal-case">{{
          target === 'hybrid'
            ? $t('agent.patchTargetHybrid')
            : target === 'gui'
              ? $t('agent.patchTargetGui')
              : $t('agent.patchTargetInformal')
        }}</span>
        <span v-if="sourceMode" class="ml-1 font-normal normal-case text-semantic-warning">{{
          $t('agent.patchModeSource')
        }}</span>
      </p>
      <div v-if="pending" class="flex shrink-0 gap-1.5">
        <button
          type="button"
          class="agent-proposal-apply rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-40"
          :disabled="disabled"
          @click="emit('apply')"
        >
          {{ $t('agent.apply') }}
        </button>
        <button
          type="button"
          class="agent-proposal-reject rounded-md border px-2.5 py-1 text-[12px] hover:bg-surface-overlay disabled:opacity-40"
          :disabled="disabled"
          @click="emit('reject')"
        >
          {{ $t('agent.reject') }}
        </button>
      </div>
    </div>
    <p v-if="resolution === 'applied'" class="agent-proposal-applied mt-1 text-[12px]">
      {{
        target === 'hybrid'
          ? $t('agent.appliedHybrid')
          : target === 'gui'
            ? $t('agent.appliedGui')
            : $t('agent.applied')
      }}
    </p>
    <p v-if="resolution === 'applied' && toolWarning" class="mt-1 whitespace-pre-wrap break-words text-[12px] text-semantic-warning">
      {{ $t('agent.appliedWithLint') }}
      <span class="mt-1 block font-normal">{{ toolWarning }}</span>
    </p>
    <p v-else-if="resolution === 'rejected'" class="mt-1 text-[12px] text-content-secondary">{{ $t('agent.rejected') }}</p>
    <p v-else-if="resolution === 'error'" class="mt-1 text-[12px] text-semantic-error">
      {{ $t('agent.patchToolFailed') }}
      <span v-if="toolError" class="mt-1 block whitespace-pre-wrap break-words font-normal text-semantic-error">{{
        friendlyToolError
      }}</span>
      <span
        v-if="toolError && friendlyToolError !== toolError"
        class="mt-1 block whitespace-pre-wrap break-words font-mono text-[11px] text-content-muted"
      >{{ toolError }}</span>
    </p>
    <p v-else-if="autoApplying" class="mt-1 text-[12px] text-content-secondary">{{ $t('agent.autoApplying') }}</p>
    <p
      v-if="patch.explanation"
      class="studio-text-selectable mt-1 break-words text-[12px] leading-snug text-content-secondary"
      :class="explanationOpen ? '' : 'line-clamp-2'"
    >
      {{ patch.explanation }}
    </p>
    <button
      v-if="explanationLong"
      type="button"
      class="mt-0.5 text-[11px] font-medium text-accent"
      @click="explanationOpen = !explanationOpen"
    >
      {{ explanationOpen ? $t('agent.collapse') : $t('agent.expand') }}
    </button>
    <div v-if="sections.length" class="mt-1 max-h-72 overflow-y-auto studio-scroll">
      <section v-for="section in sections" :key="section.id" class="border-t border-border-subtle">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 py-1 text-left text-[12px]"
          :aria-expanded="isSectionOpen(section.id, section.items.length)"
          @click="toggleSection(section.id, section.items.length)"
        >
          <span class="w-3 shrink-0 text-center text-[10px] text-content-muted" aria-hidden="true">{{
            isSectionOpen(section.id, section.items.length) ? '▾' : '▸'
          }}</span>
          <span class="min-w-0 flex-1 truncate font-medium text-content-primary">{{ sectionTitle(section.id) }}</span>
          <span class="shrink-0 font-mono text-[11px] text-content-secondary">{{ section.items.length }}</span>
          <span class="sr-only">{{
            isSectionOpen(section.id, section.items.length) ? $t('agent.collapse') : $t('agent.expand')
          }}</span>
        </button>
        <ul v-if="isSectionOpen(section.id, section.items.length)" class="space-y-0.5 pb-1 pl-4">
          <li
            v-for="item in section.items"
            :key="item.index"
            class="flex min-w-0 gap-2 font-mono text-[12px] leading-snug"
            :class="tone(item.op)"
          >
            <span class="w-4 shrink-0 font-semibold">{{ verb(item.op) }}</span>
            <span class="min-w-0 truncate" :title="label(item.op)">{{ label(item.op) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
