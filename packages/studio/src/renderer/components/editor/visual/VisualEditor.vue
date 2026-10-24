<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeclarationKind, SerializableSpan, DiagnosticSummary, VisualModuleSummary } from '../../../preload/index'
import { useDocumentStore } from '../../../stores/document'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useEditorUiStore } from '../../../stores/editorUi'
import { useLinkedInformalHints } from '../../../composables/useLinkedInformalHints'
import { useEditorSelectionStore } from '../../../stores/editorSelection'
import type { TreeSelection } from '../../../composables/useVisualModel'
import { VISUAL_MODEL_KEY } from '../../../composables/visualModelContext'
import { useRefinementState } from '../../../composables/useRefinementState'
import type { VisualActionType } from '../../../composables/visualActions'
import type { FsfModelDto } from './FsfScenarioEditor.vue'
import ParseErrorBanner from './ParseErrorBanner.vue'
import VisualToolbar from './VisualToolbar.vue'
import VisualContextMenu from './VisualContextMenu.vue'
import ModuleTree from './ModuleTree.vue'
import ModuleGraphView from './ModuleGraphView.vue'
import AtomicityTree from './AtomicityTree.vue'
import ModuleOverview from './ModuleOverview.vue'
import ProcessEditDialog from './ProcessEditDialog.vue'
import FunctionEditDialog from './FunctionEditDialog.vue'
import type { ProcessEditorDraft } from './ProcessEditor.vue'
import { useModalStore } from '../../../stores/modal'
import ResizableSplit from '../../ui/ResizableSplit.vue'
import type { SymbolHint } from './predicate/predicateTypes'
import {
  adjustRefinementDiagnosticSeverity,
  hasBlockingHybridDiagnostics,
  type ProcessNodeMeta
} from '@agile-sofl/editor-api'
import {
  composedTypeText,
  nextFieldName,
  varDeclText
} from '../../../lib/visualDecls'
import {
  constDeclText,
  nextConstName,
  nextNumberedName,
  nextProcessName,
  nextTypeName,
  nextVarName
} from '../../../lib/visualNames'

const PREDICATE_KEYWORDS: SymbolHint[] = [
  { label: 'and', kind: 'keyword' },
  { label: 'or', kind: 'keyword' },
  { label: 'not', kind: 'keyword' },
  { label: 'true', kind: 'keyword' },
  { label: 'false', kind: 'keyword' },
  { label: 'forall', kind: 'keyword' },
  { label: 'exists', kind: 'keyword' }
]

const props = withDefaults(
  defineProps<{
    hideNavigator?: boolean
    forcedSelection?: TreeSelection
  }>(),
  { hideNavigator: false }
)

const emit = defineEmits<{ revealSpan: [span: SerializableSpan]; select: [selection: TreeSelection] }>()

const { t } = useI18n()
const modal = useModalStore()
const doc = useDocumentStore()
const workspace = useWorkspaceStore()
const editorUi = useEditorUiStore()
const linkedHints = useLinkedInformalHints(computed(() => doc.activeTabId))
const editorSelection = useEditorSelectionStore()
const selected = ref<TreeSelection>(null)
const searchQuery = ref('')
const contextMenu = ref<{ x: number; y: number; selection: TreeSelection } | null>(null)
const editingProcessName = ref<string | null>(null)
const editingFunctionName = ref<string | null>(null)

const visual = inject(VISUAL_MODEL_KEY)
if (!visual) throw new Error('VisualEditor requires VISUAL_MODEL_KEY provider')
const { state: refinementState } = useRefinementState(
  computed(() => !props.hideNavigator && editorUi.sideView === 'refine')
)

const modules = computed(() => visual.model.value?.modules ?? [])
const diagnostics = computed(
  () => (visual.model.value?.diagnostics ?? []) as DiagnosticSummary[]
)
const lintDiagnostics = computed(() =>
  adjustRefinementDiagnosticSeverity(diagnostics.value, editorUi.fsfStrictMode)
)
const hybridHasBlockingLint = computed(() =>
  hasBlockingHybridDiagnostics(lintDiagnostics.value, editorUi.fsfStrictMode)
)

watch(selected, (value) => {
  editorSelection.setSelection(value)
  emit('select', value)
  const editingThisProcess = value?.kind === 'process' && editingProcessName.value === value.processName
  const editingThisFunction = value?.kind === 'function' && editingFunctionName.value === value.functionName
  if (!editingThisProcess) editingProcessName.value = null
  if (!editingThisFunction) editingFunctionName.value = null
  if (value?.kind === 'process') {
    void nextTick(() => {
      document.getElementById(`visual-process-${value.processName}`)?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      })
    })
  }
}, { immediate: true })

