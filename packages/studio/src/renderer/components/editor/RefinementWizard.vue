<script setup lang="ts">
import { ref, watch, onUnmounted, shallowRef, nextTick, computed } from 'vue'
import type * as Monaco from 'monaco-editor'
import { useI18n } from 'vue-i18n'
import { useDocumentStore } from '../../stores/document'
import { useHistoryStore } from '../../stores/history'
import { HistoryKinds } from '../../history/kinds'
import { monaco, initMonacoBase } from '../../monaco/setup'
import type { CoverageReportPayload } from '../../preload/index'
import CoveragePanel from './CoveragePanel.vue'

type MergeStrategy = 'merge_fsf_only' | 'keep_hybrid' | 'use_generated'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; refined: [asflTabId: string] }>()

const { t } = useI18n()
const doc = useDocumentStore()
const refining = ref(false)
const preview = ref('')
const coverage = ref<CoverageReportPayload | null>(null)
const skeletonOnly = ref(false)
const preserveExisting = ref(true)
const traceJson = ref<string | undefined>(undefined)
const error = ref<string | null>(null)
const mergePlans = ref<Array<{ aspecId: string; processName: string; strategy: MergeStrategy }>>([])
const targetMode = ref<'linked' | 'new'>('linked')
const diffContainer = ref<HTMLElement | null>(null)
const diffEditor = shallowRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
let originalModel: Monaco.editor.ITextModel | null = null
let modifiedModel: Monaco.editor.ITextModel | null = null

const aspecTab = () =>
  doc.documentTabs.find((t) => t.documentKind === 'aspec' && t.id === doc.activeTabId) ??
  doc.documentTabs.find((t) => t.documentKind === 'aspec')

function hybridTab() {
  const tab = aspecTab()
  if (targetMode.value === 'new') return undefined
  const linked = tab?.linkedDocumentId
  if (linked) return doc.documentTabs.find((t) => t.id === linked)
  return doc.documentTabs.find((t) => t.documentKind === 'asfl')
}

const hybridTargets = computed(() => {
  const tab = aspecTab()
  const options: Array<{ id: string; label: string }> = []
  if (tab?.linkedDocumentId) {
    const linked = doc.documentTabs.find((t) => t.id === tab.linkedDocumentId)
    if (linked) options.push({ id: linked.id, label: linked.title })
  }
  for (const t of doc.documentTabs.filter((x) => x.documentKind === 'asfl')) {
    if (!options.some((o) => o.id === t.id)) options.push({ id: t.id, label: t.title })
  }
  return options
})

async function initMergePlans(): Promise<void> {
  const tab = aspecTab()
  if (!tab || !window.studio?.buildInformalModel) return
  const model = await window.studio.buildInformalModel(tab.content)
  mergePlans.value = model.modules.flatMap((m) =>
    (m.processes ?? []).map((p) => ({
      aspecId: p.id,
      processName: p.name,
      strategy: 'merge_fsf_only' as MergeStrategy
    }))
  )
}

function syncDiffModels(): void {
  const hybrid = hybridTab()
  const original = hybrid?.content ?? ''
  if (!diffEditor.value) return
  if (!originalModel || !modifiedModel) {
    originalModel = monaco.editor.createModel(original, 'agile-sofl')
    modifiedModel = monaco.editor.createModel(preview.value, 'agile-sofl')
    diffEditor.value.setModel({ original: originalModel, modified: modifiedModel })
    return
  }
  if (originalModel.getValue() !== original) originalModel.setValue(original)
  if (modifiedModel.getValue() !== preview.value) modifiedModel.setValue(preview.value)
}

async function ensureDiffEditor(): Promise<void> {
  await nextTick()
  if (!props.open || !diffContainer.value || diffEditor.value) return
  initMonacoBase()
  const isDark = document.documentElement.classList.contains('dark')
  diffEditor.value = monaco.editor.createDiffEditor(diffContainer.value, {
    readOnly: true,
    automaticLayout: true,
    renderSideBySide: true,
    fontSize: 12,
    theme: isDark ? 'agile-sofl-dark' : 'agile-sofl-light',
    scrollBeyondLastLine: false
  })
  syncDiffModels()
}

