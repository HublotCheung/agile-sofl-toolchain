<script setup lang="ts">
import TraceBadge from '../../workspace/TraceBadge.vue'
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExtVarItem, PatchDocumentPayload, VisualModuleProcess } from '../../../preload/index'
import type { FsfModelDto } from './FsfScenarioEditor.vue'
import FsfScenarioEditor from './FsfScenarioEditor.vue'
import ExtBlockEditor from './ExtBlockEditor.vue'
import SignatureEditor from './SignatureEditor.vue'
import SectionCard from './ui/SectionCard.vue'
import FormField from './ui/FormField.vue'
import TextField from './ui/TextField.vue'
import { findMissingCases } from '../../../specAssist/findMissingCases'
import PredicateBuilder from './predicate/PredicateBuilder.vue'
import type { SymbolHint } from './predicate/predicateTypes'

export type ProcessEditorDraft = {
  name: string
  isInit: boolean
  signature: string
  ext: ExtVarItem[]
  pre: string
  post: string
  decom: string
  comment: string
  fsf?: { scenarios: FsfModelDto['scenarios']; others?: string }
}

const props = withDefaults(
  defineProps<{
    process: VisualModuleProcess
    processName: string
    moduleName: string
    initialDecom?: string
    initialComment?: string
    fsfModel: FsfModelDto | null
    disabled?: boolean
    blockInformal?: boolean
    writeDisabledReason?: 'parseFailed' | 'diagnostics' | null
    symbols?: SymbolHint[]
    draftMode?: boolean
  }>(),
  { draftMode: false }
)

const emit = defineEmits<{
  patch: [payload: Omit<PatchDocumentPayload, 'source'>]
  patchExt: [vars: ExtVarItem[]]
  patchSignature: [signature: string]
  patchInit: [isInit: boolean]
  rename: [name: string]
}>()

const isInitDraft = ref(false)
const nameDraft = ref('')
const signatureDraft = ref('')
const extDraft = ref<ExtVarItem[]>([])
const { t } = useI18n()
const fsfRef = ref<InstanceType<typeof FsfScenarioEditor> | null>(null)
const section = ref<'basic' | 'ports' | 'ext' | 'contract' | 'scenarios'>('basic')
const fsfDraft = ref<{ scenarios: FsfModelDto['scenarios']; others?: string } | null>(null)

watch(
  () => [props.process.isInit, props.processName, props.process.signature, props.process.ext] as const,
  ([init, name, sig, ext]) => {
    isInitDraft.value = Boolean(init)
    nameDraft.value = name
    signatureDraft.value = sig ?? '()'
    extDraft.value = (ext ?? []).map((v) => ({ ...v }))
  },
  { immediate: true }
)

watch(isInitDraft, (init) => {
  if (props.draftMode || props.disabled) return
  if (init === Boolean(props.process.isInit)) return
  emit('patchInit', init)
})

function stripFieldPrefix(text: string, prefix: string): string {
  const trimmed = text.trim()
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed.slice(prefix.length).trim()
  }
  return trimmed
}

const decomText = ref('')
const commentText = ref('')
const preText = ref('')
const postText = ref('')

watch(
  () => [props.initialDecom, props.initialComment, props.process.pre, props.process.post] as const,
  ([decom, comment, pre, post]) => {
    decomText.value = stripFieldPrefix(decom ?? '', 'decom:')
    commentText.value = stripFieldPrefix(comment ?? '', 'comment:')
    preText.value = pre ?? ''
    postText.value = post ?? ''
  },
  { immediate: true }
)

watch(decomText, (text) => {
  if (props.draftMode || props.disabled) return
  const original = stripFieldPrefix(props.initialDecom ?? '', 'decom:')
  if (text === original) return
  emit('patch', { kind: 'decom', processName: props.processName, text })
})

watch(commentText, (text) => {
  if (props.draftMode || props.disabled) return
  const original = stripFieldPrefix(props.initialComment ?? '', 'comment:')
  if (text === original) return
  emit('patch', { kind: 'comment', processName: props.processName, text })
})

watch(preText, (text) => {
  if (props.draftMode || props.disabled) return
  if (text === (props.process.pre ?? '')) return
  emit('patch', { kind: 'pre', processName: props.processName, text })
})

watch(postText, (text) => {
  if (props.draftMode || props.disabled) return
  if (text === (props.process.post ?? '')) return
  emit('patch', { kind: 'post', processName: props.processName, text })
})

function onFsfPatch(scenarios: FsfModelDto['scenarios'], others?: string): void {
  fsfDraft.value = { scenarios, others }
  if (props.draftMode) return
  emit('patch', { kind: 'fsf', processName: props.processName, scenarios, others })
}

function onSignature(sig: string): void {
  signatureDraft.value = sig
  if (props.draftMode) return
  emit('patchSignature', sig)
}

function onExt(vars: ExtVarItem[]): void {
  extDraft.value = vars
  if (props.draftMode) return
  emit('patchExt', vars)
}

const disabledMessage = () => {
  if (props.writeDisabledReason === 'parseFailed') return t('visual.writeDisabledParseFailed')
  if (props.writeDisabledReason === 'diagnostics') return t('visual.writeDisabledDiagnostics')
  return t('visual.writeDisabled')
}

