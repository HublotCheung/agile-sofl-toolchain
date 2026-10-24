import { ref, watch, computed, type Ref } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { HistoryKinds } from '../history/kinds'
import { useModalStore } from '../stores/modal'
import { useEditorUiStore } from '../stores/editorUi'
import type {
  BookAlignPayload,
  InformalModelPayload,
  InformalProcessPayload
} from '../preload/index'
import { isInformalDuplicate } from '../lib/informalEntityGuard'
import { useI18n } from 'vue-i18n'

const DEBOUNCE_MS = 300

export function useInformalModel(activeTabId: Ref<string | undefined>) {
  const doc = useDocumentStore()
  const history = useHistoryStore()
  const modal = useModalStore()
  const editorUi = useEditorUiStore()
  const { t } = useI18n()
  const model = ref<InformalModelPayload | null>(null)
  const loading = ref(false)
  const lastRebuiltContent = ref('')
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const activeTab = computed(() =>
    doc.tabs.find((t) => t.id === activeTabId.value && t.kind === 'document' && t.documentKind === 'aspec')
  )

  const hasErrors = computed(() =>
    (model.value?.diagnostics ?? []).some((d) => d.severity === 'error')
  )

  const parseBlocked = computed(() => model.value?.meta?.title === 'Invalid')

  async function rebuildNow(): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio?.buildInformalModel) return
    loading.value = true
    try {
      model.value = await window.studio.buildInformalModel(tab.content, {
        bookAlignStrict: editorUi.bookAlignStrict
      })
      lastRebuiltContent.value = tab.content
    } finally {
      loading.value = false
    }
  }

  function scheduleRebuild(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void rebuildNow(), DEBOUNCE_MS)
  }

  watch(
    () => activeTab.value?.content,
    (content) => {
      if (content == null) return
      if (content === lastRebuiltContent.value) return
      scheduleRebuild()
    },
    { immediate: true }
  )

  watch(activeTabId, () => {
    void rebuildNow()
  })

  watch(
    () => editorUi.bookAlignStrict,
    () => void rebuildNow()
  )

  function applySourcePatch(next: string): void {
    const tab = activeTab.value
    if (!tab || next === tab.content) return
    history.applyDocument(tab.id, next, {
      kind: HistoryKinds.informalEdit,
      immediate: true
    })
    lastRebuiltContent.value = next
    void rebuildNow()
  }

  async function blockInformalDuplicate(
    moduleId: string,
    kind: Parameters<typeof isInformalDuplicate>[1],
    value: string
  ): Promise<boolean> {
    const mod = model.value?.modules.find((m) => m.id === moduleId)
    if (!mod || !isInformalDuplicate(mod, kind, value)) return false
    await modal.show({
      title: t('visual.duplicateName.title'),
      message: t('visual.duplicateName.message', { name: value }),
      buttons: [t('dialog.ok')]
    })
    return true
  }

  async function patchViaIpc(payload: Parameters<NonNullable<typeof window.studio>['patchAspec']>[0]): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio?.patchAspec) return
    const next = await window.studio.patchAspec({ source: tab.content, ...payload })
    applySourcePatch(next)
  }

  async function patchField(path: string, value: unknown): Promise<void> {
    if (parseBlocked.value) return
    await patchViaIpc({ action: 'patch-field', path, value })
  }

  async function patchById(idPath: string, value: unknown): Promise<void> {
    if (parseBlocked.value) return
    await patchViaIpc({ action: 'patch-by-id', idPath, value })
  }

  async function patchBookAlign(bookAlign: BookAlignPayload): Promise<void> {
    await patchViaIpc({ action: 'patch-book-align', bookAlign })
  }

  async function formatYaml(): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio?.formatAspec) return
    const next = await window.studio.formatAspec(tab.content)
    applySourcePatch(next)
  }

  async function addProcess(moduleId: string, process: InformalProcessPayload): Promise<void> {
    if (await blockInformalDuplicate(moduleId, 'process', process.name)) return
    await patchViaIpc({ action: 'add-process', moduleId, process })
  }

  async function removeProcess(moduleId: string, processId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-process', moduleId, processId })
  }

  async function addScenario(
    moduleId: string,
    processId: string,
    scenario: { id: string; condition: string; outcome: string }
  ): Promise<void> {
    await patchViaIpc({ action: 'add-scenario', moduleId, processId, scenario })
  }

  async function removeScenario(moduleId: string, processId: string, scenarioId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-scenario', moduleId, processId, scenarioId })
  }

  async function addFunction(moduleId: string, fn: { id: string; name: string; description?: string }): Promise<void> {
    if (await blockInformalDuplicate(moduleId, 'function', fn.name)) return
    await patchViaIpc({ action: 'add-function', moduleId, function: fn })
  }

  async function removeFunction(moduleId: string, functionId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-function', moduleId, functionId })
  }

  async function addType(
    moduleId: string,
    type: { id: string; name: string; typeHint?: string; description?: string }
  ): Promise<void> {
    if (await blockInformalDuplicate(moduleId, 'type', type.name)) return
    await patchViaIpc({ action: 'add-type', moduleId, type })
  }

  async function removeType(moduleId: string, typeId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-type', moduleId, typeId })
  }

  async function addVariable(
    moduleId: string,
    variable: { id: string; name: string; typeHint?: string; description?: string }
  ): Promise<void> {
    if (await blockInformalDuplicate(moduleId, 'variable', variable.name)) return
    await patchViaIpc({ action: 'add-variable', moduleId, variable })
  }

  async function removeVariable(moduleId: string, variableId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-variable', moduleId, variableId })
  }

  async function addInvariant(
    moduleId: string,
    invariant: { id: string; textHint?: string; description?: string }
  ): Promise<void> {
    const key = (invariant.textHint ?? invariant.description ?? '').trim()
    if (key && (await blockInformalDuplicate(moduleId, 'invariant', key))) return
    await patchViaIpc({ action: 'add-invariant', moduleId, invariant })
  }

  async function removeInvariant(moduleId: string, invariantId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-invariant', moduleId, invariantId })
  }

  async function addConstant(
    moduleId: string,
    constant: { id: string; name: string; valueHint?: string; description?: string }
  ): Promise<void> {
    if (await blockInformalDuplicate(moduleId, 'constant', constant.name)) return
    await patchViaIpc({ action: 'add-constant', moduleId, constant })
  }

  async function removeConstant(moduleId: string, constantId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-constant', moduleId, constantId })
  }

  async function offerHybridLink(): Promise<void> {
    const tab = activeTab.value
    if (!tab || tab.linkedDocumentId || !model.value?.meta.hybridTarget || !window.studio?.fileRead) return
    const target = model.value.meta.hybridTarget.replace(/^\.\//, '')
    const base = tab.filePath?.replace(/[/\\][^/\\]+$/, '')
    if (!base) return
    const hybridPath = `${base}/${target}`.replace(/\\/g, '/')
    try {
      const file = await window.studio.fileRead(hybridPath)
      const result = await modal.show({
        title: 'Link Hybrid',
        message: `Open paired hybrid spec ${target}?`,
        buttons: ['Cancel', 'Open & Link']
      })
      if (result.index !== 1) return
      const hybridTab = doc.openFromFile(file.filePath, file.content, file.title)
      doc.linkTabs(tab.id, hybridTab.id)
    } catch {
      /* hybrid file missing */
    }
  }

  return {
    model,
    loading,
    hasErrors,
    parseBlocked,
    rebuildNow,
    patchField,
    patchById,
    patchBookAlign,
    formatYaml,
    addProcess,
    removeProcess,
    addScenario,
    removeScenario,
    addFunction,
    removeFunction,
    addType,
    removeType,
    addVariable,
    removeVariable,
    addInvariant,
    removeInvariant,
    addConstant,
    removeConstant,
    offerHybridLink,
    applySourcePatch
  }
}
