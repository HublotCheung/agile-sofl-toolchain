<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalStore } from '../../../stores/modal'
import { isDuplicateInModule } from '../../../lib/visualEntityGuard'
import type { VisualModuleSummary, DeclarationKind, SerializableSpan } from '../../../preload/index'
import type { TreeSelection } from '../../../composables/useVisualModel'
import type { CdfdGraph } from '../../../lib/editorApiRenderer'
import DeclarationEditor from './DeclarationEditor.vue'
import HybridGuiPanel from './HybridGuiPanel.vue'
import ResizeSplit from '../../ui/ResizeSplit.vue'
import OverviewStats from './overview/OverviewStats.vue'
import TypeGridPanel from './overview/TypeGridPanel.vue'
import VarEntityList from './overview/VarEntityList.vue'
import InvariantEntityList from './overview/InvariantEntityList.vue'
import ProcessGridPanel from './overview/ProcessGridPanel.vue'
import CdfdView from './CdfdView.vue'
import VisualEditDialog from './overview/VisualEditDialog.vue'
import VisualEntityMenu from './overview/VisualEntityMenu.vue'
import FormField from './ui/FormField.vue'
import TextField from './ui/TextField.vue'
import SectionCard from './ui/SectionCard.vue'
import { BASIC_TYPES, composedTypeText, nextFieldName, varDeclText } from '../../../lib/visualDecls'
import {
  nextInvariantPlaceholder,
  nextProcessName,
  nextTypeName,
  nextVarName
} from '../../../lib/visualNames'

const props = defineProps<{
  module: VisualModuleSummary
  cdfdGraph?: CdfdGraph | null
  /** Syntax parse failed — disable everything including delete */
  disabled?: boolean
  /** Duplicate / FSF diagnostics — block create and inline edit, allow delete */
  editDisabled?: boolean
}>()
const emit = defineEmits<{
  patchDeclaration: [payload: { kind: DeclarationKind; action: 'patch' | 'add' | 'remove'; name?: string; text?: string }]
  patchInvariant: [payload: { index: number; text: string }]
  addInvariant: [text: string]
  removeInvariant: [index: number]
  reorderInvariants: [fromIndex: number, toIndex: number]
  revealSpan: [span: SerializableSpan]
  select: [selection: TreeSelection]
  patchGuiWidget: [payload: { screenName: string; widgetName: string; text: string }]
  editProcess: [name: string]
  removeProcess: [name: string]
  editFunction: [name: string]
  removeFunction: [name: string]
  addProcess: [payload: { name: string; isInit: boolean }]
  cdfdDrill: [moduleName: string]
  selectCdfdProcess: [processName: string]
}>()

const { t } = useI18n()
const modal = useModalStore()
const formDisabled = computed(() => Boolean(props.disabled || props.editDisabled))
const varInvRatio = ref(0.5)
const createKind = ref<'type' | 'var' | 'inv' | 'process' | null>(null)
const createName = ref('')
const createType = ref('nat')
const createInit = ref(false)
const createPredicate = ref('')

const typeNames = computed(() => props.module.types.map((ty) => ty.name))
const typeOptions = computed(() => [...BASIC_TYPES, ...typeNames.value])

function displayName(): string {
  return props.module.isSystem ? `SYSTEM_${props.module.name}` : props.module.name
}

function onCreate(kind: 'type' | 'var' | 'inv' | 'process'): void {
  createKind.value = kind
  createInit.value = false
  createType.value = 'nat'
  if (kind === 'type') createName.value = nextTypeName(props.module.types.map((t) => t.name))
  else if (kind === 'var') createName.value = nextVarName(props.module.vars.map((v) => v.name))
  else if (kind === 'process') {
    createName.value = nextProcessName(props.module.processes.map((p) => p.name))
  } else if (kind === 'inv') {
    createPredicate.value = nextInvariantPlaceholder(
      props.module.invariants.map((inv) => inv.text)
    )
    createName.value = ''
  } else createName.value = ''
}

async function blockDuplicate(kind: Parameters<typeof isDuplicateInModule>[1], value: string): Promise<boolean> {
  if (!isDuplicateInModule(props.module, kind, value)) return false
  await modal.show({
    title: t('visual.duplicateName.title'),
    message: t('visual.duplicateName.message', { name: value }),
    buttons: [t('dialog.ok')]
  })
  return true
}

async function confirmCreate(): Promise<void> {
  const kind = createKind.value
  if (!kind) return
  if (kind === 'type') {
    const name = createName.value.trim() || nextTypeName(props.module.types.map((t) => t.name))
    if (await blockDuplicate('type', name)) return
    const fieldName = nextFieldName([])
    emit('patchDeclaration', {
      kind: 'type',
      action: 'add',
      text: composedTypeText(name, [{ name: fieldName, type: 'nat' }])
    })
  } else if (kind === 'var') {
    const name = createName.value.trim() || nextVarName(props.module.vars.map((v) => v.name))
    if (await blockDuplicate('var', name)) return
    emit('patchDeclaration', { kind: 'var', action: 'add', text: varDeclText(name, createType.value) })
  } else if (kind === 'inv') {
    const text =
      createPredicate.value.trim() ||
      nextInvariantPlaceholder(props.module.invariants.map((inv) => inv.text))
    if (await blockDuplicate('invariant', text)) return
    emit('addInvariant', text)
  } else {
    const name =
      createName.value.trim() || nextProcessName(props.module.processes.map((p) => p.name))
    if (name !== 'Init' && (await blockDuplicate('process', name))) return
    emit('addProcess', { name, isInit: createInit.value })
  }
  createKind.value = null
}

