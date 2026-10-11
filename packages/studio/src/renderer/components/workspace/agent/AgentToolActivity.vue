<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StudioIcon from '../../ui/StudioIcon.vue'
import {
  formatToolArgsSize,
  parsePartialToolArgs,
  resolvedToolStatus,
  toolLabelKey,
  type AgentToolCallView
} from './agentToolUx'

const props = defineProps<{
  call: AgentToolCallView
  messageStreaming?: boolean
  busy?: boolean
}>()

const { t } = useI18n()

const status = computed(() =>
  resolvedToolStatus(props.call, {
    messageStreaming: props.messageStreaming,
    busy: props.busy
  })
)
const live = computed(() => status.value === 'streaming' || status.value === 'running')
const friendlyName = computed(() =>
  props.call.name ? t(toolLabelKey(props.call.name)) : t('agent.tool.generic')
)
const headline = computed(() => {
  if (status.value === 'streaming') return t('agent.toolGenerating', { name: friendlyName.value })
  if (status.value === 'running') return t('agent.toolRunning', { name: friendlyName.value })
  if (status.value === 'error') return t('agent.toolFailed', { name: friendlyName.value })
  return t('agent.toolDone', { name: friendlyName.value })
})
const expanded = ref(false)
const size = computed(() => formatToolArgsSize(props.call.arguments || ''))
const parsed = computed(() => parsePartialToolArgs(props.call.arguments || ''))
const shownArgs = computed(() => {
  const raw = props.call.arguments || ''
  if (raw.length <= 12000) return raw
  return `${raw.slice(0, 12000)}\n…`
})

function onToggle(event: Event): void {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
}
const subtitle = computed(() => {
  const bits: string[] = []
  if (parsed.value.view) bits.push(parsed.value.view)
  if (parsed.value.operationCount != null) {
    bits.push(t('agent.toolOperations', { count: parsed.value.operationCount }))
  }
  if (props.call.name) bits.push(props.call.name)
  return bits.join(' · ')
})
const icon = computed(() => {
  if (status.value === 'error') return 'lucide:circle-alert'
  if (status.value === 'done') return 'lucide:check'
  return 'lucide:loader-circle'
})
</script>

<template>
  <details
    class="mt-1.5 min-w-0 rounded-lg border border-border-subtle bg-surface-base/70 px-2 py-1.5 text-[12px] text-content-secondary"
    @toggle="onToggle"
  >
    <summary class="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
      <span
        class="inline-flex shrink-0 text-content-muted"
        :class="live ? 'animate-spin text-accent' : status === 'error' ? 'text-semantic-error' : 'text-semantic-success'"
      >
        <StudioIcon :icon="icon" :size="13" />
      </span>
      <span class="min-w-0 flex-1 truncate font-medium text-content-primary">{{ headline }}</span>
      <span class="shrink-0 font-mono text-[10px] text-content-muted">{{ size }}</span>
      <span v-if="status === 'streaming'" class="inline-block animate-pulse text-accent" aria-hidden="true">▌</span>
    </summary>
    <p v-if="subtitle" class="mt-1 truncate font-mono text-[10px] text-content-muted">{{ subtitle }}</p>
    <pre
      v-if="expanded && shownArgs"
      class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed studio-scroll"
    >{{ shownArgs }}<span v-if="status === 'streaming'" class="animate-pulse text-accent">▌</span></pre>
  </details>
</template>
