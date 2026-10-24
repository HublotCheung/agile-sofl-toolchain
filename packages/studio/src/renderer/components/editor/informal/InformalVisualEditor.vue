<script setup lang="ts">
import { ref, computed, inject, watch, onMounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentStore } from '../../../stores/document'
import { INFORMAL_MODEL_KEY } from '../../../composables/informalModelContext'
import { GUI_MODEL_KEY } from '../../../composables/guiModelContext'
import { useGuiModel } from '../../../composables/useGuiModel'
import GuiVisualEditor from '../gui/GuiVisualEditor.vue'
import SystemOverviewCard from './SystemOverviewCard.vue'
import InformalModuleCard from './InformalModuleCard.vue'
import InformalProcessCard from './InformalProcessCard.vue'
import InformalFunctionCard from './InformalFunctionCard.vue'
import BookAlignCard from './BookAlignCard.vue'
import InformalToolbar from './InformalToolbar.vue'
import ParseErrorBanner from '../visual/ParseErrorBanner.vue'
import { nextInvariantPlaceholder } from '../../../lib/visualNames'

const { t } = useI18n()
const doc = useDocumentStore()
const informal = inject(INFORMAL_MODEL_KEY)
if (!informal) throw new Error('InformalVisualEditor requires INFORMAL_MODEL_KEY')

const panelMode = ref<'informal' | 'gui'>('informal')
const embeddedFlag = ref(true)
const informalMeta = computed(() => informal.model.value?.meta)
const embeddedGui = useGuiModel(computed(() => doc.activeTabId), {
  embeddedInAspec: embeddedFlag,
  informalMeta
})
provide(GUI_MODEL_KEY, embeddedGui)

const selectedModuleId = ref<string | null>(null)
const selectedProcessId = ref<string | null>(null)
const selectedFunctionId = ref<string | null>(null)
const showBookAlign = ref(false)

const modules = computed(() => informal.model.value?.modules ?? [])

watch(modules, (list) => {
  if (!list.length) {
    selectedModuleId.value = null
    selectedProcessId.value = null
    selectedFunctionId.value = null
    return
  }
  if (!selectedModuleId.value || !list.some((m) => m.id === selectedModuleId.value)) {
    selectedModuleId.value = list[0]!.id
  }
}, { immediate: true })

watch(
  () => informal.model.value?.meta.hybridTarget,
  () => {
    void informal.offerHybridLink()
  }
)

onMounted(() => {
  void informal.offerHybridLink()
})

const selectedModule = computed(() =>
  modules.value.find((m) => m.id === selectedModuleId.value) ?? null
)

const selectedProcess = computed(() =>
  selectedModule.value?.processes?.find((p) => p.id === selectedProcessId.value) ?? null
)

const selectedFunction = computed(() =>
  selectedModule.value?.functions?.find((f) => f.id === selectedFunctionId.value) ?? null
)

const writeDisabled = computed(() => informal.parseBlocked.value)
const informalDiagnostics = computed(() => informal.model.value?.diagnostics ?? [])

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}

async function onPatch(idPath: string, value: unknown): Promise<void> {
  await informal.patchById(idPath, value)
}

async function addProcess(): Promise<void> {
  const mod = selectedModule.value
  if (!mod) return
  const id = newId('proc')
  await informal.addProcess(mod.id, {
    id,
    name: 'NewProcess',
    description: '',
    scenarios: [],
    refinementHints: { bottomLevel: false, expectedFsfLevel: 'semi-formal' }
  })
  selectedProcessId.value = id
  selectedFunctionId.value = null
}

async function addFunction(): Promise<void> {
  const mod = selectedModule.value
  if (!mod) return
  const id = newId('fn')
  await informal.addFunction(mod.id, { id, name: 'NewFunction', description: '' })
  selectedFunctionId.value = id
  selectedProcessId.value = null
}

async function removeProcess(): Promise<void> {
  const mod = selectedModule.value
  const proc = selectedProcess.value
  if (!mod || !proc) return
  await informal.removeProcess(mod.id, proc.id)
  selectedProcessId.value = null
}

async function addScenario(): Promise<void> {
  const mod = selectedModule.value
  const proc = selectedProcess.value
  if (!mod || !proc) return
  await informal.addScenario(mod.id, proc.id, {
    id: newId('scen'),
    condition: '',
    outcome: ''
  })
}

async function removeScenario(scenarioId: string): Promise<void> {
  const mod = selectedModule.value
  const proc = selectedProcess.value
  if (!mod || !proc) return
  await informal.removeScenario(mod.id, proc.id, scenarioId)
}

function patchStakeholders(raw: string): void {
  const list = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  void informal.patchField('system.stakeholders', list)
}
</script>