const createTitle = computed(() => {
  if (createKind.value === 'type') return t('visual.type.createTitle')
  if (createKind.value === 'var') return t('visual.var.createTitle')
  if (createKind.value === 'inv') return t('visual.inv.createTitle')
  if (createKind.value === 'process') return t('visual.process.createTitle')
  return ''
})
</script>

<template>
  <div class="visual-panel space-y-4 p-4">
    <header>
      <h2 class="text-lg font-semibold text-content-primary">{{ displayName() }}</h2>
      <p v-if="module.parentName" class="text-sm text-content-secondary">
        {{ t('visual.parentModule') }}: {{ module.parentName }}
      </p>
    </header>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <OverviewStats :module="module" :disabled="formDisabled" @create="onCreate" />
      <DeclarationEditor
        kind="const"
        :items="module.consts"
        :module-name="module.name"
        :disabled="formDisabled"
        @patch="emit('patchDeclaration', $event)"
        @reveal-span="emit('revealSpan', $event)"
      />
    </div>

    <TypeGridPanel
      :items="module.types"
      :extra-types="typeNames"
      :disabled="formDisabled"
      @patch="emit('patchDeclaration', { kind: 'type', ...$event })"
    />

    <section class="min-h-[220px] overflow-hidden rounded-lg border border-border-subtle bg-surface-raised">
      <ResizeSplit direction="horizontal" :ratio="varInvRatio" @update:ratio="varInvRatio = $event">
        <template #first>
          <div class="h-full min-h-0 overflow-auto p-4">
            <VarEntityList
              :items="module.vars"
              :type-names="typeNames"
              :disabled="formDisabled"
              @patch="emit('patchDeclaration', { kind: 'var', ...$event })"
            />
          </div>
        </template>
        <template #second>
          <div class="h-full min-h-0 overflow-auto p-4">
            <InvariantEntityList
              :module="module"
              :invariants="module.invariants ?? []"
              :edit-disabled="formDisabled"
              :disabled="disabled"
              @patch="emit('patchInvariant', $event)"
              @remove="emit('removeInvariant', $event)"
              @reorder="(from, to) => emit('reorderInvariants', from, to)"
            />
          </div>
        </template>
      </ResizeSplit>
    </section>

    <ProcessGridPanel
      :module-name="module.name"
      :processes="module.processes"
      :disabled="disabled"
      :edit-disabled="formDisabled"
      @edit="emit('editProcess', $event)"
      @remove="emit('removeProcess', $event)"
    />

    <SectionCard>
      <template #title>
        <h3 class="text-sm font-semibold text-content-primary">{{ t('visual.section.cdfd') }}</h3>
      </template>
      <div class="h-[min(360px,50vh)] min-h-[240px] overflow-hidden rounded-md border border-border-subtle bg-surface-base">
        <CdfdView
          active
          class="h-full"
          :graph="(cdfdGraph ?? null) as never"
          :module-name="module.name"
          @drill="emit('cdfdDrill', $event)"
          @select-process="emit('selectCdfdProcess', $event)"
        />
      </div>
    </SectionCard>

    <SectionCard v-if="module.functions.length">
      <template #title>
        <h3 class="text-sm font-semibold text-content-primary">{{ t('visual.section.functions') }}</h3>
      </template>
      <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <li
          v-for="f in module.functions"
          :key="f.name"
          class="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-sm text-content-primary">{{ f.name }}</span>
          <VisualEntityMenu
            :disabled="disabled"
            @edit="emit('editFunction', f.name)"
            @remove="emit('removeFunction', f.name)"
          />
        </li>
      </ul>
    </SectionCard>

    <HybridGuiPanel
      v-if="module.gui"
      :gui="module.gui"
      :module="module"
      :disabled="disabled"
      @reveal-span="emit('revealSpan', $event)"
    />
  </div>

  <VisualEditDialog
    :open="createKind != null"
    :title="createTitle"
    @close="createKind = null"
    @confirm="confirmCreate"
  >
    <div v-if="createKind === 'type' || createKind === 'var' || createKind === 'process'" class="space-y-3">
      <FormField :label="t('visual.create.name')">
        <TextField v-model="createName" mono :disabled="formDisabled || createInit" />
      </FormField>
      <FormField v-if="createKind === 'var'" :label="t('visual.var.type')">
        <select v-model="createType" class="visual-field w-full px-3 py-2 text-sm" :disabled="formDisabled">
          <option v-for="ty in typeOptions" :key="ty" :value="ty">{{ ty }}</option>
        </select>
      </FormField>
      <label v-if="createKind === 'process'" class="flex items-center gap-2 text-sm text-content-primary">
        <input v-model="createInit" type="checkbox" class="rounded border-border-subtle" :disabled="formDisabled" />
        {{ t('visual.process.initProcess') }}
      </label>
    </div>
    <FormField v-else-if="createKind === 'inv'" :label="t('visual.inv.predicate')">
      <TextField v-model="createPredicate" :rows="4" mono :disabled="formDisabled" />
    </FormField>
  </VisualEditDialog>
</template>
