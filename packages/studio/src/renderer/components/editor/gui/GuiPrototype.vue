<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GUI_IFRAME_SANDBOX, GUI_SANDBOX_CHANNEL, buildPrototypeSrcdoc, prototypeStylesheet } from '@agile-sofl/gui'
import { readThemeVars, type GuiProcessEvent } from '../../../lib/guiPrototype'

const props = defineProps<{
  html: string
  screenId?: string | null
  interactive?: boolean
}>()

const emit = defineEmits<{
  navigate: [id: string]
  process: [event: GuiProcessEvent]
  select: [payload: { id: string | null; path: string | null }]
}>()

const frame = ref<HTMLIFrameElement | null>(null)
const srcdoc = ref('')
let pendingEnv: Record<string, string | number | boolean | null> | null = null

function render(): void {
  pendingEnv = null
  srcdoc.value = buildPrototypeSrcdoc(
    props.html || '',
    prototypeStylesheet(readThemeVars()),
    Boolean(props.interactive)
  )
}

function postEnv(env: Record<string, string | number | boolean | null>): void {
  frame.value?.contentWindow?.postMessage({ channel: GUI_SANDBOX_CHANNEL, type: 'apply-env', env }, '*')
}

function onMessage(event: MessageEvent): void {
  if (event.source !== frame.value?.contentWindow) return
  const data = event.data as {
    channel?: string
    type?: string
    id?: string | null
    path?: string | null
    process?: string
    env?: Record<string, string | number | boolean | null>
    nav?: string
    screen?: string
  }
  if (!data || data.channel !== GUI_SANDBOX_CHANNEL) return
  if (data.type === 'ready' && pendingEnv) postEnv(pendingEnv)
  if (data.type === 'select') emit('select', { id: data.id ?? null, path: data.path ?? null })
  if (data.type === 'navigate' && data.id) emit('navigate', String(data.id))
  if (data.type === 'process' && data.process) {
    emit('process', {
      process: String(data.process),
      env: data.env ?? {},
      nav: data.nav,
      screen: data.screen
    })
  }
}

watch(
  () => [props.html, props.screenId, props.interactive],
  () => render(),
  { immediate: true }
)

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

defineExpose({
  applyOutputs(env: Record<string, string | number | boolean | null>) {
    pendingEnv = env
    postEnv(env)
  }
})
</script>

<template>
  <div class="h-full min-h-[240px] min-w-0 bg-[var(--surface-base)]">
    <iframe
      ref="frame"
      class="block h-full min-h-[240px] w-full border-0 bg-transparent"
      :sandbox="GUI_IFRAME_SANDBOX"
      referrerpolicy="no-referrer"
      :srcdoc="srcdoc"
      title="GUI prototype"
    />
  </div>
</template>
