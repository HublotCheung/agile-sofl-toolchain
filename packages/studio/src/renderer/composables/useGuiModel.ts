import { ref, watch, computed, type Ref } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { useWorkspaceStore } from '../stores/workspace'
import { HistoryKinds } from '../history/kinds'
import type { GuiWidgetKind, PatchGuiPayload } from '../preload/index'

const DEBOUNCE_MS = 300

export function useGuiModel(
  activeTabId: Ref<string | undefined>,
  options?: {
    embeddedInAspec?: Ref<boolean>
    informalTabId?: Ref<string | undefined>
    informalMeta?: Ref<{ guiTarget?: string } | undefined>
  }
) {
  const doc = useDocumentStore()
  const history = useHistoryStore()
  const workspace = useWorkspaceStore()
  const model = ref<Awaited<ReturnType<NonNullable<typeof window.studio>['buildGuiModel']>> | null>(null)
  const loading = ref(false)
  const lastRebuiltContent = ref('')
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let guiPrimed = false

  const embedded = computed(() => options?.embeddedInAspec?.value ?? false)

  const activeTab = computed(() => {
    const id = activeTabId.value
    if (!id) return undefined
    const tab = doc.tabs.find((t) => t.id === id && t.kind === 'document')
    if (!tab) return undefined
    if (embedded.value) return tab.documentKind === 'aspec' ? tab : undefined
    return tab.documentKind === 'guispec' ? tab : undefined
  })

  const informalTab = computed(() => {
    const id = options?.informalTabId?.value ?? (embedded.value ? activeTabId.value : undefined)
    if (!id) return undefined
    return doc.tabs.find((t) => t.id === id && t.documentKind === 'aspec')
  })

  const hasErrors = computed(() =>
    (model.value?.diagnostics ?? []).some((d) => d.severity === 'error')
  )

  async function rebuildNow(): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio) return
    loading.value = true
    try {
      if (embedded.value && window.studio.resolveGuiForAspec) {
        let externalGui: string | undefined
        const guiTarget = options?.informalMeta?.value?.guiTarget
        if (tab.filePath && guiTarget && window.studio.fileRead) {
          try {
            const base = tab.filePath.replace(/[/\\][^/\\]+$/, '')
            const target = guiTarget.replace(/^\.\//, '')
            const file = await window.studio.fileRead(`${base}/${target}`.replace(/\\/g, '/'))
            externalGui = file.content
          } catch {
            externalGui = undefined
          }
        }
        model.value = await window.studio.resolveGuiForAspec({
          aspecSource: tab.content,
          externalGuiSource: externalGui
        })
      } else if (window.studio.buildGuiModel) {
        model.value = await window.studio.buildGuiModel({
          source: tab.content,
          informalSource: informalTab.value?.content,
          hybridSource: workspace.hybridTab?.content
        })
      }
      lastRebuiltContent.value = tab.content
    } finally {
      loading.value = false
    }
  }

  function scheduleRebuild(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    const delay = guiPrimed ? DEBOUNCE_MS : 1100
    guiPrimed = true
    debounceTimer = setTimeout(() => void rebuildNow(), delay)
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

  watch(activeTabId, (_id, prev) => {
    if (prev == null) return
    void rebuildNow()
  })

  function applySourcePatch(next: string): void {
    const tab = activeTab.value
    if (!tab || next === tab.content) return
    history.applyDocument(tab.id, next, {
      kind: HistoryKinds.guiEdit,
      immediate: true
    })
    lastRebuiltContent.value = next
    void rebuildNow()
  }

  async function patchViaIpc(payload: PatchGuiPayload): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio) return
    let next: string
    if (embedded.value && window.studio.patchAspecGui) {
      next = await window.studio.patchAspecGui({ aspecSource: tab.content, action: payload })
    } else if (window.studio.patchGui) {
      next = await window.studio.patchGui({ source: tab.content, ...payload })
    } else {
      return
    }
    applySourcePatch(next)
  }

  async function patchById(idPath: string, value: unknown): Promise<void> {
    if (hasErrors.value) return
    await patchViaIpc({ action: 'patch-by-id', idPath, value })
  }

  async function formatYaml(): Promise<void> {
    const tab = activeTab.value
    if (!tab || !window.studio?.formatGui || embedded.value) return
    const next = await window.studio.formatGui(tab.content)
    applySourcePatch(next)
  }

  async function addScreen(screen: {
    id: string
    name: string
    title?: string
    widgets?: unknown[]
    size?: { width: number; height: number }
  }): Promise<void> {
    await patchViaIpc({ action: 'add-screen', screen: screen as never })
  }

  async function removeScreen(screenId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-screen', screenId })
  }

  async function addWidget(
    screenId: string,
    widget: { id: string; kind: GuiWidgetKind; label?: string; bounds?: { x: number; y: number; width: number; height: number }; events?: Array<{ on: string; action: string; targetView?: string }> }
  ): Promise<void> {
    await patchViaIpc({ action: 'add-widget', screenId, widget })
  }

  async function removeWidget(widgetId: string): Promise<void> {
    await patchViaIpc({ action: 'remove-widget', widgetId })
  }

  async function insertHtml(parentPath: string, html: string): Promise<void> {
    await patchViaIpc({ action: 'insert-html', parentPath, html })
  }

  async function patchNode(
    path: string,
    attrs?: Record<string, string | null>,
    text?: string
  ): Promise<void> {
    await patchViaIpc({ action: 'patch-node', path, attrs, text })
  }

  async function removeNode(path: string): Promise<void> {
    await patchViaIpc({ action: 'remove-node', path })
  }

  async function replaceScreenHtml(screenId: string, html: string): Promise<void> {
    await patchViaIpc({ action: 'replace-screen-html', screenId, html })
  }

  async function addFlow(flow: { from: string; to: string; on?: string }): Promise<void> {
    await patchViaIpc({ action: 'add-flow', flow })
  }

  return {
    model,
    loading,
    hasErrors,
    embedded,
    rebuildNow,
    patchById,
    formatYaml,
    addScreen,
    removeScreen,
    addWidget,
    removeWidget,
    insertHtml,
    patchNode,
    removeNode,
    replaceScreenHtml,
    addFlow
  }
}