watch(
  () => props.forcedSelection,
  (sel) => {
    if (sel) selected.value = sel
  },
  { immediate: true }
)

const parseBlocked = computed(() => visual.parseFailed.value)
/** Only a hard parse failure blocks visual edits; syntax diagnostics are shown as warnings. */
const editBlocked = computed(() => visual.parseFailed.value)
/** @deprecated use parseBlocked / editBlocked */
const writeDisabled = editBlocked

const writeDisabledReason = computed<'parseFailed' | 'diagnostics' | null>(() => {
  if (visual.parseFailed.value) return 'parseFailed'
  if (hybridHasBlockingLint.value) return 'diagnostics'
  return null
})

function selectionStillValid(sel: TreeSelection, list: VisualModuleSummary[]): boolean {
  if (!sel) return false
  const mod = list.find((m) => m.name === sel.moduleName)
  if (!mod) return false
  if (sel.kind === 'module') return true
  if (sel.kind === 'process') return mod.processes.some((p) => p.name === sel.processName)
  if (sel.kind === 'function') return mod.functions.some((f) => f.name === sel.functionName)
  return false
}

watch(modules, (list) => {
  const forced = props.forcedSelection
  if (forced && selectionStillValid(forced, list)) {
    selected.value = forced
    return
  }
  if (!list.length) {
    selected.value = null
    return
  }
  if (!selected.value || !selectionStillValid(selected.value, list)) {
    selected.value = { kind: 'module', moduleName: list[0].name }
  }
})

const selectedModule = computed(() =>
  selected.value ? modules.value.find((m) => m.name === selected.value!.moduleName) ?? null : null
)

const selectedCdfdGraph = computed(() => {
  const graphs = (visual.cdfdGraphs?.value ?? []) as Array<{ moduleName: string; empty?: boolean; nodes?: unknown[] }>
  const name = selectedModule.value?.name
  if (!name) return graphs[0] ?? null
  return graphs.find((g) => g.moduleName === name) ?? null
})

function onCdfdDrill(moduleName: string): void {
  const bare = moduleName.startsWith('SYSTEM_') ? moduleName.slice('SYSTEM_'.length) : moduleName
  const hit = modules.value.find((m) => m.name === moduleName || m.name === bare || `SYSTEM_${m.name}` === moduleName)
  if (hit) selected.value = { kind: 'module', moduleName: hit.name }
}

const selectedFsfModel = computed(() => {
  if (selected.value?.kind !== 'process') return null
  const name = selected.value.processName
  return (visual.fsfModels.value as FsfModelDto[]).find((m) => m.processName === name && !m.functionName) ?? null
})

const selectedFunctionFsfModel = computed(() => {
  if (selected.value?.kind !== 'function') return null
  const sel = selected.value
  return (visual.fsfModels.value as FsfModelDto[]).find(
    (m) => m.functionName === sel.functionName && m.moduleName === sel.moduleName
  ) ?? null
})

const symbolHints = computed((): SymbolHint[] => {
  const mod = selectedModule.value
  if (!mod) return PREDICATE_KEYWORDS
  return [
    ...mod.consts.map((c) => ({ label: c.name, kind: 'const' as const })),
    ...mod.types.map((t) => ({ label: t.name, kind: 'type' as const })),
    ...mod.vars.map((v) => ({ label: v.name, kind: 'var' as const })),
    ...PREDICATE_KEYWORDS
  ]
})

const graphProcessMeta = computed((): Record<string, ProcessNodeMeta> => {
  const meta: Record<string, ProcessNodeMeta> = {}
  for (const mod of modules.value) {
    for (const p of mod.processes) {
      meta[`${mod.name}::process::${p.name}`] = {
        isInit: p.isInit,
        isAlias: p.isAlias,
        aliasTarget: p.aliasTarget,
        hasExt: (p.ext?.length ?? 0) > 0
      }
    }
  }
  return meta
})

const graphHints = computed((): Record<string, string> => {
  const hints: Record<string, string> = {}
  for (const mod of modules.value) {
    for (const p of mod.processes) {
      const lines: string[] = []
      const comment = p.comment?.replace(/^comment:\s*/i, '').trim()
      const decom = p.decom?.replace(/^decom:\s*/i, '').trim()
      if (comment) lines.push(comment)
      if (decom) lines.push(`decom: ${decom}`)
      if (lines.length) hints[`${mod.name}::process::${p.name}`] = lines.join('\n')
    }
    for (const f of mod.functions) {
      const summary = f.text.split('\n').slice(0, 2).join(' ').trim()
      if (summary) hints[`${mod.name}::function::${f.name}`] = summary
    }
  }
  return hints
})

