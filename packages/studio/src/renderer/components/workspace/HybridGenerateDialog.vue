<script setup lang="ts">
import { useTraceabilityStore } from '../../stores/traceability'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../../stores/workspace'
import { useHistoryStore } from '../../stores/history'
import { HistoryKinds } from '../../history/kinds'
import CascadeStageChecks, { type CascadeStageValue } from '../ui/CascadeStageChecks.vue'
import DiscreteSlider from '../ui/DiscreteSlider.vue'
import SegmentedChoice from '../ui/SegmentedChoice.vue'
import Checkbox from '../ui/Checkbox.vue'
import type { HybridGenerateParamsPayload } from '../../../preload/index'
import { buildClientHybridAgentBootstrap } from '../../lib/hybridAgentBootstrap'
import { localeForZhEnApi, type Locale } from '../../i18n'

type ChangeItem = { id: string; kind: string; name: string; summary: string; selected?: boolean }
type GeneratorInfo = { id: string; name: string; runtime?: 'batch' | 'agent' }

const props = withDefaults(
  defineProps<{
    source: string
    initialStages?: Partial<CascadeStageValue>
    processName?: string
  }>(),
  {}
)

const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const workspace = useWorkspaceStore()
const generators = ref<GeneratorInfo[]>([])
const generatorId = ref('rule-based')
const stages = ref<CascadeStageValue>({
  hybridSpec: props.initialStages?.hybridSpec ?? true,
  modules: props.initialStages?.modules ?? true,
  processes: props.initialStages?.processes ?? true,
  scenarios: props.initialStages?.scenarios ?? true,
  typesVars: props.initialStages?.typesVars,
  invariants: props.initialStages?.invariants,
  gui: props.initialStages?.gui ?? true
})
const detailLevel = ref(3)
const strategy = ref<'ask' | 'merge' | 'rebuild'>('ask')
const moduleSplit = ref<'ask' | 'single-system' | 'cluster-by-function'>('ask')
const inferUnstated = ref(true)
const preview = ref('')
const lastSpec = ref<unknown>(null)
const lastTraceLinks = ref<Array<{sourceId: string; targetId: string; relation?: string}>>([])
const changes = ref<ChangeItem[]>([])
const selected = ref<Record<string, boolean>>({})
const warnings = ref<string[]>([])
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  generators.value = (await window.studio?.listHybridGenerators?.()) ?? [
    { id: 'rule-based', name: 'Rule-based Hybrid Generator', runtime: 'batch' },
    { id: 'llm-baseline', name: 'LLM Hybrid Generator', runtime: 'agent' }
  ]
  const status = await window.studio?.llmStatus?.()
  if (status?.configured) generatorId.value = 'llm-baseline'
})

const selectedGenerator = computed(
  () => generators.value.find((g) => g.id === generatorId.value) ?? generators.value[0]
)
const isAgent = computed(() => {
  const g = selectedGenerator.value
  if (!g) return false
  return g.runtime === 'agent' || g.id === 'llm-baseline'
})
const selectedCount = computed(() => changes.value.filter((c) => selected.value[c.id] !== false).length)
const processName = computed(
  () => props.processName || (workspace.selection?.kind === 'process' ? workspace.selection.processName : undefined)
)

const stageLabels = computed(() => ({
  hybridSpec: t('informal.generateScopeHybrid'),
  modules: t('informal.generateScopeModule'),
  processes: t('informal.generateScopeProcess'),
  scenarios: t('informal.generateScopeScenario'),
  typesVars: t('informal.stageTypesVars'),
  invariants: t('informal.stageInvariants'),
  gui: t('informal.stageGui'),
  more: t('informal.moreStages')
}))

const detailLabels = computed(() => [
  t('informal.detail0'),
  t('informal.detail1'),
  t('informal.detail2'),
  t('informal.detail3'),
  t('informal.detail4')
])

const strategyOptions = computed(() => [
  { id: 'ask', label: t('informal.strategyAsk'), description: t('informal.strategyAskHint') },
  { id: 'merge', label: t('informal.strategyMerge'), description: t('informal.strategyMergeHint') },
  { id: 'rebuild', label: t('informal.strategyRebuild'), description: t('informal.strategyRebuildHint') }
])