<template>
  <div class="visual-panel flex h-full min-h-0 w-full min-w-0 flex-col">
    <div class="flex border-b border-border-subtle px-3 py-1.5 text-xs">
      <button
        type="button"
        class="rounded px-2 py-0.5"
        :class="panelMode === 'informal' ? 'bg-surface-overlay font-medium' : 'text-content-secondary'"
        @click="panelMode = 'informal'"
      >
        {{ t('informal.modules') }}
      </button>
      <button
        type="button"
        class="ml-2 rounded px-2 py-0.5"
        :class="panelMode === 'gui' ? 'bg-surface-overlay font-medium' : 'text-content-secondary'"
        @click="panelMode = 'gui'"
      >
        {{ t('gui.title') }}
      </button>
    </div>
    <GuiVisualEditor v-if="panelMode === 'gui'" embedded />
    <template v-else>
    <ParseErrorBanner
      v-if="informal.hasErrors.value && !informal.parseBlocked.value"
      :diagnostics="informalDiagnostics"
      compact
      :message="t('informal.visualHasIssues')"
    />
    <ParseErrorBanner
      v-else-if="informal.parseBlocked.value"
      :diagnostics="informalDiagnostics"
      :message="t('informal.visualParseBlocked')"
    />
    <InformalToolbar
      :disabled="writeDisabled"
      :show-remove-process="Boolean(selectedProcess)"
      @add-process="addProcess"
      @add-function="addFunction"
      @remove-process="removeProcess"
      @format-yaml="informal.formatYaml()"
    />
    <div class="flex min-h-0 flex-1">
      <div class="w-48 shrink-0 overflow-y-auto border-r border-border-subtle p-2 studio-scroll">
        <p class="mb-2 text-xs font-medium text-content-secondary">{{ t('informal.modules') }}</p>
        <ul class="space-y-1">
          <li v-for="mod in modules" :key="mod.id">
            <button
              type="button"
              class="w-full rounded px-2 py-1 text-left text-sm"
              :class="selectedModuleId === mod.id ? 'bg-accent/15 text-accent' : 'text-content-primary hover:bg-surface-overlay'"
              @click="selectedModuleId = mod.id; selectedProcessId = null; selectedFunctionId = null"
            >
              {{ mod.name }}
            </button>
            <ul v-if="selectedModuleId === mod.id" class="ml-2 mt-1 space-y-0.5">
              <li v-for="proc in mod.processes ?? []" :key="proc.id">
                <button
                  type="button"
                  class="w-full truncate rounded px-2 py-0.5 text-left text-xs text-content-secondary hover:bg-surface-overlay"
                  @click="selectedModuleId = mod.id; selectedProcessId = proc.id; selectedFunctionId = null"
                >
                  {{ proc.name }}
                </button>
              </li>
              <li v-for="fn in mod.functions ?? []" :key="fn.id">
                <button
                  type="button"
                  class="w-full truncate rounded px-2 py-0.5 text-left text-xs text-content-muted hover:bg-surface-overlay"
                  @click="selectedModuleId = mod.id; selectedFunctionId = fn.id; selectedProcessId = null"
                >
                  ƒ {{ fn.name }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>
      <div class="min-w-0 flex-1 overflow-y-auto p-4 studio-scroll space-y-4">
        <SystemOverviewCard
          :purpose="informal.model.value?.system.purpose ?? ''"
          :scope="informal.model.value?.system.scope"
          :assumptions="informal.model.value?.system.assumptions"
          :stakeholders="informal.model.value?.system.stakeholders"
          :glossary="informal.model.value?.system.glossary"
          :disabled="writeDisabled"
          @patch-purpose="(v) => informal.patchById('system.purpose', v)"
          @patch-scope="(v) => informal.patchById('system.scope', v)"
          @patch-assumptions="(v) => informal.patchField('system.assumptions', v)"
          @patch-stakeholders="patchStakeholders"
          @patch-glossary="(v) => informal.patchField('system.glossary', v)"
        />
        <button type="button" class="text-xs text-accent hover:underline" @click="showBookAlign = !showBookAlign">
          {{ showBookAlign ? t('informal.hideBookAlign') : t('informal.showBookAlign') }}
        </button>
        <BookAlignCard
          v-if="showBookAlign"
          :book-align="informal.model.value?.bookAlign"
          :disabled="writeDisabled"
          @patch="(b) => informal.patchBookAlign(b)"
        />
        <InformalModuleCard
          v-if="selectedModule && !selectedProcess && !selectedFunction"
          :module="selectedModule"
          :disabled="writeDisabled"
          @patch="onPatch"
          @add-type="informal.addType(selectedModule!.id, { id: newId('type'), name: 'NewType', typeHint: 'nat' })"
          @add-variable="informal.addVariable(selectedModule!.id, { id: newId('var'), name: 'new_var', typeHint: 'nat' })"
          @add-invariant="
            informal.addInvariant(selectedModule!.id, {
              id: newId('inv'),
              textHint: nextInvariantPlaceholder(
                (selectedModule!.invariants ?? []).map((i) => i.textHint ?? i.description ?? '')
              )
            })
          "
          @add-constant="informal.addConstant(selectedModule!.id, { id: newId('const'), name: 'new_const', valueHint: '0' })"
          @remove-type="(id) => informal.removeType(selectedModule!.id, id)"
          @remove-variable="(id) => informal.removeVariable(selectedModule!.id, id)"
          @remove-invariant="(id) => informal.removeInvariant(selectedModule!.id, id)"
          @remove-constant="(id) => informal.removeConstant(selectedModule!.id, id)"
        />
        <InformalProcessCard
          v-if="selectedProcess && selectedModule"
          :process="selectedProcess"
          :module-id="selectedModule.id"
          :disabled="writeDisabled"
          @patch="onPatch"
          @add-scenario="addScenario"
          @remove-scenario="removeScenario"
        />
        <InformalFunctionCard
          v-else-if="selectedFunction"
          :fn="selectedFunction"
          :disabled="writeDisabled"
          @patch="onPatch"
        />
        <p v-else-if="!selectedModule" class="text-sm text-content-muted">{{ t('informal.selectProcess') }}</p>
      </div>
    </div>
    </template>
  </div>
</template>