const selectedProcess = computed(() => {
  if (selected.value?.kind !== 'process' || !selectedModule.value) return null
  return selectedModule.value.processes.find((p) => p.name === selected.value!.processName) ?? null
})

const selectedFunction = computed(() => {
  if (selected.value?.kind !== 'function' || !selectedModule.value) return null
  return selectedModule.value.functions.find((f) => f.name === selected.value!.functionName) ?? null
})

const blockInformalPredicate = computed(() => {
  if (selected.value?.kind !== 'process') return false
  const proc = selectedProcess.value
  if (!proc) return false
  const hasDecom = Boolean(proc.decom?.trim())
  if (linkedHints.shouldBlockInformalForProcess(selected.value.processName, hasDecom)) return true
  if (editorUi.fsfStrictMode) {
    return linkedHints.blockInformalForProcess(selected.value.processName, hasDecom, true)
  }
  return false
})

const blockInformalFunction = computed(() => editorUi.fsfStrictMode && selected.value?.kind === 'function')

const detailPanelKey = computed(() => {
  const tabId = doc.activeTabId
  const gen = visual.modelGen.value
  const name = selectedModule.value?.name ?? 'none'
  return `${tabId}-${gen}-mod-${name}`
})

const breadcrumb = computed(() => {
  const sel = selected.value
  if (!sel) return ''
  const mod = selectedModule.value
  const modLabel = mod?.isSystem ? `SYSTEM_${mod.name}` : mod?.name ?? sel.moduleName
  if (sel.kind === 'module') return modLabel
  if (sel.kind === 'process') return `${modLabel} › ${sel.processName}`
  if (sel.kind === 'function') return `${modLabel} › ${sel.functionName}`
  return modLabel
})

function revealDecomInSource(moduleName: string, processName: string): void {
  const mod = modules.value.find((m) => m.name === moduleName)
  const proc = mod?.processes.find((p) => p.name === processName)
  if (!proc?.span) return
  const source = doc.activeTab?.content ?? ''
  const searchFrom = Math.max(0, proc.span.start - 20)
  const decomIdx = source.indexOf('decom:', searchFrom)
  if (decomIdx >= 0 && decomIdx <= proc.span.end + 80) {
    const end = Math.min(source.length, decomIdx + 48)
    emit('revealSpan', {
      start: decomIdx,
      end,
      line: proc.span.line,
      column: proc.span.column
    })
    return
  }
  emit('revealSpan', proc.span)
}

function revealForSelection(sel: TreeSelection): void {
  const mod = modules.value.find((m) => m.name === sel.moduleName)
  if (!mod) return
  if (sel.kind === 'process') {
    const proc = mod.processes.find((p) => p.name === sel.processName)
    if (proc?.span) emit('revealSpan', proc.span)
  } else if (sel.kind === 'function') {
    const fn = mod.functions.find((f) => f.name === sel.functionName)
    if (fn?.span) emit('revealSpan', fn.span)
  } else if (sel.kind === 'module') {
    const graphNode = visual.moduleGraph.value?.nodes.find(
      (n) => n.id === sel.moduleName && n.kind === 'module'
    )
    const span = mod.span ?? graphNode?.span
    if (span) emit('revealSpan', span)
    else if (mod.consts[0]?.span) emit('revealSpan', mod.consts[0].span)
  }
}

watch(selected, (sel) => {
  if (sel) revealForSelection(sel)
})

async function onPatch(payload: Parameters<NonNullable<typeof window.studio>['patchDocument']>[0]): Promise<void> {
  if (writeDisabled.value) return
  const key = `${payload.kind}:${payload.processName}`
  visual.scheduleVisualPatch(key, async (source) => {
    return window.studio!.patchDocument({ ...payload, source })
  })
}

function onPatchFunction(payload: {
  body?: string
  fsf?: { scenarios: FsfModelDto['scenarios']; others?: string }
}): void {
  if (writeDisabled.value || selected.value?.kind !== 'function') return
  visual.patchFunction({
    moduleName: selected.value.moduleName,
    name: selected.value.functionName,
    ...payload
  })
}

async function onPatchGuiWidget(payload: {
  screenName: string
  widgetName: string
  text: string
}): Promise<void> {
  if (writeDisabled.value) return
  const moduleName = selectedModule.value?.name
  if (!moduleName) return
  await visual.patchGuiWidget({ moduleName, ...payload })
}