const splitOptions = computed(() => [
  { id: 'ask', label: t('informal.splitAsk'), description: t('informal.splitAskHint') },
  { id: 'single-system', label: t('informal.splitSingle'), description: t('informal.splitSingleHint') },
  { id: 'cluster-by-function', label: t('informal.splitCluster'), description: t('informal.splitClusterHint') }
])

function onStrategy(id: string): void {
  if (id === 'ask' || id === 'merge' || id === 'rebuild') strategy.value = id
}

function onModuleSplit(id: string): void {
  if (id === 'ask' || id === 'single-system' || id === 'cluster-by-function') moduleSplit.value = id
}

function buildParams(): HybridGenerateParamsPayload {
  return {
    stages: { ...stages.value },
    detailLevel: detailLevel.value as 0 | 1 | 2 | 3 | 4,
    strategy: strategy.value,
    inferUnstatedDesign: inferUnstated.value,
    moduleSplit: moduleSplit.value,
    locale: localeForZhEnApi(locale.value as Locale)
  }
}

async function run(mode: 'preview' | 'selected' = 'preview'): Promise<string | null> {
  if (!window.studio?.generateHybrid) {
    error.value = t('informal.generateUnavailable')
    return null
  }
  busy.value = true
  error.value = ''
  try {
    const selectedIds =
      mode === 'selected'
        ? changes.value.filter((c) => selected.value[c.id] !== false).map((c) => c.id)
        : undefined
    const result = await window.studio.generateHybrid({
      source: props.source,
      generatorId: generatorId.value,
      projectName: workspace.activeProject?.name,
      projectRoot: workspace.activeProject?.rootPath,
      existingAsfl: workspace.hybridTab?.content,
      processName: processName.value,
      selectedNodeIds: selectedIds,
      specification: mode === 'selected' ? lastSpec.value : undefined,
      params: buildParams()
    })
    if (!result.ok) {
      error.value = result.error
      return null
    }
    if (result.kind === 'agent-session') {
      if (!workspace.activeProject?.rootPath) {
        error.value = t('informal.startGenerateFailed')
        return null
      }
      workspace.requestAgentLaunch(result.bootstrap)
      emit('close')
      return null
    }
    lastTraceLinks.value = (result.traceLinks ?? []) as typeof lastTraceLinks.value
    if (mode === 'preview') {
      preview.value = result.asflText
      warnings.value = result.warnings.map((w: { message: string }) => w.message)
      changes.value = result.changes ?? []
      selected.value = Object.fromEntries(changes.value.map((c) => [c.id, c.selected !== false]))
      lastSpec.value = result.specification ?? null
    }
    return result.asflText
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return null
  } finally {
    busy.value = false
  }
}

async function writeHybrid(text: string): Promise<void> {
  const tab = workspace.hybridTab
  if (!tab || !text) return
  useHistoryStore().applyDocument(tab.id, text, {
    kind: HistoryKinds.hybridEdit,
    immediate: true
  })
  try { await useTraceabilityStore().recordGenerated(lastTraceLinks.value) }
  catch (e) { error.value = String(e); return }
  emit('close')
}

function applyAll(): void {
  if (preview.value) writeHybrid(preview.value)
}

async function applySelected(): Promise<void> {
  const text = await run('selected')
  if (text) writeHybrid(text)
}

function startAgentSession(): boolean {
  if (!workspace.activeProject?.rootPath) {
    error.value = t('informal.startGenerateFailed')
    return false
  }
  workspace.requestAgentLaunch(buildClientHybridAgentBootstrap(buildParams()))
  emit('close')
  return true
}

async function onGenerate(): Promise<void> {
  if (isAgent.value) {
    startAgentSession()
    return
  }
  await run('preview')
}
</script>

