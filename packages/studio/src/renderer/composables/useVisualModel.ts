import { ref, watch, computed, onUnmounted, type ComputedRef } from 'vue'
import type {
  PatchDeclarationPayload,
  PatchFunctionPayload,
  PatchProcessPayload,
  VisualModelPayload,
  DiagnosticSummary
} from '../../preload/index'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { HistoryKinds } from '../history/kinds'

export function useVisualModel(activeTabId: ComputedRef<string | undefined>) {
  const doc = useDocumentStore()
  const history = useHistoryStore()
  const model = ref<VisualModelPayload | null>(null)
  const parseFailed = ref(false)
  const hasDiagnostics = ref(false)
  const loading = ref(false)
  const syncing = ref(false)
  const modelGen = ref(0)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let visualPrimed = false
  let patchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPatch: {
    coalesceKey: string
    mutator: (source: string) => Promise<string>
  } | null = null
  let lastRebuiltContent: string | null = null
  let requestGen = 0

  const activeSource = computed(() => {
    const id = activeTabId.value
    const tab = id ? doc.tabs.find((t) => t.id === id) : doc.activeTab
    return tab?.kind === 'document' ? tab.content : ''
  })

  function boundTab() {
    const id = activeTabId.value
    if (id) return doc.tabs.find((t) => t.id === id && t.kind === 'document')
    return doc.activeTab?.kind === 'document' ? doc.activeTab : undefined
  }

  const moduleGraph = computed(() => model.value?.moduleGraph ?? null)
  const diagnostics = computed(
    () => (model.value?.diagnostics ?? []) as DiagnosticSummary[]
  )

  async function resetChannel(tabId: string): Promise<void> {
    if (window.studio?.resetVisualChannel) {
      await window.studio.resetVisualChannel(tabId)
    }
  }

  async function rebuild(source: string, tabId: string, resetIncremental = false): Promise<void> {
    if (!window.studio?.buildVisualModel) return
    if (resetIncremental) await resetChannel(tabId)
    const gen = ++requestGen
    loading.value = true
    try {
      const result = await window.studio.buildVisualModel(source, tabId)
      if (gen !== requestGen) return
      model.value = result
      parseFailed.value = result.parseFailed
      hasDiagnostics.value = result.hasDiagnostics ?? false
      lastRebuiltContent = source
      modelGen.value++
    } finally {
      if (gen === requestGen) loading.value = false
    }
  }

  async function rebuildNow(): Promise<void> {
    const tab = boundTab()
    if (!tab || tab.kind !== 'document') return
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    await rebuild(tab.content, tab.id, true)
  }

  function scheduleRebuild(): void {
    const tab = boundTab()
    if (!tab || tab.kind !== 'document') {
      model.value = null
      return
    }
    const source = tab.content
    if (source === lastRebuiltContent) return

    if (debounceTimer) clearTimeout(debounceTimer)
    const delay = visualPrimed ? 300 : 800
    visualPrimed = true
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const current = boundTab()
      if (!current || current.kind !== 'document') return
      if (current.content === lastRebuiltContent) return
      void rebuild(current.content, current.id, false)
    }, delay)
  }

  async function applySourcePatch(
    mutator: (source: string) => Promise<string>,
    options?: {
      coalesceKey?: string
      kind?: string
      labelParams?: Record<string, unknown>
      selectionAfter?: { moduleName?: string | null; informalNodeId?: string | null }
    }
  ): Promise<void> {
    const tab = boundTab()
    if (!tab || tab.kind !== 'document') return
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const next = await mutator(tab.content)
    if (next === tab.content) return
    history.applyDocument(tab.id, next, {
      kind: options?.kind ?? HistoryKinds.visualPatch,
      coalesceKey: options?.coalesceKey,
      immediate: true,
      labelParams: options?.labelParams,
      selectionAfter: options?.selectionAfter
    })
    await rebuild(next, tab.id, false)
  }

  async function flushScheduledPatch(): Promise<void> {
    const pending = pendingPatch
    pendingPatch = null
    if (patchDebounceTimer) {
      clearTimeout(patchDebounceTimer)
      patchDebounceTimer = null
    }
    if (!pending) return
    syncing.value = true
    try {
      await applySourcePatch(pending.mutator, { coalesceKey: pending.coalesceKey })
    } finally {
      syncing.value = false
    }
  }

  function scheduleVisualPatch(
    coalesceKey: string,
    mutator: (source: string) => Promise<string>,
    debounceMs = 400
  ): void {
    pendingPatch = { coalesceKey, mutator }
    if (patchDebounceTimer) clearTimeout(patchDebounceTimer)
    patchDebounceTimer = setTimeout(() => {
      patchDebounceTimer = null
      void flushScheduledPatch()
    }, debounceMs)
  }

  async function patchDeclaration(payload: Omit<PatchDeclarationPayload, 'source'>): Promise<void> {
    if (payload.action === 'patch' && payload.name) {
      scheduleVisualPatch(
        `decl:${payload.moduleName}:${payload.kind}:${payload.name}`,
        async (source) => {
          if (!window.studio?.patchDeclaration) return source
          return window.studio.patchDeclaration({ ...payload, source })
        }
      )
      return
    }
    await applySourcePatch(async (source) => {
      if (!window.studio?.patchDeclaration) return source
      return window.studio.patchDeclaration({ ...payload, source })
    })
  }

  async function patchGuiWidget(payload: Omit<import('../../preload/index').PatchGuiWidgetPayload, 'source'>): Promise<void> {
    scheduleVisualPatch(
      `gui:${payload.moduleName}:${payload.screenName}:${payload.widgetName}`,
      async (source) => {
        if (!window.studio?.patchGuiWidget) return source
        return window.studio.patchGuiWidget({ ...payload, source })
      }
    )
  }

  async function patchProcess(payload: Omit<PatchProcessPayload, 'source'>): Promise<void> {
    await applySourcePatch(async (source) => {
      if (!window.studio?.patchProcess) return source
      return window.studio.patchProcess({ ...payload, source })
    })
  }

  async function patchFunction(payload: Omit<PatchFunctionPayload, 'source'>): Promise<void> {
    scheduleVisualPatch(`fn:${payload.moduleName}:${payload.name}`, async (source) => {
      if (!window.studio?.patchFunction) return source
      return window.studio.patchFunction({ ...payload, source })
    })
  }

  async function patchInvariant(payload: {
    span?: { start: number; end: number }
    index?: number
    text?: string
    action?: 'patch' | 'add' | 'remove' | 'reorder'
    moduleName?: string
    fromIndex?: number
    toIndex?: number
  }): Promise<void> {
    const action = payload.action ?? 'patch'
    const key =
      action === 'reorder'
        ? `inv:reorder:${payload.moduleName}`
        : action === 'add'
          ? `inv:add:${payload.moduleName}`
          : action === 'patch' && payload.index != null
            ? `inv:patch:${payload.moduleName}:${payload.index}`
            : `inv:${payload.span?.start ?? 'x'}`
    const run = async (source: string) => {
      if (!window.studio?.patchInvariant) return source
      return window.studio.patchInvariant({ ...payload, source })
    }
    if (action === 'patch') {
      scheduleVisualPatch(key, run)
      return
    }
    await applySourcePatch(run)
  }

  async function patchExt(payload: {
    moduleName: string
    processName: string
    vars: Array<{ access: 'rd' | 'wr'; name: string; type?: string }>
  }): Promise<void> {
    scheduleVisualPatch(`ext:${payload.moduleName}:${payload.processName}`, async (source) => {
      if (!window.studio?.patchExt) return source
      return window.studio.patchExt({ ...payload, source })
    })
  }

  async function patchProcessSignature(payload: {
    moduleName: string
    processName: string
    signature: string
  }): Promise<void> {
    scheduleVisualPatch(`sig:proc:${payload.processName}`, async (source) => {
      if (!window.studio?.patchProcessSignature) return source
      return window.studio.patchProcessSignature({ ...payload, source })
    })
  }

  async function patchFunctionSignature(payload: {
    moduleName: string
    functionName: string
    signature: string
  }): Promise<void> {
    scheduleVisualPatch(`sig:fn:${payload.functionName}`, async (source) => {
      if (!window.studio?.patchFunctionSignature) return source
      return window.studio.patchFunctionSignature({ ...payload, source })
    })
  }

  async function patchAlias(payload: {
    moduleName: string
    processName: string
    aliasTarget: string
  }): Promise<void> {
    scheduleVisualPatch(`alias:${payload.processName}`, async (source) => {
      if (!window.studio?.patchAlias) return source
      return window.studio.patchAlias({ ...payload, source })
    })
  }

  async function patchProcessInit(payload: {
    moduleName: string
    processName: string
    isInit: boolean
    fallbackName?: string
  }): Promise<void> {
    await applySourcePatch(async (source) => {
      if (!window.studio?.patchProcessInit) return source
      return window.studio.patchProcessInit({ ...payload, source })
    })
  }

  async function patchModule(payload: {
    action: 'add' | 'remove' | 'rename'
    moduleName: string
    newName?: string
    parentName?: string
    isSystem?: boolean
  }): Promise<void> {
    const kind =
      payload.action === 'remove'
        ? HistoryKinds.moduleDelete
        : payload.action === 'rename'
          ? HistoryKinds.moduleRename
          : HistoryKinds.moduleAdd
    const selectionAfter = {
      moduleName:
        payload.action === 'rename'
          ? (payload.newName ?? payload.moduleName)
          : payload.action === 'add'
            ? payload.moduleName
            : null
    }
    await applySourcePatch(
      async (source) => {
        if (!window.studio?.patchModule) return source
        return window.studio.patchModule({ ...payload, source })
      },
      {
        kind,
        labelParams: { name: payload.moduleName, newName: payload.newName ?? payload.moduleName },
        selectionAfter
      }
    )
  }

  watch(activeSource, () => scheduleRebuild(), { immediate: true })

  watch(parseFailed, (failed, wasFailed) => {
    if (wasFailed && !failed) void rebuildNow()
  })

  watch(activeTabId, (id, prev) => {
    if (prev && window.studio?.resetVisualChannel) void window.studio.resetVisualChannel(prev)
    lastRebuiltContent = null
    scheduleRebuild()
  })

  const unregisterFlusher = history.registerFlusher(() => flushScheduledPatch())

  onUnmounted(() => {
    unregisterFlusher()
    if (debounceTimer) clearTimeout(debounceTimer)
    if (patchDebounceTimer) clearTimeout(patchDebounceTimer)
    void flushScheduledPatch()
    const id = activeTabId.value
    if (id && window.studio?.resetVisualChannel) void window.studio.resetVisualChannel(id)
  })

  return {
    model,
    parseFailed,
    hasDiagnostics,
    loading,
    syncing,
    modelGen,
    moduleGraph,
    cdfdGraphs: computed(() => model.value?.cdfdGraphs ?? []),
    diagnostics,
    applySourcePatch,
    scheduleVisualPatch,
    patchDeclaration,
    patchGuiWidget,
    patchProcess,
    patchFunction,
    patchInvariant,
    patchExt,
    patchProcessSignature,
    patchFunctionSignature,
    patchAlias,
    patchProcessInit,
    patchModule,
    rebuildNow,
    fsfModels: computed(() => model.value?.fsfModels ?? [])
  }
}

export type TreeSelection =
  | { kind: 'module'; moduleName: string }
  | { kind: 'process'; moduleName: string; processName: string }
  | { kind: 'function'; moduleName: string; functionName: string }
  | null