async function onPatchDeclaration(payload: {
  kind: DeclarationKind
  action: 'patch' | 'add' | 'remove'
  name?: string
  text?: string
}): Promise<void> {
  if (payload.action === 'remove' ? parseBlocked.value : editBlocked.value) return
  const moduleName = selectedModule.value?.name
  if (!moduleName) return
  await visual.patchDeclaration({ moduleName, ...payload })
}

async function onPatchProcess(payload: {
  kind: 'process' | 'function'
  action: 'add' | 'remove' | 'rename'
  name: string
  newName?: string
  template?: string
}): Promise<void> {
  if (writeDisabled.value) return
  const moduleName = selectedModule.value?.name
  if (!moduleName) return
  await visual.patchProcess({ moduleName, ...payload })
  if (payload.action === 'rename' && payload.newName) {
    if (payload.kind === 'process') {
      selected.value = { kind: 'process', moduleName, processName: payload.newName }
    } else {
      selected.value = { kind: 'function', moduleName, functionName: payload.newName }
    }
  }
}

async function onPatchInvariant(payload: { index: number; text: string }): Promise<void> {
  if (writeDisabled.value || !selectedModule.value) return
  try {
    await visual.patchInvariant({
      action: 'patch',
      moduleName: selectedModule.value.name,
      index: payload.index,
      text: payload.text
    })
  } catch (e) {
    await modal.show({
      title: t('visual.inv.editTitle'),
      message: e instanceof Error ? e.message : String(e),
      buttons: [t('dialog.ok')]
    })
  }
}

async function onAddInvariant(text: string): Promise<void> {
  if (writeDisabled.value || !selectedModule.value) return
  try {
    await visual.patchInvariant({ action: 'add', moduleName: selectedModule.value.name, text })
  } catch (e) {
    await modal.show({
      title: t('visual.inv.createTitle'),
      message: e instanceof Error ? e.message : String(e),
      buttons: [t('dialog.ok')]
    })
  }
}

async function onRemoveInvariant(index: number): Promise<void> {
  if (parseBlocked.value || !selectedModule.value) return
  await visual.patchInvariant({
    action: 'remove',
    moduleName: selectedModule.value.name,
    index
  })
}

async function onReorderInvariants(fromIndex: number, toIndex: number): Promise<void> {
  if (parseBlocked.value || !selectedModule.value) return
  await visual.patchInvariant({
    action: 'reorder',
    moduleName: selectedModule.value.name,
    fromIndex,
    toIndex
  })
}

async function onRenameProcess(name?: string): Promise<void> {
  if (selected.value?.kind !== 'process') return
  let newName = name
  if (!newName) {
    const { index, value } = await modal.show({
      title: t('visual.renamePrompt'),
      input: true,
      inputValue: selected.value.processName,
      buttons: [t('dialog.ok'), t('dialog.cancel')]
    })
    if (index !== 0 || !value || value === selected.value.processName) return
    newName = value
  }
  await onPatchProcess({
    kind: 'process',
    action: 'rename',
    name: selected.value.processName,
    newName
  })
}

async function onRenameFunction(name?: string): Promise<void> {
  if (selected.value?.kind !== 'function') return
  let newName = name
  if (!newName) {
    const { index, value } = await modal.show({
      title: t('visual.renamePrompt'),
      input: true,
      inputValue: selected.value.functionName,
      buttons: [t('dialog.ok'), t('dialog.cancel')]
    })
    if (index !== 0 || !value || value === selected.value.functionName) return
    newName = value
  }
  await onPatchProcess({
    kind: 'function',
    action: 'rename',
    name: selected.value.functionName,
    newName
  })
}

async function onAddModule(): Promise<void> {
  if (writeDisabled.value || !selectedModule.value) return
  const parentName = selected.value?.kind === 'module' ? selectedModule.value.name : undefined
  const defaultModule = nextNumberedName(
    'Module',
    modules.value.map((m) => m.name)
  )
  const { index, value, checked } = await modal.show({
    title: t('visual.module.addTitle'),
    input: true,
    inputValue: defaultModule,
    inputPlaceholder: t('visual.module.namePlaceholder'),
    checkbox: true,
    checkboxLabel: t('visual.module.systemModule'),
    buttons: [t('dialog.ok'), t('dialog.cancel')]
  })
  if (index !== 0 || !value?.trim()) return
  await visual.patchModule({
    action: 'add',
    moduleName: value.trim(),
    parentName,
    isSystem: checked
  })
  await workspace.resyncModulesFromOpenTabs()
  selected.value = { kind: 'module', moduleName: value.trim() }
}

