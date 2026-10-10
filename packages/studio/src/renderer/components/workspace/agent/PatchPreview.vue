<script setup lang="ts">
import { computed } from 'vue'
import type { InformalPatchPayload } from '../../../../preload/index'

const props = defineProps<{
  patch: InformalPatchPayload
  disabled?: boolean
  pending?: boolean
  autoApplying?: boolean
  resolution?: 'applied' | 'rejected' | 'answered' | 'error'
  toolError?: string
}>()
const emit = defineEmits<{ apply: []; reject: [] }>()

const target = computed(() =>
  props.patch.target === 'hybrid' ? 'hybrid' : props.patch.target === 'gui' ? 'gui' : 'informal'
)
const sourceMode = computed(() => props.patch.mode === 'source')

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
  <div class="agent-bubble mt-2 min-w-0 max-w-full overflow-hidden rounded-xl bg-surface-raised p-3">
    <p class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
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
    <p v-if="patch.explanation" class="studio-text-selectable mt-1 break-words text-[13px] text-content-secondary">
      {{ patch.explanation }}
    </p>
    <ul class="mt-2 space-y-1">
      <li
        v-for="(op, i) in patch.operations"
        :key="i"
        class="flex min-w-0 gap-2 font-mono text-[12px]"
        :class="tone(op)"
      >
        <span class="w-4 shrink-0 font-semibold">{{ verb(op) }}</span>
        <span class="min-w-0 truncate" :title="label(op)">{{ label(op) }}</span>
      </li>
    </ul>
    <p v-if="resolution === 'applied'" class="mt-2 text-[12px] text-content-muted">
      {{
        target === 'hybrid'
          ? $t('agent.appliedHybrid')
          : target === 'gui'
            ? $t('agent.appliedGui')
            : $t('agent.applied')
      }}
    </p>
    <p v-else-if="resolution === 'rejected'" class="mt-2 text-[12px] text-content-muted">{{ $t('agent.rejected') }}</p>
    <p v-else-if="resolution === 'error'" class="mt-2 text-[12px] text-semantic-error">
      {{ $t('agent.patchToolFailed') }}
      <span v-if="toolError" class="mt-1 block whitespace-pre-wrap break-words font-normal text-semantic-error">{{
        toolError
      }}</span>
    </p>
    <p v-else-if="autoApplying" class="mt-2 text-[12px] text-content-muted">{{ $t('agent.autoApplying') }}</p>
    <div v-else-if="pending" class="mt-3 flex gap-2">
      <button
        type="button"
        class="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-fg disabled:opacity-40"
        :disabled="disabled"
        @click="emit('apply')"
      >
        {{ $t('agent.apply') }}
      </button>
      <button
        type="button"
        class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-content-secondary hover:bg-surface-overlay disabled:opacity-40"
        :disabled="disabled"
        @click="emit('reject')"
      >
        {{ $t('agent.reject') }}
      </button>
    </div>
  </div>
</template>