async function resolveGuiSource(tab: NonNullable<ReturnType<typeof aspecTab>>): Promise<string | undefined> {
  const guiTarget = (await window.studio?.buildInformalModel(tab.content))?.meta.guiTarget
  if (guiTarget && tab.filePath && window.studio?.fileRead) {
    try {
      const base = tab.filePath.replace(/[/\\][^/\\]+$/, '')
      const file = await window.studio.fileRead(`${base}/${guiTarget.replace(/^\.\//, '')}`.replace(/\\/g, '/'))
      return file.content
    } catch {
      /* no external gui */
    }
  }
  if (tab.content.includes('\ngui:') || tab.content.startsWith('gui:')) return tab.content
  const pair = doc.documentTabs.find((t) => t.documentKind === 'guispec' && t.linkedDocumentId === tab.id)
  return pair?.content
}

async function loadPreview(): Promise<void> {
  const tab = aspecTab()
  if (!tab || !window.studio?.refineAspec) return
  error.value = null
  preview.value = ''
  const hybrid = hybridTab()
  const guiSource = await resolveGuiSource(tab)
  const result = await window.studio.refineAspec({
    source: tab.content,
    aspecUri: tab.filePath ?? undefined,
    existingAsfl: preserveExisting.value && targetMode.value === 'linked' ? hybrid?.content : undefined,
    skeletonOnly: skeletonOnly.value,
    mergePlans: preserveExisting.value ? mergePlans.value : undefined,
    guiSource,
    emitGuiBlock: Boolean(guiSource)
  })
  preview.value = result.asflText
  if (!result.checkOk) {
    error.value = result.checkDiagnostics?.map((d) => d.message).join('; ') ?? t('refine.checkFailed')
  }
  if (window.studio.buildCoverageReport) {
    if (tab.filePath && window.studio.fileRead) {
      try {
        const tracePath = tab.filePath.replace(/\.aspec$/i, '.aspec.trace.json')
        const tr = await window.studio.fileRead(tracePath)
        traceJson.value = tr.content
      } catch {
        traceJson.value = undefined
      }
    }
    coverage.value = await window.studio.buildCoverageReport({
      aspecSource: tab.content,
      asflSource: hybrid?.content ?? preview.value,
      traceJson: traceJson.value
    })
  } else {
    coverage.value = null
  }
  syncDiffModels()
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      await initMergePlans()
      preserveExisting.value = Boolean(hybridTab())
      await loadPreview()
      await ensureDiffEditor()
    }
  },
  { immediate: true }
)

watch([preview, targetMode, preserveExisting, skeletonOnly, mergePlans], () => syncDiffModels(), { deep: true })

async function runRefine(): Promise<void> {
  const tab = aspecTab()
  if (!tab || !window.studio?.refineAspec) return
  refining.value = true
  try {
    const hybrid = hybridTab()
    const guiSource = await resolveGuiSource(tab)
    const result = await window.studio.refineAspec({
      source: tab.content,
      aspecUri: tab.filePath ?? undefined,
      existingAsfl: preserveExisting.value && targetMode.value === 'linked' ? hybrid?.content : undefined,
      skeletonOnly: skeletonOnly.value,
      mergePlans: preserveExisting.value ? mergePlans.value : undefined,
      guiSource,
      emitGuiBlock: Boolean(guiSource)
    })
    let target = targetMode.value === 'linked' ? hybrid : undefined
    if (!target) {
      const title = tab.filePath?.replace(/\.aspec$/i, '.asfl').split(/[/\\]/).pop() ?? 'Refined.asfl'
      target = doc.newTab({ content: result.asflText, title, documentKind: 'asfl' })
    } else {
      useHistoryStore().applyDocument(target.id, result.asflText, {
        kind: HistoryKinds.hybridEdit,
        immediate: true
      })
    }
    doc.linkTabs(tab.id, target.id)
    if (tab.filePath && window.studio.writeTraceFile) {
      const tracePath = tab.filePath.replace(/\.aspec$/i, '.aspec.trace.json')
      await window.studio.writeTraceFile(tracePath, JSON.stringify(result.traceability, null, 2))
    }
    emit('refined', target.id)
    emit('close')
  } finally {
    refining.value = false
  }
}