async function onRenameModuleInline(name: string): Promise<void> {
  if (writeDisabled.value || selected.value?.kind !== 'module') return
  const bare = name.replace(/^SYSTEM_/, '').trim()
  if (!bare || bare === selected.value.moduleName) return
  await visual.patchModule({
    action: 'rename',
    moduleName: selected.value.moduleName,
    newName: bare
  })
  await workspace.resyncModulesFromOpenTabs()
  selected.value = { kind: 'module', moduleName: bare }
}

function onPatchProcessInit(isInit: boolean): void {
  if (writeDisabled.value || selected.value?.kind !== 'process') return
  void visual.patchProcessInit({
    moduleName: selected.value.moduleName,
    processName: selected.value.processName,
    isInit,
    fallbackName: selected.value.processName === 'Init' ? 'P' : selected.value.processName
  })
  if (isInit) {
    selected.value = { ...selected.value, processName: 'Init' }
  }
}

async function onRenameModule(): Promise<void> {
  if (writeDisabled.value || selected.value?.kind !== 'module') return
  const { index, value } = await modal.show({
    title: t('visual.module.renameTitle'),
    input: true,
    inputValue: selected.value.moduleName,
    buttons: [t('dialog.ok'), t('dialog.cancel')]
  })
  if (index !== 0 || !value?.trim() || value.trim() === selected.value.moduleName) return
  await visual.patchModule({
    action: 'rename',
    moduleName: selected.value.moduleName,
    newName: value.trim()
  })
  await workspace.resyncModulesFromOpenTabs()
  selected.value = { kind: 'module', moduleName: value.trim() }
}

async function onRemoveModule(): Promise<void> {
  if (writeDisabled.value || selected.value?.kind !== 'module') return
  const { index } = await modal.show({
    title: t('visual.module.removeTitle'),
    message: t('visual.module.removeMessage', { name: selected.value.moduleName }),
    buttons: [t('dialog.delete'), t('dialog.cancel')]
  })
  if (index !== 0) return
  const moduleName = selected.value.moduleName
  await visual.patchModule({ action: 'remove', moduleName })
  await workspace.resyncModulesFromOpenTabs()
  const list = modules.value.filter((m) => m.name !== moduleName)
  selected.value = list[0] ? { kind: 'module', moduleName: list[0].name } : null
}

function onPatchExt(vars: import('../../../preload/index').ExtVarItem[]): void {
  if (writeDisabled.value || selected.value?.kind !== 'process') return
  void visual.patchExt({
    moduleName: selected.value.moduleName,
    processName: selected.value.processName,
    vars
  })
}

function onPatchProcessSignature(signature: string): void {
  if (writeDisabled.value || selected.value?.kind !== 'process') return
  void visual.patchProcessSignature({
    moduleName: selected.value.moduleName,
    processName: selected.value.processName,
    signature
  })
}

function onPatchFunctionSignature(signature: string): void {
  if (writeDisabled.value || selected.value?.kind !== 'function') return
  void visual.patchFunctionSignature({
    moduleName: selected.value.moduleName,
    functionName: selected.value.functionName,
    signature
  })
}

function onPatchAlias(target: string): void {
  if (writeDisabled.value || selected.value?.kind !== 'process') return
  void visual.patchAlias({
    moduleName: selected.value.moduleName,
    processName: selected.value.processName,
    aliasTarget: target
  })
}

function onAddDeclaration(kind: DeclarationKind): void {
  const mod = selectedModule.value
  if (!mod) return
  if (kind === 'const') {
    const name = nextConstName(mod.consts.map((c) => c.name))
    void onPatchDeclaration({ kind, action: 'add', text: constDeclText(name) })
    return
  }
  if (kind === 'type') {
    const name = nextTypeName(mod.types.map((t) => t.name))
    void onPatchDeclaration({
      kind,
      action: 'add',
      text: composedTypeText(name, [{ name: nextFieldName([]), type: 'nat' }])
    })
    return
  }
  const name = nextVarName(mod.vars.map((v) => v.name))
  void onPatchDeclaration({ kind, action: 'add', text: varDeclText(name, 'nat') })
}

