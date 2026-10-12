import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createDocumentTab,
  createHomeTab,
  fileBelongsToRoot,
  filePathsEqual,
  HOME_TAB_ID,
  pathToFileUri,
  inferDocumentKind,
  type EditorTab
} from './tabUtils'
import { useRecentFilesStore } from './recentFiles'
import { persistWorkspace, restoreWorkspace } from './workspaceSession'

const SESSION_PERSIST_MS = 1200

export const useDocumentStore = defineStore('document', () => {
  const tabs = ref<EditorTab[]>([createHomeTab()])
  const activeTabId = ref<string>(HOME_TAB_ID)
  /** Per-tab text generation. Listeners compare a number instead of copying the source. */
  const contentEpochByTab = ref<Record<string, number>>({})
  const contentBuffers = new Set<() => void>()
  const pendingEditIds = new Set<string>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const homeTab = computed(() => tabs.value.find((t) => t.kind === 'home') ?? null)
  const documentTabs = computed(() => tabs.value.filter((t) => t.kind === 'document'))
  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)
  const hasDirtyTabs = computed(() => documentTabs.value.some((t) => t.isDirty))
  const isHomeActive = computed(() => activeTabId.value === HOME_TAB_ID)
  const showWelcomeFallback = computed(
    () => documentTabs.value.length === 0 && activeTabId.value !== HOME_TAB_ID
  )

  function ensureHomeTab(): void {
    if (!tabs.value.some((t) => t.id === HOME_TAB_ID)) {
      tabs.value.unshift(createHomeTab())
    }
  }

  function initHome(): void {
    ensureHomeTab()
    activeTabId.value = HOME_TAB_ID
  }

  function restoreFromSession(): boolean {
    const restored = restoreWorkspace()
    if (!restored) return false
    tabs.value = restored.tabs
    activeTabId.value = restored.activeTabId
    ensureHomeTab()
    return true
  }

  function cancelScheduledPersist(): void {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
  }

  function persistNow(): void {
    cancelScheduledPersist()
    persistWorkspace(activeTabId.value, tabs.value)
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (pendingEditIds.size > 0) {
        schedulePersist()
        return
      }
      persistWorkspace(activeTabId.value, tabs.value)
    }, SESSION_PERSIST_MS)
  }

  function registerContentBuffer(fn: () => void): () => void {
    contentBuffers.add(fn)
    return () => {
      contentBuffers.delete(fn)
    }
  }

  function flushContentBuffers(): void {
    for (const fn of [...contentBuffers]) fn()
  }

  function beginPendingEdit(id: string): void {
    pendingEditIds.add(id)
  }

  function endPendingEdit(id: string): void {
    pendingEditIds.delete(id)
  }

  function hasPendingEdit(id?: string): boolean {
    if (id) return pendingEditIds.has(id)
    return pendingEditIds.size > 0
  }

  function bumpContentEpoch(id: string): void {
    contentEpochByTab.value = {
      ...contentEpochByTab.value,
      [id]: (contentEpochByTab.value[id] ?? 0) + 1
    }
  }

  function saveSession(): void {
    flushContentBuffers()
    persistNow()
  }

  function setActive(id: string): void {
    if (tabs.value.some((t) => t.id === id)) activeTabId.value = id
  }

  function goHome(): void {
    ensureHomeTab()
    activeTabId.value = HOME_TAB_ID
  }

  function newTab(options?: { content?: string; title?: string; documentKind?: import('./tabUtils').DocumentKind }): EditorTab {
    const tab = createDocumentTab({
      content: options?.content,
      title: options?.title,
      documentKind: options?.documentKind
    })
    tabs.value.push(tab)
    activeTabId.value = tab.id
    persistNow()
    return tab
  }

  function markDirty(id: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab || tab.kind !== 'document' || tab.isDirty) return
    tab.isDirty = true
  }

  function setContent(id: string, content: string, dirty = true): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab || tab.kind !== 'document') return
    const contentChanged = tab.content !== content
    const dirtyChanged = tab.isDirty !== dirty
    if (!contentChanged && !dirtyChanged) return
    if (contentChanged) tab.content = content
    if (dirtyChanged) tab.isDirty = dirty
    if (contentChanged) bumpContentEpoch(tab.id)
    schedulePersist()
  }

  function openFromFile(filePath: string, content: string, title: string): EditorTab {
    const recent = useRecentFilesStore()
    recent.add(filePath, title)

    const existing = documentTabs.value.find(
      (t) => t.filePath && filePathsEqual(t.filePath, filePath)
    )
    if (existing) {
      activeTabId.value = existing.id
      if (!existing.isDirty) {
        const contentChanged = existing.content !== content
        existing.content = content
        existing.title = title
        existing.uri = pathToFileUri(filePath)
        if (contentChanged) bumpContentEpoch(existing.id)
        persistNow()
      }
      return existing
    }
    const tab = createDocumentTab({ filePath, content, title, isDirty: false, documentKind: inferDocumentKind(filePath) })
    tabs.value.push(tab)
    activeTabId.value = tab.id
    bumpContentEpoch(tab.id)
    persistNow()
    return tab
  }

  function updateContent(id: string, content: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab || tab.kind !== 'document') return
    if (tab.content === content && tab.isDirty) return
    const contentChanged = tab.content !== content
    tab.content = content
    tab.isDirty = true
    if (contentChanged) bumpContentEpoch(tab.id)
    schedulePersist()
  }

  function markSaved(id: string, filePath: string, title: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab || tab.kind !== 'document') return
    tab.filePath = filePath
    tab.title = title
    tab.isDirty = false
    tab.uri = pathToFileUri(filePath)
    useRecentFilesStore().add(filePath, title)
    persistNow()
  }

  function removeTab(id: string): void {
    if (id === HOME_TAB_ID) return
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    tabs.value.splice(idx, 1)
    pendingEditIds.delete(id)

    if (activeTabId.value === id) {
      const remainingDocs = documentTabs.value
      if (remainingDocs.length > 0) {
        activeTabId.value = remainingDocs[Math.min(idx - 1, remainingDocs.length - 1)]?.id ?? remainingDocs[0].id
      } else {
        activeTabId.value = HOME_TAB_ID
      }
    }
    ensureHomeTab()
    persistNow()
  }

  function closeTabsOutsideRoot(rootPath: string): void {
    const ids = documentTabs.value
      .filter((tab) => !tab.filePath || !fileBelongsToRoot(tab.filePath, rootPath))
      .map((tab) => tab.id)
    for (const id of ids) removeTab(id)
  }

  function linkTabs(aspecTabId: string, asflTabId: string): void {
    const aspec = tabs.value.find((t) => t.id === aspecTabId)
    const asfl = tabs.value.find((t) => t.id === asflTabId)
    if (aspec) aspec.linkedDocumentId = asflTabId
    if (asfl) asfl.linkedDocumentId = aspecTabId
    persistNow()
  }

  return {
    tabs,
    activeTabId,
    contentEpochByTab,
    homeTab,
    documentTabs,
    activeTab,
    hasDirtyTabs,
    isHomeActive,
    showWelcomeFallback,
    initHome,
    restoreFromSession,
    saveSession,
    setActive,
    goHome,
    newTab,
    markDirty,
    beginPendingEdit,
    endPendingEdit,
    hasPendingEdit,
    registerContentBuffer,
    flushContentBuffers,
    setContent,
    openFromFile,
    updateContent,
    markSaved,
    removeTab,
    closeTabsOutsideRoot,
    linkTabs
  }
})