onUnmounted(() => {
  diffEditor.value?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
  diffEditor.value = null
  originalModel = null
  modifiedModel = null
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="emit('close')"
    >
      <div class="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-border-subtle bg-surface-raised shadow-lg">
        <div class="border-b border-border-subtle px-5 py-4">
          <h2 class="text-lg font-semibold">{{ t('refine.title') }}</h2>
          <p class="mt-1 text-sm text-content-secondary">{{ t('refine.subtitle') }}</p>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-4 studio-scroll space-y-4">
          <p v-if="!aspecTab()" class="text-sm text-content-muted">{{ t('refine.noAspec') }}</p>
          <template v-else>
            <div class="flex flex-wrap gap-4 text-sm">
              <label class="flex items-center gap-2">
                <input v-model="targetMode" type="radio" value="linked" class="rounded" @change="loadPreview" />
                {{ t('refine.targetLinked') }}
              </label>
              <label class="flex items-center gap-2">
                <input v-model="targetMode" type="radio" value="new" class="rounded" @change="loadPreview" />
                {{ t('refine.targetNew') }}
              </label>
            </div>
            <p v-if="hybridTargets.length && targetMode === 'linked'" class="text-xs text-content-muted">
              {{ t('refine.targetHint', { targets: hybridTargets.map((x) => x.label).join(', ') }) }}
            </p>
            <div class="flex flex-wrap gap-4 text-sm">
              <label class="flex items-center gap-2">
                <input v-model="skeletonOnly" type="checkbox" class="rounded" @change="loadPreview" />
                {{ t('refine.skeletonOnly') }}
              </label>
              <label class="flex items-center gap-2">
                <input v-model="preserveExisting" type="checkbox" class="rounded" @change="loadPreview" />
                {{ t('refine.preserveExisting') }}
              </label>
            </div>
            <div v-if="preserveExisting && mergePlans.length" class="rounded border border-border-subtle p-3">
              <p class="mb-2 text-xs font-medium text-content-secondary">{{ t('refine.mergeTable') }}</p>
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-left text-content-muted">
                    <th class="pb-1">{{ t('refine.mergeProcess') }}</th>
                    <th>{{ t('refine.mergeStrategy') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in mergePlans" :key="row.aspecId">
                    <td class="py-1 pr-2">{{ row.processName }}</td>
                    <td>
                      <select
                        v-model="row.strategy"
                        class="rounded border border-border-subtle bg-surface-base px-2 py-0.5"
                        @change="loadPreview"
                      >
                        <option value="merge_fsf_only">{{ t('refine.mergeFsfOnly') }}</option>
                        <option value="keep_hybrid">{{ t('refine.mergeKeepHybrid') }}</option>
                        <option value="use_generated">{{ t('refine.mergeUseGenerated') }}</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <CoveragePanel v-if="coverage" :report="coverage" />
            <div>
              <p class="mb-2 text-xs font-medium text-content-secondary">{{ t('refine.diffTitle') }}</p>
              <div ref="diffContainer" class="h-64 min-h-[16rem] rounded border border-border-subtle" />
            </div>
            <p v-if="error" class="text-sm text-semantic-error">{{ error }}</p>
          </template>
        </div>
        <div class="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" class="rounded-md px-3 py-1.5 text-sm hover:bg-surface-overlay" @click="emit('close')">
            {{ t('newProjectTemplate.cancel') }}
          </button>
          <button
            type="button"
            class="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            :disabled="!aspecTab() || refining"
            @click="runRefine"
          >
            {{ t('refine.run') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