async function onAddProcess(preset?: { name: string; isInit: boolean }): Promise<void> {
  if (writeDisabled.value || !selectedModule.value) return
  let processName: string
  let checked = false
  if (preset) {
    processName = preset.isInit ? 'Init' : preset.name
    checked = preset.isInit
  } else {
    const defaultName = nextProcessName(selectedModule.value.processes.map((p) => p.name))
    const { index, value, checked: isInit } = await modal.show({
      title: t('visual.process.addTitle'),
      input: true,
      inputValue: defaultName,
      inputPlaceholder: t('visual.process.namePlaceholder'),
      checkbox: true,
      checkboxLabel: t('visual.process.initProcess'),
      buttons: [t('dialog.ok'), t('dialog.cancel')]
    })
    if (index !== 0) return
    checked = Boolean(isInit)
    processName = checked ? 'Init' : (value?.trim() || defaultName)
  }
  const template = checked
    ? `process Init ()
    pre
        true
    post
        true
end_process`
    : undefined
  await onPatchProcess({ kind: 'process', action: 'add', name: processName, template })
  openProcessEditor(processName)
}

function onAddFunction(): void {
  const existing = selectedModule.value?.functions.map((f) => f.name) ?? []
  const name = nextNumberedName('fn', existing)
  void onPatchProcess({ kind: 'function', action: 'add', name })
}

function onAddScenario(): void {
  if (selected.value?.kind === 'process') openProcessEditor(selected.value.processName)
  else if (selected.value?.kind === 'function') openFunctionEditor(selected.value.functionName)
}

function openProcessEditor(name: string): void {
  const moduleName = selectedModule.value?.name
  if (!moduleName) return
  selected.value = { kind: 'process', moduleName, processName: name }
  editingProcessName.value = name
}

function closeProcessEditor(): void {
  editingProcessName.value = null
  const moduleName = selectedModule.value?.name
  if (moduleName) selected.value = { kind: 'module', moduleName }
}

function openFunctionEditor(name: string): void {
  const moduleName = selectedModule.value?.name
  if (!moduleName) return
  selected.value = { kind: 'function', moduleName, functionName: name }
  editingFunctionName.value = name
}

function closeFunctionEditor(): void {
  editingFunctionName.value = null
  const moduleName = selectedModule.value?.name
  if (moduleName) selected.value = { kind: 'module', moduleName }
}

async function onRemoveProcess(name: string): Promise<void> {
  if (writeDisabled.value) return
  const { index } = await modal.show({
    title: t('visual.process.removeTitle'),
    message: t('visual.process.removeMessage', { name }),
    buttons: [t('dialog.delete'), t('dialog.cancel')]
  })
  if (index !== 0) return
  await onPatchProcess({ kind: 'process', action: 'remove', name })
  closeProcessEditor()
}

async function onRemoveFunction(name: string): Promise<void> {
  if (writeDisabled.value) return
  const { index } = await modal.show({
    title: t('visual.function.removeTitle'),
    message: t('visual.function.removeMessage', { name }),
    buttons: [t('dialog.delete'), t('dialog.cancel')]
  })
  if (index !== 0) return
  await onPatchProcess({ kind: 'function', action: 'remove', name })
  closeFunctionEditor()
}

const dialogProcess = computed(() => {
  if (!editingProcessName.value || !selectedModule.value) return null
  return selectedModule.value.processes.find((p) => p.name === editingProcessName.value) ?? null
})

const dialogFunction = computed(() => {
  if (!editingFunctionName.value || !selectedModule.value) return null
  return selectedModule.value.functions.find((f) => f.name === editingFunctionName.value) ?? null
})

const dialogProcessFsf = computed(() => {
  const name = editingProcessName.value
  if (!name) return null
  return (visual.fsfModels.value as FsfModelDto[]).find((m) => m.processName === name && !m.functionName) ?? null
})

const dialogFunctionFsf = computed(() => {
  const name = editingFunctionName.value
  const moduleName = selectedModule.value?.name
  if (!name || !moduleName) return null
  return (visual.fsfModels.value as FsfModelDto[]).find(
    (m) => m.functionName === name && m.moduleName === moduleName
  ) ?? null
})

async function applyProcessDraft(draft: ProcessEditorDraft): Promise<void> {
  if (writeDisabled.value || !selectedModule.value || !editingProcessName.value) return
  const moduleName = selectedModule.value.name
  const currentName = editingProcessName.value
  const current = dialogProcess.value
  await visual.applySourcePatch(async (source) => {
    if (!window.studio) return source
    let s = source
    if (current && draft.isInit !== Boolean(current.isInit)) {
      s = await window.studio.patchProcessInit({
        source: s,
        moduleName,
        processName: currentName,
        isInit: draft.isInit,
        fallbackName: draft.name
      })
    }
    const afterInit = draft.isInit ? 'Init' : currentName
    if (!draft.isInit && draft.name !== afterInit) {
      s = await window.studio.patchProcess({
        source: s,
        moduleName,
        kind: 'process',
        action: 'rename',
        name: afterInit,
        newName: draft.name
      })
    }
    const name = draft.isInit ? 'Init' : draft.name
    s = await window.studio.patchProcessSignature({ source: s, moduleName, processName: name, signature: draft.signature })
    s = await window.studio.patchExt({ source: s, moduleName, processName: name, vars: draft.ext })
    s = await window.studio.patchDocument({ source: s, kind: 'pre', processName: name, text: draft.pre })
    s = await window.studio.patchDocument({ source: s, kind: 'post', processName: name, text: draft.post })
    s = await window.studio.patchDocument({ source: s, kind: 'decom', processName: name, text: draft.decom })
    s = await window.studio.patchDocument({ source: s, kind: 'comment', processName: name, text: draft.comment })
    if (draft.fsf) {
      s = await window.studio.patchDocument({
        source: s,
        kind: 'fsf',
        processName: name,
        scenarios: draft.fsf.scenarios,
        others: draft.fsf.others
      })
    }
    return s
  })
  closeProcessEditor()
}