<template>
  <Teleport to="body">
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6" @click.self="emit('close')">
    <div class="flex max-h-[86vh] w-[min(720px,100%)] flex-col rounded-xl border border-border-subtle bg-surface-raised shadow-lg">
      <header class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <h3 class="mr-auto text-sm font-semibold text-content-primary">{{ t('informal.generateHybrid') }}</h3>
        <button type="button" class="text-content-muted" @click="emit('close')">×</button>
      </header>
      <div class="min-h-0 flex-1 space-y-4 overflow-auto p-4 studio-scroll">
        <label class="block text-[12px] text-content-secondary">
          {{ t('informal.generator') }}
          <select v-model="generatorId" class="mt-1 w-full rounded-md border border-field-border bg-field-bg px-2 py-1.5 text-[13px]">
            <option v-for="g in generators" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>

        <div>
          <p class="mb-1.5 text-[12px] font-medium text-content-primary">{{ t('informal.generateStages') }}</p>
          <CascadeStageChecks v-model="stages" :labels="stageLabels" />
        </div>

        <div>
          <p class="mb-1.5 text-[12px] font-medium text-content-primary">{{ t('informal.detailLevel') }}</p>
          <DiscreteSlider
            v-model="detailLevel"
            :min="0"
            :max="4"
            :labels="detailLabels"
            :left-hint="t('informal.detailLeft')"
            :right-hint="t('informal.detailRight')"
          />
        </div>

        <div>
          <p class="mb-1.5 text-[12px] font-medium text-content-primary">{{ t('informal.existingStrategy') }}</p>
          <SegmentedChoice
            :model-value="strategy"
            :options="strategyOptions"
            @update:model-value="onStrategy"
          />
        </div>

        <div>
          <p class="mb-1.5 text-[12px] font-medium text-content-primary">{{ t('informal.moduleSplit') }}</p>
          <SegmentedChoice
            :model-value="moduleSplit"
            :options="splitOptions"
            @update:model-value="onModuleSplit"
          />
        </div>

        <div class="rounded-md border border-border-subtle bg-surface-raised px-2.5 py-2">
          <Checkbox v-model="inferUnstated" :label="t('informal.inferUnstated')" :description="t('informal.inferUnstatedHint')" />
        </div>

        <div v-if="!isAgent && changes.length" class="space-y-1 rounded-md border border-border-subtle p-2">
          <p class="text-[12px] font-medium text-content-primary">{{ t('informal.generatedChanges') }} ({{ selectedCount }})</p>
          <label v-for="c in changes" :key="c.id" class="flex items-start gap-2 text-[12px] text-content-secondary">
            <input v-model="selected[c.id]" type="checkbox" class="mt-0.5" />
            <span><span class="text-content-muted">{{ c.kind }}</span> {{ c.summary }}</span>
          </label>
        </div>
        <pre v-if="!isAgent && preview" class="max-h-[240px] overflow-auto rounded-md bg-surface-base p-3 text-[12px] text-content-primary studio-scroll">{{ preview }}</pre>
        <p v-for="w in warnings" :key="w" class="text-[12px] text-semantic-warning">{{ w }}</p>
        <p v-if="error" class="text-[12px] text-semantic-error">{{ error }}</p>
      </div>
      <footer class="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-4 py-3">
        <button type="button" class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px]" @click="emit('close')">
          {{ t('workspace.cancel') }}
        </button>
        <button type="button" class="rounded-md bg-accent/15 px-3 py-1.5 text-[12px] text-accent" :disabled="busy" @click="onGenerate">
          {{ busy ? t('informal.generating') : isAgent ? t('informal.startGenerate') : t('informal.previewGenerate') }}
        </button>
        <button
          v-if="!isAgent && preview && selectedCount && selectedCount < changes.length"
          type="button"
          class="rounded-md border border-accent/40 px-3 py-1.5 text-[12px] text-accent"
          :disabled="busy"
          @click="applySelected"
        >
          {{ t('informal.applySelected') }}
        </button>
        <button
          v-if="!isAgent && preview"
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-fg"
          @click="applyAll"
        >
          {{ t('informal.applyGenerate') }}
        </button>
      </footer>
    </div>
  </div>
  </Teleport>
</template>
