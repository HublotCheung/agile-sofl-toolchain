<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
  result?: string
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
const userOpen = ref(false)
const open = computed(() => live.value || userOpen.value)
watch(live, (isLive, wasLive) => {
  if (wasLive && !isLive) userOpen.value = false
})
const size = computed(() => formatToolArgsSize(props.call.arguments || ''))
const parsed = computed(() => parsePartialToolArgs(props.call.arguments || ''))
const shownArgs = computed(() => {
  const raw = props.call.arguments || ''
  if (!raw) return ''
  if (raw.length <= 12000) return raw
  return `${raw.slice(0, 12000)}\n…`
})
const shownResult = computed(() => {
  const raw = (props.result ?? '').trim()
  if (!raw || live.value) return ''
  if (raw.length <= 4000) return raw
  return `${raw.slice(0, 4000)}\n…`
})

function toggle(): void {
  if (live.value) return
  userOpen.value = !userOpen.value
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
  <div class="mt-0.5 min-w-0 text-[12px] text-content-secondary">
    <button
      type="button"
      class="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left hover:bg-surface-overlay"
      :aria-expanded="open"
      @click="toggle"
    >
      <span
        class="inline-flex shrink-0 text-content-muted"
        :class="live ? 'animate-spin text-accent' : status === 'error' ? 'text-semantic-error' : 'text-semantic-success'"
      >
        <StudioIcon :icon="icon" :size="13" />
      </span>
      <span class="min-w-0 flex-1 truncate font-medium text-content-primary">{{ headline }}</span>
      <span class="shrink-0 font-mono text-[10px] text-content-muted">{{ size }}</span>
      <span v-if="status === 'streaming'" class="inline-block animate-pulse text-accent" aria-hidden="true">▌</span>
      <span class="w-3 shrink-0 text-center text-[10px] text-content-muted" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="sr-only">{{ open ? t('agent.collapse') : t('agent.expand') }}</span>
    </button>
    <div v-if="open" class="mt-0.5 space-y-1 rounded border border-border-subtle bg-surface-base px-1.5 py-1">
      <p v-if="subtitle" class="truncate font-mono text-[10px] text-content-muted">{{ subtitle }}</p>
      <div v-if="shownArgs">
        <p class="text-[10px] font-medium uppercase tracking-wide text-content-muted">{{ t('agent.toolArguments') }}</p>
        <pre
          class="max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug studio-scroll"
        >{{ shownArgs }}<span v-if="status === 'streaming'" class="animate-pulse text-accent">▌</span></pre>
      </div>
      <div v-if="shownResult">
        <p class="text-[10px] font-medium uppercase tracking-wide text-content-muted">{{ t('agent.toolResult') }}</p>
        <pre
          class="max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug studio-scroll"
        >{{ shownResult }}</pre>
      </div>
    </div>
  </div>
</template>