function onNavRatioUpdate(r: number): void {
  editorUi.setVisualNavRatio(r)
}

function openContextMenu(payload: { x: number; y: number; selection: TreeSelection }): void {
  contextMenu.value = payload
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function onContextAction(type: VisualActionType, _declarationKind?: DeclarationKind): void {
  const sel = contextMenu.value?.selection ?? selected.value
  if (!sel) return
  switch (type) {
    case 'revealInCode':
      revealForSelection(sel)
      break
    case 'addProcess':
      onAddProcess()
      break
    case 'addFunction':
      onAddFunction()
      break
    case 'addDeclaration':
      onAddDeclaration('const')
      break
    case 'addScenario':
      onAddScenario()
      break
    case 'removeProcess':
      if (sel.kind === 'process') void onPatchProcess({ kind: 'process', action: 'remove', name: sel.processName })
      break
    case 'removeFunction':
      if (sel.kind === 'function') void onPatchProcess({ kind: 'function', action: 'remove', name: sel.functionName })
      break
    case 'editProcess':
      if (sel.kind === 'process') openProcessEditor(sel.processName)
      break
    case 'renameProcess':
      void onRenameProcess()
      break
    case 'renameFunction':
      void onRenameFunction()
      break
    case 'addModule':
      void onAddModule()
      break
    case 'renameModule':
      void onRenameModule()
      break
    case 'removeModule':
      void onRemoveModule()
      break
  }
}

function onGlobalClick(): void {
  closeContextMenu()
}

onMounted(() => document.addEventListener('click', onGlobalClick))
onUnmounted(() => document.removeEventListener('click', onGlobalClick))

function setSelection(sel: TreeSelection): void {
  selected.value = sel
}

defineExpose({ setSelection })
</script>

<template>
  <div class="visual-panel flex h-full min-h-0 w-full min-w-0 flex-col bg-surface-base">
    <ParseErrorBanner
      v-if="visual.parseFailed.value && doc.activeTab?.content?.trim()"
      :diagnostics="diagnostics"
      :message="t('visual.writeDisabledParseFailed')"
      @reveal-span="emit('revealSpan', $event)"
    />
    <ParseErrorBanner
      v-else-if="hybridHasBlockingLint && !visual.parseFailed.value"
      :diagnostics="lintDiagnostics"
      compact
      :message="t('visual.parseWarning')"
      @reveal-span="emit('revealSpan', $event)"
    />
    <div
      v-if="breadcrumb"
      class="truncate border-b border-border-subtle px-4 py-1.5 text-xs text-content-secondary"
      :title="breadcrumb"
    >
      {{ breadcrumb }}
    </div>
    <VisualToolbar
      :selection="selected"
      :parse-failed="visual.parseFailed.value"
      :has-diagnostics="hybridHasBlockingLint"
      :loading="visual.loading.value"
      :syncing="visual.syncing.value"
      :search-query="searchQuery"
      :hide-side-views="hideNavigator"
      @update:search-query="searchQuery = $event"
      @refresh="visual.rebuildNow()"
    />
    <div v-if="hideNavigator" class="studio-scroll min-h-0 flex-1 overflow-y-auto">
      <ModuleOverview
        v-if="selectedModule"
        :key="detailPanelKey"
        :module="selectedModule"
        :cdfd-graph="selectedCdfdGraph as never"
        :disabled="parseBlocked"
        :edit-disabled="editBlocked"
        @patch-declaration="onPatchDeclaration"
        @patch-gui-widget="onPatchGuiWidget"
        @patch-invariant="onPatchInvariant"
        @add-invariant="onAddInvariant"
        @remove-invariant="onRemoveInvariant"
        @reorder-invariants="onReorderInvariants"
        @select="selected = $event"
        @reveal-span="emit('revealSpan', $event)"
        @edit-process="openProcessEditor"
        @remove-process="onRemoveProcess"
        @edit-function="openFunctionEditor"
        @remove-function="onRemoveFunction"
        @add-process="onAddProcess"
        @cdfd-drill="onCdfdDrill"
        @select-cdfd-process="selected = selectedModule ? { kind: 'process', moduleName: selectedModule.name, processName: $event } : selected"
      />
      <div v-else class="flex h-full items-center justify-center p-8 text-sm text-content-secondary">
        {{ t('visual.selectHint') }}
      </div>
    </div>
    <ResizableSplit
      v-else
      class="min-h-0 min-w-0 w-full flex-1"
      :ratio="editorUi.visualNavRatio"
      @update:ratio="onNavRatioUpdate"
    >
      <template #left>
        <AtomicityTree
          v-if="editorUi.sideView === 'refine'"
          class="h-full min-h-0"
          :state="refinementState"
        />
        <ModuleTree
          v-else-if="editorUi.sideView === 'tree'"
          :modules="modules"
          :selected="selected"
          :search-query="searchQuery"
          :parse-failed="visual.parseFailed.value"
          :has-diagnostics="hybridHasBlockingLint"
          @select="selected = $event"
          @reveal-span="emit('revealSpan', $event)"
          @contextmenu="openContextMenu"
        />
        <ModuleGraphView
          v-else
          :graph="visual.moduleGraph.value as { nodes: []; edges: [] } | null"
          :selected="selected"
          :search-query="searchQuery"
          :node-hints="graphHints"
          :process-meta="graphProcessMeta"
          @select="selected = $event"
          @reveal-decom="revealDecomInSource($event.moduleName, $event.processName)"
          @contextmenu="openContextMenu"
        />
      </template>
      <template #right>
        <div class="studio-scroll h-full min-h-0 overflow-y-auto">
          <ModuleOverview
            v-if="selectedModule"
            :key="detailPanelKey"
            :module="selectedModule"
            :cdfd-graph="selectedCdfdGraph as never"
            :disabled="parseBlocked"
            :edit-disabled="editBlocked"
            @patch-declaration="onPatchDeclaration"
            @patch-gui-widget="onPatchGuiWidget"
            @patch-invariant="onPatchInvariant"
            @add-invariant="onAddInvariant"
            @remove-invariant="onRemoveInvariant"
            @reorder-invariants="onReorderInvariants"
            @select="selected = $event"
            @reveal-span="emit('revealSpan', $event)"
            @edit-process="openProcessEditor"
            @remove-process="onRemoveProcess"
            @edit-function="openFunctionEditor"
            @remove-function="onRemoveFunction"
            @add-process="onAddProcess"
            @cdfd-drill="onCdfdDrill"
            @select-cdfd-process="selected = selectedModule ? { kind: 'process', moduleName: selectedModule.name, processName: $event } : selected"
          />
          <div v-else class="flex h-full items-center justify-center p-8 text-sm text-content-secondary">
            {{ t('visual.selectHint') }}
          </div>
        </div>
      </template>
    </ResizableSplit>
    <ProcessEditDialog
      :open="Boolean(editingProcessName && dialogProcess)"
      :process="dialogProcess"
      :process-name="editingProcessName ?? ''"
      :module-name="selectedModule?.name ?? ''"
      :fsf-model="dialogProcessFsf"
      :symbols="symbolHints"
      :disabled="writeDisabled"
      :write-disabled-reason="writeDisabledReason"
      :block-informal="blockInformalPredicate"
      @close="closeProcessEditor"
      @apply="applyProcessDraft"
      @patch-alias="onPatchAlias"
    />
    <FunctionEditDialog
      :open="Boolean(editingFunctionName && dialogFunction)"
      :fn="dialogFunction"
      :module-name="selectedModule?.name ?? ''"
      :fsf-model="dialogFunctionFsf"
      :symbols="symbolHints"
      :disabled="writeDisabled"
      :write-disabled-reason="writeDisabledReason"
      :block-informal="blockInformalFunction"
      @close="closeFunctionEditor"
      @patch="onPatchFunction"
      @patch-signature="onPatchFunctionSignature"
      @rename="onRenameFunction"
      @reveal-span="emit('revealSpan', $event)"
    />
    <VisualContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :selection="contextMenu.selection"
      :parse-failed="visual.parseFailed.value"
      :has-diagnostics="hybridHasBlockingLint"
      @action="onContextAction"
      @close="closeContextMenu"
    />
  </div>
</template>
