import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  HybridAgentBootstrapPayload,
  IndexedProject,
  ProjectModuleInfo,
  ProjectUiState,
  WorkspaceScanPayload
} from '../../preload/index'
import { useDocumentStore } from './document'
import { dirtyModuleNames } from '../lib/moduleDirty'
import type { TreeSelection } from '../composables/useVisualModel'
import { fileBelongsToRoot, filePathsEqual } from './tabUtils'
import { type EditorDocumentKind } from '../../shared/textSearch'
import { refreshGitFor } from '../composables/useGitStatus'
import { consumeAgentLaunchPending, emitAgentLaunch } from '../lib/agentLaunchBus'
import { useModalStore } from './modal'
import { useHistoryStore } from './history'
import { i18n } from '../i18n'
import type { SpecMapKind } from '@agile-sofl/editor-api'

const DEFAULT_COLUMN_WIDTHS = [0.18, 0.6, 0.22]

export type WorkspacePanelId = 'tree' | 'informal' | 'agent' | 'hybrid' | 'gui' | 'structure'
export type StructureMode = 'tree' | SpecMapKind

export type EditorRevealRequest = {
  filePath: string
  kind: EditorDocumentKind
  start: number
  end: number
  line: number
  column: number
  text: string
}

function readStoredView<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  const raw = localStorage.getItem(key)
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const doc = useDocumentStore()
  const projects = ref<IndexedProject[]>([])
  const activeProjectId = ref<string | null>(null)
  const scan = ref<WorkspaceScanPayload | null>(null)
  const selectedModuleName = ref<string | null>(null)
  const selection = ref<TreeSelection>(null)
  const informalCollapsed = ref(false)
  const structureCollapsed = ref(false)
  const columnWidths = ref<number[]>([...DEFAULT_COLUMN_WIDTHS])
  const expandedProjectIds = ref<string[]>([])
  const hybridMode = ref<'code' | 'visual' | 'refine'>(
    readStoredView('studio-default-hybrid-view', ['code', 'visual', 'refine'] as const, 'visual')
  )
  const guiMode = ref<'visual' | 'code'>('visual')
  const structureMode = ref<StructureMode>('tree')
  const guiRevealScreenId = ref<string | null>(null)
  const guiRevealNonce = ref(0)
  const informalViewMode = ref<'document' | 'graphical'>(
    readStoredView('studio-default-informal-view', ['document', 'graphical'] as const, 'document')
  )
  const informalSelectedNodeId = ref<string | null>(null)
  const agentSplitRatio = ref(0.58)
  const structureSplitRatio = ref(0.5)
  const informalRevealNonce = ref(0)
  const hybridRevealNonce = ref(0)
  const editorRevealNonce = ref(0)
  const editorReveal = ref<EditorRevealRequest | null>(null)
  const informalGraphBodyVisible = ref(true)
  const savedModuleHashes = ref<Record<string, Record<string, string>>>({})
  const currentModuleHashes = ref<Record<string, Record<string, string>>>({})
  const loading = ref(false)
  const cachedModulesByProject = ref<Record<string, ProjectModuleInfo[]>>({})
  const focusedPanel = ref<WorkspacePanelId | null>(null)
  const fullscreenPanel = ref<WorkspacePanelId | null>(null)
  const agentBusy = ref(false)
  const agentBusySources = ref<Record<string, boolean>>({})
  const agentAbortFns = new Map<string, () => Promise<void>>()

  const activeProject = computed(
    () => projects.value.find((p) => p.id === activeProjectId.value) ?? null
  )
  const modules = computed(() => {
    const root = activeProject.value?.rootPath
    const list = scan.value?.modules ?? []
    if (!root) return list
    return list.filter((m) => fileBelongsToRoot(m.filePath, root))
  })
  const selectedModule = computed(
    () => modules.value.find((m) => m.name === selectedModuleName.value) ?? null
  )
  const isGuiModuleSelected = computed(() => Boolean(selectedModule.value?.isGui))
  const hasWorkspace = computed(() => Boolean(activeProjectId.value && scan.value))

  function tabForProjectFile(path: string | undefined) {
    if (!path) return undefined
    const root = activeProject.value?.rootPath
    if (root && !fileBelongsToRoot(path, root)) return undefined
    return doc.documentTabs.find((t) => t.filePath && filePathsEqual(t.filePath, path))
  }

  const informalTab = computed(() => {
    const path = scan.value?.files.find((f) => f.kind === 'aspec')?.path
    return tabForProjectFile(path)
  })

  const hybridTab = computed(() => {
    const root = activeProject.value?.rootPath
    const fromModule = selectedModule.value?.filePath
    const fromScan = scan.value?.files.find((f) => f.kind === 'asfl')?.path
    const path =
      fromModule && root && fileBelongsToRoot(fromModule, root) ? fromModule : fromScan
    return tabForProjectFile(path)
  })

  const guiTab = computed(() => {
    const path = scan.value?.files.find((f) => f.kind === 'guispec')?.path
    return tabForProjectFile(path)
  })

  const dirtyNames = computed(() =>
    dirtyModuleNames(modules.value, savedModuleHashes.value, currentModuleHashes.value)
  )

  function isModuleDirty(name: string): boolean {
    return dirtyNames.value.includes(name)
  }

  function isInformalDirty(): boolean {
    return Boolean(informalTab.value?.isDirty)
  }

  function isHybridDirty(): boolean {
    return Boolean(hybridTab.value?.isDirty)
  }

  function isGuiDirty(): boolean {
    return Boolean(guiTab.value?.isDirty)
  }

  function tabForFocusedPanel() {
    switch (focusedPanel.value) {
      case 'informal':
      case 'agent':
        return informalTab.value
      case 'hybrid':
        return hybridTab.value
      case 'gui':
        return guiTab.value
      default:
        return undefined
    }
  }

  function setFocusedPanel(panel: WorkspacePanelId): void {
    focusedPanel.value = panel
    const tab = tabForFocusedPanel()
    if (tab) doc.setActive(tab.id)
  }

  function setFullscreenPanel(panel: WorkspacePanelId | null): void {
    fullscreenPanel.value = panel
    if (panel) setFocusedPanel(panel)
  }

  function toggleFullscreenPanel(panel: WorkspacePanelId): void {
    setFullscreenPanel(fullscreenPanel.value === panel ? null : panel)
  }

  async function refreshProjects(): Promise<void> {
    if (!window.studio?.projectList) return
    projects.value = await window.studio.projectList()
  }

  function tKey(key: string, params?: Record<string, unknown>): string {
    return (i18n.global.t as (k: string, p?: Record<string, unknown>) => string)(key, params)
  }

  function modulesInActiveProject(list: ProjectModuleInfo[]): ProjectModuleInfo[] {
    const root = activeProject.value?.rootPath
    if (!root) return []
    return list.filter((m) => fileBelongsToRoot(m.filePath, root))
  }

  function modulesFor(projectId: string): ProjectModuleInfo[] {
    if (projectId !== activeProjectId.value) return []
    return modules.value
  }

  function setAgentBusy(source: string, busy: boolean): void {
    agentBusySources.value = { ...agentBusySources.value, [source]: busy }
    agentBusy.value = Object.values(agentBusySources.value).some(Boolean)
  }

  function registerAgentAbort(source: string, fn: (() => Promise<void>) | null): void {
    if (fn) agentAbortFns.set(source, fn)
    else agentAbortFns.delete(source)
  }

  async function abortRunningAgent(): Promise<void> {
    const fns = [...agentAbortFns.values()]
    await Promise.all(fns.map((fn) => fn()))
    const started = Date.now()
    while (agentBusy.value && Date.now() - started < 4000) {
      await new Promise((r) => setTimeout(r, 40))
    }
    agentBusy.value = false
    agentBusySources.value = {}
  }

  async function persistDirtyDocuments(): Promise<boolean> {
    await useHistoryStore().flushRegistered()
    for (const tab of doc.documentTabs.filter((t) => t.isDirty)) {
      let path = tab.filePath
      const ext =
        tab.documentKind === 'aspec' ? 'aspec' : tab.documentKind === 'guispec' ? 'guispec' : 'asfl'
      if (!path) {
        path = await window.studio?.fileSaveDialog?.(`${tab.title}.${ext}`, tab.documentKind)
        if (!path) return false
      }
      await window.studio!.fileWrite(path, tab.content)
      doc.markSaved(tab.id, path, path.split(/[/\\]/).pop() ?? tab.title)
      if (tab.documentKind === 'asfl') await markHybridSaved(path)
    }
    const root = activeProject.value?.rootPath
    if (root) void refreshGitFor(root)
    return true
  }

  async function confirmLeaveActiveProject(
    unsavedMessageKey:
      | 'workspace.switch.unsavedMessage'
      | 'dialog.unsaved.projectQuitMessage' = 'workspace.switch.unsavedMessage'
  ): Promise<boolean> {
    if (!activeProjectId.value) return true
    const modal = useModalStore()
    if (agentBusy.value) {
      const abortMessageKey =
        unsavedMessageKey === 'dialog.unsaved.projectQuitMessage'
          ? 'workspace.quit.abortAgentMessage'
          : 'workspace.switch.abortAgentMessage'
      const abortButtonKey =
        unsavedMessageKey === 'dialog.unsaved.projectQuitMessage'
          ? 'workspace.quit.abortAndQuit'
          : 'workspace.switch.abortAndSwitch'
      const { index } = await modal.show({
        title: tKey('workspace.switch.abortAgentTitle'),
        message: tKey(abortMessageKey, {
          name: activeProject.value?.name ?? ''
        }),
        buttons: [tKey(abortButtonKey), tKey('workspace.cancel')],
        buttonVariants: ['warning', 'default']
      })
      if (index !== 0) return false
      await abortRunningAgent()
    }
    const dirty = doc.documentTabs.filter((t) => t.isDirty)
    if (!dirty.length) return true
    const { index } = await modal.show({
      title: tKey('dialog.unsaved.title'),
      message: tKey(unsavedMessageKey, {
        name: activeProject.value?.name ?? ''
      }),
      buttons: [tKey('dialog.unsaved.save'), tKey('dialog.unsaved.dontSave'), tKey('workspace.cancel')]
    })
    if (index === 0) return persistDirtyDocuments()
    if (index === 1) return true
    return false
  }

  async function persistUi(): Promise<void> {
    const id = activeProjectId.value
    if (!id || !window.studio?.projectSaveUiState) return
    const state: ProjectUiState = {
      informalCollapsed: Boolean(informalCollapsed.value),
      structureCollapsed: Boolean(structureCollapsed.value),
      columnWidths: [...columnWidths.value],
      selectedModuleName:
        typeof selectedModuleName.value === 'string' ? selectedModuleName.value : null,
      expanded: expandedProjectIds.value.includes(id),
    }
    const payload = JSON.parse(JSON.stringify(state)) as ProjectUiState
    try {
      await window.studio.projectSaveUiState(String(id), payload)
    } catch (err) {
      console.warn('[studio] failed to persist project UI state:', err)
    }
  }

  async function refreshHashes(): Promise<void> {
    if (typeof window === 'undefined' || !window.studio?.moduleHashes) return
    const next: Record<string, Record<string, string>> = {}
    for (const file of scan.value?.files.filter((f) => f.kind === 'asfl') ?? []) {
      const tab = doc.documentTabs.find((t) => t.filePath && filePathsEqual(t.filePath, file.path))
      if (!tab) continue
      next[file.path] = await window.studio.moduleHashes(tab.content)
    }
    currentModuleHashes.value = next
  }

  async function loadProjectFiles(payload: WorkspaceScanPayload): Promise<void> {
    for (const file of payload.files) {
      if (file.kind === 'manifest') continue
      const result = await window.studio!.fileRead(file.path)
      doc.openFromFile(result.filePath, result.content, result.title)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const saved: Record<string, Record<string, string>> = {}
    for (const file of payload.files.filter((f) => f.kind === 'asfl')) {
      const tab = doc.documentTabs.find((t) => t.filePath && filePathsEqual(t.filePath, file.path))
      if (!tab || !window.studio?.moduleHashes) continue
      saved[file.path] = await window.studio.moduleHashes(tab.content)
    }
    savedModuleHashes.value = saved
    currentModuleHashes.value = { ...saved }
  }

  async function activateProject(
    project: IndexedProject,
    options?: { skipConfirm?: boolean }
  ): Promise<boolean> {
    if (!window.studio?.workspaceScan) {
      void refreshGitFor(project.rootPath)
      return true
    }
    const prevId = activeProjectId.value
    if (prevId === project.id && scan.value) {
      loading.value = true
      try {
        const payload = await window.studio.workspaceScan(project.rootPath)
        scan.value = payload
        await window.studio.projectCacheModules?.(project.id, payload.modules)
        cachedModulesByProject.value = { ...cachedModulesByProject.value, [project.id]: payload.modules }
        await loadProjectFiles(payload)
        const preferred = selectedModuleName.value
        const nextModule =
          payload.modules.find((m) => m.name === preferred)?.name ?? payload.modules[0]?.name ?? null
        selectModule(nextModule)
      } finally {
        loading.value = false
        void refreshGitFor(project.rootPath)
      }
      return true
    }
    if (prevId && prevId !== project.id && !options?.skipConfirm) {
      const allowed = await confirmLeaveActiveProject()
      if (!allowed) return false
    }
    loading.value = true
    try {
      if (prevId !== project.id) {
        fullscreenPanel.value = null
        doc.closeTabsOutsideRoot(project.rootPath)
        const { useHistoryStore } = await import('./history')
        useHistoryStore().clear()
      }
      activeProjectId.value = project.id
      expandedProjectIds.value = [project.id]
      await window.studio.projectTouch?.(project.id)
      const payload = await window.studio.workspaceScan(project.rootPath)
      scan.value = payload
      await window.studio.projectCacheModules?.(project.id, payload.modules)
      cachedModulesByProject.value = { ...cachedModulesByProject.value, [project.id]: payload.modules }
      const ui = await window.studio.projectUiState?.(project.id)
      if (ui) {
        informalCollapsed.value = ui.informalCollapsed
        structureCollapsed.value = Boolean(ui.structureCollapsed)
        if (ui.columnWidths?.length === 3) {
          columnWidths.value = ui.columnWidths
        } else if (ui.columnWidths?.length === 4) {
          columnWidths.value = [
            ui.columnWidths[0] ?? 0.18,
            (ui.columnWidths[1] ?? 0.22) + (ui.columnWidths[2] ?? 0.38),
            ui.columnWidths[3] ?? 0.22
          ]
        } else {
          columnWidths.value = [...DEFAULT_COLUMN_WIDTHS]
        }
      }
      await loadProjectFiles(payload)
      const preferred = ui?.selectedModuleName
      const nextModule =
        payload.modules.find((m) => m.name === preferred)?.name ?? payload.modules[0]?.name ?? null
      selectModule(nextModule)
      return true
    } finally {
      loading.value = false
      void refreshGitFor(project.rootPath)
    }
  }

  async function requestActivateProject(project: IndexedProject): Promise<boolean> {
    if (project.id === activeProjectId.value) {
      if (!expandedProjectIds.value.includes(project.id)) {
        expandedProjectIds.value = [project.id]
      }
      return true
    }
    return activateProject(project)
  }

  async function init(): Promise<boolean> {
    await refreshProjects()
    const first = projects.value[0]
    if (!first) return false
    expandedProjectIds.value = [first.id]
    await activateProject(first, { skipConfirm: true })
    return true
  }

  async function createProject(name: string): Promise<boolean> {
    const result = await window.studio?.projectCreate?.(name)
    if (!result) return false
    await refreshProjects()
    return activateProject(result.project)
  }

  async function createProjectFromTemplate(name: string, templateId: string): Promise<boolean> {
    const result = await window.studio?.projectCreateFromTemplate?.(name, templateId)
    if (!result) return false
    await refreshProjects()
    return activateProject(result.project)
  }

  async function openProjectFolder(): Promise<boolean> {
    const result = await window.studio?.projectOpenFolder?.()
    if (!result) return false
    await refreshProjects()
    return activateProject(result.project)
  }

  async function removeFromList(projectId: string): Promise<void> {
    if (activeProjectId.value === projectId) {
      if (!(await confirmLeaveActiveProject())) return
    }
    await window.studio?.projectRemove?.(projectId)
    if (activeProjectId.value === projectId) {
      activeProjectId.value = null
      scan.value = null
      selectedModuleName.value = null
      selection.value = null
    }
    await refreshProjects()
    if (!activeProjectId.value && projects.value[0]) {
      await activateProject(projects.value[0], { skipConfirm: true })
    }
  }

  async function refreshActive(): Promise<void> {
    const project = activeProject.value
    if (!project) return
    await activateProject(project)
  }

  function selectModule(name: string | null, extra?: TreeSelection): void {
    selectedModuleName.value = name
    if (extra) selection.value = extra
    else if (name) selection.value = { kind: 'module', moduleName: name }
    else selection.value = null
    const tab = hybridTab.value
    if (tab) doc.setActive(tab.id)
    void persistUi()
  }

  function revealInformalInDocument(id: string): void {
    informalSelectedNodeId.value = id
    informalViewMode.value = 'document'
    informalRevealNonce.value += 1
  }

  function revealHybridInCode(name: string, extra?: TreeSelection): void {
    hybridMode.value = 'code'
    selectModule(name, extra)
    hybridRevealNonce.value += 1
  }

  function revealEditorMatch(request: EditorRevealRequest): void {
    editorReveal.value = request
    editorRevealNonce.value += 1
    if (request.kind === 'aspec') {
      informalViewMode.value = 'document'
      setFocusedPanel('informal')
      return
    }
    if (request.kind === 'asfl') {
      hybridMode.value = 'code'
      const mod = modules.value.find((item) => filePathsEqual(item.filePath, request.filePath))
      if (mod) selectModule(mod.name)
      setFocusedPanel('hybrid')
      return
    }
    guiMode.value = 'code'
    setFocusedPanel('gui')
  }

  function revealGuiScreen(id: string): void {
    guiRevealScreenId.value = id
    guiMode.value = 'visual'
    guiRevealNonce.value += 1
    setFocusedPanel('gui')
  }

  function collapseAllProjects(): void {
    expandedProjectIds.value = []
    void persistUi()
  }

  async function renameProject(projectId: string, name: string): Promise<boolean> {
    const next = await window.studio?.projectRename?.(projectId, name)
    if (!next) return false
    await refreshProjects()
    return true
  }

  function toggleProjectExpanded(id: string): void {
    if (expandedProjectIds.value.includes(id)) {
      expandedProjectIds.value = expandedProjectIds.value.filter((x) => x !== id)
    } else {
      expandedProjectIds.value = [...expandedProjectIds.value, id]
    }
  }

  function setInformalCollapsed(v: boolean): void {
    informalCollapsed.value = v
    void persistUi()
  }

  function setStructureCollapsed(v: boolean): void {
    structureCollapsed.value = v
    void persistUi()
  }

  function setColumnWidths(widths: number[]): void {
    columnWidths.value = widths
    void persistUi()
  }

  async function markHybridSaved(filePath: string): Promise<void> {
    if (!window.studio?.moduleHashes) return
    const tab = doc.documentTabs.find((t) => t.filePath && filePathsEqual(t.filePath, filePath))
    if (!tab) return
    const hashes = await window.studio.moduleHashes(tab.content)
    savedModuleHashes.value = { ...savedModuleHashes.value, [filePath]: hashes }
    currentModuleHashes.value = { ...currentModuleHashes.value, [filePath]: hashes }
  }

  let moduleSyncTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleModuleSync(): void {
    if (moduleSyncTimer) clearTimeout(moduleSyncTimer)
    moduleSyncTimer = setTimeout(() => {
      moduleSyncTimer = null
      if (doc.hasPendingEdit()) {
        scheduleModuleSync()
        return
      }
      void refreshHashes()
      void resyncModulesFromOpenTabs()
    }, 700)
  }

  watch(
    () =>
      doc.documentTabs
        .filter((t) => t.documentKind === 'asfl')
        .map((t) => `${t.filePath}:${t.content.length}:${t.isDirty}`)
        .join('|'),
    () => {
      scheduleModuleSync()
    }
  )

  async function resyncModulesFromOpenTabs(): Promise<void> {
    if (typeof window === 'undefined' || !scan.value || !window.studio?.modulesFromSource) return
    const root = activeProject.value?.rootPath
    if (!root) return
    const guiModule = scan.value.manifest.guiModule
    let modules = modulesInActiveProject(scan.value.modules)
    const asflTabs = doc.documentTabs.filter(
      (t) => t.documentKind === 'asfl' && t.filePath && fileBelongsToRoot(t.filePath, root)
    )
    for (const tab of asflTabs) {
      const path = tab.filePath
      if (!path) continue
      const next = await window.studio.modulesFromSource({
        source: tab.content,
        filePath: path,
        guiModule
      })
      const looksLikeHybrid = /\b(?:module|system)\b/i.test(tab.content)
      if (next.length === 0 && looksLikeHybrid) {
        const prev = modules.filter((m) => filePathsEqual(m.filePath, path))
        if (prev.length > 0) continue
      }
      modules = modules.filter((m) => !filePathsEqual(m.filePath, path)).concat(next)
    }
    modules = modulesInActiveProject(modules)
    scan.value = { ...scan.value, modules }
    const projectId = activeProjectId.value
    if (projectId) {
      cachedModulesByProject.value = { ...cachedModulesByProject.value, [projectId]: modules }
      void window.studio.projectCacheModules?.(projectId, modules)
    }
    if (selectedModuleName.value && !modules.some((m) => m.name === selectedModuleName.value)) {
      const fallback = modules.find((m) => m.isSystem)?.name ?? modules[0]?.name ?? null
      selectModule(fallback)
    }
  }

  function requestAgentLaunch(req: HybridAgentBootstrapPayload): void {
    informalCollapsed.value = false
    if (agentSplitRatio.value > 0.78) agentSplitRatio.value = 0.58
    focusedPanel.value = 'agent'
    emitAgentLaunch(req)
  }

  function consumeAgentLaunch(): HybridAgentBootstrapPayload | null {
    return consumeAgentLaunchPending()
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    scan,
    modules,
    selectedModuleName,
    selectedModule,
    selection,
    informalCollapsed,
    structureCollapsed,
    columnWidths,
    expandedProjectIds,
    hybridMode,
    guiMode,
    structureMode,
    informalViewMode,
    informalSelectedNodeId,
    agentSplitRatio,
    structureSplitRatio,
    informalRevealNonce,
    hybridRevealNonce,
    editorRevealNonce,
    editorReveal,
    revealEditorMatch,
    guiRevealNonce,
    guiRevealScreenId,
    informalGraphBodyVisible,
    revealInformalInDocument,
    revealHybridInCode,
    revealGuiScreen,
    requestAgentLaunch,
    consumeAgentLaunch,
    focusedPanel,
    fullscreenPanel,
    agentBusy,
    setAgentBusy,
    registerAgentAbort,
    abortRunningAgent,
    setFullscreenPanel,
    toggleFullscreenPanel,
    loading,
    hasWorkspace,
    isGuiModuleSelected,
    informalTab,
    hybridTab,
    guiTab,
    dirtyNames,
    isModuleDirty,
    isInformalDirty,
    isHybridDirty,
    isGuiDirty,
    tabForFocusedPanel,
    setFocusedPanel,
    refreshProjects,
    init,
    createProject,
    createProjectFromTemplate,
    openProjectFolder,
    activateProject,
    requestActivateProject,
    removeFromList,
    refreshActive,
    selectModule,
    modulesFor,
    toggleProjectExpanded,
    collapseAllProjects,
    renameProject,
    setInformalCollapsed,
    setStructureCollapsed,
    setColumnWidths,
    markHybridSaved,
    persistUi,
    resyncModulesFromOpenTabs,
    persistDirtyDocuments,
    confirmLeaveActiveProject
  }
})