const missingCases = computed(() =>
  findMissingCases({
    name: props.processName,
    pre: preText.value,
    post: postText.value,
    comment: commentText.value,
    scenarioCount: props.process.scenarioCount
  })
)

function addMissingCase(summary: string): void {
  const addition = `else ${summary}`
  if (postText.value.toLowerCase().includes(summary.toLowerCase())) return
  postText.value = postText.value.trim() ? `${postText.value.trim()} ${addition}` : addition
}

const sections = computed(() => [
  { id: 'basic' as const, label: t('visual.process.section.basic') },
  { id: 'ports' as const, label: t('visual.process.section.ports') },
  { id: 'ext' as const, label: t('visual.process.section.ext') },
  { id: 'contract' as const, label: t('visual.process.section.contract') },
  { id: 'scenarios' as const, label: t('visual.process.section.scenarios') }
])

function getDraft(): ProcessEditorDraft {
  return {
    name: nameDraft.value.trim() || props.processName,
    isInit: isInitDraft.value,
    signature: signatureDraft.value,
    ext: extDraft.value,
    pre: preText.value,
    post: postText.value,
    decom: decomText.value,
    comment: commentText.value,
    fsf: fsfDraft.value ?? undefined
  }
}

defineExpose({
  addScenario() {
    fsfRef.value?.addScenario()
  },
  getDraft
})
</script>

<template>
  <div class="space-y-4">
    <TraceBadge side="hybrid" :locator="`proc:${moduleName}.${processName}`" />
    <div
      v-if="disabled"
      class="rounded-md border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-sm text-semantic-warning"
    >
      {{ disabledMessage() }}
    </div>

    <nav class="flex flex-wrap gap-1 rounded-lg border border-border-subtle bg-surface-base p-1">
      <button
        v-for="item in sections"
        :key="item.id"
        type="button"
        class="rounded-md px-2.5 py-1 text-[12px] transition-colors"
        :class="
          section === item.id
            ? 'bg-surface-raised font-medium text-content-primary shadow-sm'
            : 'text-content-secondary hover:text-content-primary'
        "
        @click="section = item.id"
      >
        {{ item.label }}
      </button>
    </nav>

    <div v-show="section === 'basic'" class="space-y-3">
      <FormField v-if="!process.isInit" :label="t('visual.process.name')">
        <TextField v-model="nameDraft" mono :disabled="disabled" />
      </FormField>
      <label class="flex items-center gap-2 text-sm text-content-primary">
        <input v-model="isInitDraft" type="checkbox" class="rounded border-border-subtle" :disabled="disabled" />
        <span>{{ t('visual.init.label') }}</span>
      </label>
      <FormField :label="t('visual.decom')">
        <TextField v-model="decomText" :disabled="disabled" :placeholder="t('visual.decomPlaceholder')" />
      </FormField>
      <FormField :label="t('visual.comment')">
        <TextField v-model="commentText" :rows="3" :disabled="disabled" :placeholder="t('visual.commentPlaceholder')" />
      </FormField>
    </div>

    <div v-show="section === 'ports'">
      <SignatureEditor
        :signature="process.signature ?? '()'"
        :inputs="process.inputs"
        :outputs="process.outputs"
        kind="process"
        hide-code-mode
        :disabled="disabled"
        @patch="onSignature"
      />
    </div>

    <div v-show="section === 'ext'">
      <ExtBlockEditor :vars="process.ext ?? []" :disabled="disabled" @patch="onExt" />
    </div>

    <div v-show="section === 'contract'" class="space-y-4">
      <PredicateBuilder
        v-model="preText"
        :symbols="symbols"
        :disabled="disabled"
        :block-informal="blockInformal"
        initial-mode="visual"
        :label="t('visual.pre')"
      />
      <PredicateBuilder
        v-model="postText"
        :symbols="symbols"
        :disabled="disabled"
        :block-informal="blockInformal"
        initial-mode="visual"
        :label="t('visual.post')"
      />
      <SectionCard v-if="missingCases.length" :title="t('visual.missingCases')">
        <ul class="space-y-2">
          <li
            v-for="c in missingCases"
            :key="c.id"
            class="flex items-start justify-between gap-2 text-[12px] text-content-secondary"
          >
            <span>⚠ {{ c.summary }}</span>
            <button
              type="button"
              class="shrink-0 text-accent hover:underline disabled:opacity-40"
              :disabled="disabled"
              @click="addMissingCase(c.summary)"
            >
              {{ t('visual.addToSpec') }}
            </button>
          </li>
        </ul>
      </SectionCard>
    </div>

    <div v-show="section === 'scenarios'">
      <FsfScenarioEditor
        v-if="fsfModel"
        ref="fsfRef"
        :model="fsfModel"
        :symbols="symbols"
        :disabled="disabled"
        :block-informal="blockInformal"
        @save="onFsfPatch"
      />
      <p v-else class="text-sm text-content-secondary">{{ t('visual.noFsfDerived') }}</p>
    </div>
  </div>
</template>
