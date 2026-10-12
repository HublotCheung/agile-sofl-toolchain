import { contextBridge, ipcRenderer } from 'electron'
import type {
  IndexedProject,
  ProjectModuleInfo,
  ProjectUiState,
  WorkspaceScanPayload
} from '../shared/projectTypes'

export type {
  AgileSoflManifest,
  IndexedProject,
  ProjectFileInfo,
  ProjectModuleInfo,
  ProjectModuleMember,
  ProjectModuleMemberKind,
  ProjectUiState,
  WorkspaceScanPayload
} from '../shared/projectTypes'

export type FileOpenResult = {
  filePath: string
  content: string
  title: string
}

const studio = {
  minimize: () => ipcRenderer.invoke('studio:window-minimize'),
  maximize: () => ipcRenderer.invoke('studio:window-maximize') as Promise<boolean>,
  close: () => ipcRenderer.invoke('studio:window-close'),
  isMaximized: () => ipcRenderer.invoke('studio:window-is-maximized') as Promise<boolean>,
  getPlatform: () => ipcRenderer.invoke('studio:app-get-platform') as Promise<string>,
  getLocale: () => ipcRenderer.invoke('studio:app-get-locale') as Promise<string>,
  whenBackendReady: () => ipcRenderer.invoke('studio:backend-ready') as Promise<void>,
  openDevTools: () => ipcRenderer.invoke('studio:open-devtools') as Promise<void>,
  onMaximizedChanged: (cb: (maximized: boolean) => void) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('studio:window-maximized-changed', handler)
    return () => ipcRenderer.removeListener('studio:window-maximized-changed', handler)
  },
  onRequestClose: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('studio:request-close', handler)
    return () => ipcRenderer.removeListener('studio:request-close', handler)
  },
  confirmClose: () => ipcRenderer.send('studio:confirm-close'),

  fileOpenDialog: (kind?: 'asfl' | 'aspec' | 'guispec' | 'any') =>
    ipcRenderer.invoke('studio:file-open-dialog', kind) as Promise<FileOpenResult | null>,
  fileSaveDialog: (defaultName?: string, kind?: 'asfl' | 'aspec' | 'guispec') =>
    ipcRenderer.invoke('studio:file-save-dialog', defaultName, kind) as Promise<string | null>,
  fileRead: (path: string) => ipcRenderer.invoke('studio:file-read', path) as Promise<FileOpenResult>,
  fileWrite: (path: string, content: string) =>
    ipcRenderer.invoke('studio:file-write', path, content) as Promise<{ filePath: string; title: string }>,
  lspSend: (jsonBody: string) => ipcRenderer.send('studio:lsp-send', jsonBody),
  lspOnMessage: (cb: (message: string) => void) => {
    const handler = (_: unknown, message: string) => cb(message)
    ipcRenderer.on('studio:lsp-message', handler)
    return () => ipcRenderer.removeListener('studio:lsp-message', handler)
  },
  lspOnStatusChanged: (cb: (status: { running: boolean; message?: string }) => void) => {
    const handler = (_: unknown, status: { running: boolean; message?: string }) => cb(status)
    ipcRenderer.on('studio:lsp-status-changed', handler)
    return () => ipcRenderer.removeListener('studio:lsp-status-changed', handler)
  },
  getLspStatus: () =>
    ipcRenderer.invoke('studio:lsp-status') as Promise<{ running: boolean; message: string }>,

  buildVisualModel: (source: string, channelId: string) =>
    ipcRenderer.invoke('studio:build-visual-model', source, channelId) as Promise<VisualModelPayload>,
  buildModuleGraphLayout: (
    graph: ModuleGraphPayload,
    options?: {
      searchQuery?: string
      tidy?: boolean
      orientation?: 'portrait' | 'landscape'
      moduleSizes?: Record<string, { width: number; height?: number }>
      processMeta?: Record<string, { isAlias?: boolean; aliasTarget?: string; hasExt?: boolean }>
    }
  ) => {
    const safeGraph = JSON.parse(JSON.stringify(graph)) as ModuleGraphPayload
    const safeOptions = options ? JSON.parse(JSON.stringify(options)) : undefined
    return ipcRenderer.invoke(
      'studio:build-module-graph-layout',
      safeGraph,
      safeOptions
    ) as Promise<ModuleGraphLayoutPayload>
  },
  resetVisualChannel: (channelId: string) =>
    ipcRenderer.invoke('studio:reset-visual-channel', channelId) as Promise<void>,
  patchDocument: (payload: PatchDocumentPayload) =>
    ipcRenderer.invoke('studio:patch-document', payload) as Promise<string>,
  formatDocument: (source: string) =>
    ipcRenderer.invoke('studio:format-document', source) as Promise<string>,
  patchDeclaration: (payload: PatchDeclarationPayload) =>
    ipcRenderer.invoke('studio:patch-declaration', payload) as Promise<string>,
  patchGuiWidget: (payload: PatchGuiWidgetPayload) =>
    ipcRenderer.invoke('studio:patch-gui-widget', payload) as Promise<string>,
  patchProcess: (payload: PatchProcessPayload) =>
    ipcRenderer.invoke('studio:patch-process', payload) as Promise<string>,
  patchFunction: (payload: PatchFunctionPayload) =>
    ipcRenderer.invoke('studio:patch-function', payload) as Promise<string>,
  patchInvariant: (payload: PatchInvariantPayload) =>
    ipcRenderer.invoke('studio:patch-invariant', payload) as Promise<string>,
  patchExt: (payload: PatchExtPayload) =>
    ipcRenderer.invoke('studio:patch-ext', payload) as Promise<string>,
  patchProcessSignature: (payload: PatchProcessSignaturePayload) =>
    ipcRenderer.invoke('studio:patch-process-signature', payload) as Promise<string>,
  patchFunctionSignature: (payload: PatchFunctionSignaturePayload) =>
    ipcRenderer.invoke('studio:patch-function-signature', payload) as Promise<string>,
  patchAlias: (payload: PatchAliasPayload) =>
    ipcRenderer.invoke('studio:patch-alias', payload) as Promise<string>,
  patchModule: (payload: PatchModulePayload) =>
    ipcRenderer.invoke('studio:patch-module', payload) as Promise<string>,
  patchProcessInit: (payload: PatchProcessInitPayload) =>
    ipcRenderer.invoke('studio:patch-process-init', payload) as Promise<string>,
  parsePredicateUi: (text: string) =>
    ipcRenderer.invoke('studio:parse-predicate-ui', text) as Promise<{
      ui: import('@agile-sofl/editor-api').PredicateUiNode | null
      error: string | null
    }>,
  uiToPredicateText: (node: import('@agile-sofl/editor-api').PredicateUiNode) =>
    ipcRenderer.invoke('studio:ui-to-predicate-text', node) as Promise<string>,
  validateSignature: (kind: 'process' | 'function', signature: string) =>
    ipcRenderer.invoke('studio:validate-signature', kind, signature) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  searchWorkspaceFiles: (rootDir: string, query?: string) =>
    ipcRenderer.invoke('studio:search-workspace-files', rootDir, query) as Promise<
      Array<{ path: string }>
    >,
  searchWorkspaceSymbols: (rootDir: string, query?: string) =>
    ipcRenderer.invoke('studio:search-workspace-symbols', rootDir, query) as Promise<
      Array<{
        uri: string
        name: string
        kind: string
        moduleName: string
        span: SerializableSpan
        containerName?: string
      }>
    >
  ,
  searchProjectText: (payload: import('../shared/textSearch').TextSearchRequest) =>
    ipcRenderer.invoke('studio:search-project-text', payload) as Promise<
      import('../shared/textSearch').TextSearchResponse
    >,
  openProjectFolder: () => ipcRenderer.invoke('studio:open-project-folder') as Promise<string | null>,
  revealInFolder: (filePath: string) =>
    ipcRenderer.invoke('studio:reveal-in-folder', filePath) as Promise<void>,
  buildInformalModel: (source: string, options?: { bookAlignStrict?: boolean }) =>
    ipcRenderer.invoke('studio:build-informal-model', source, options) as Promise<InformalModelPayload>,
  patchAspec: (payload: PatchAspecPayload) =>
    ipcRenderer.invoke('studio:patch-aspec', payload) as Promise<string>,
  refineAspec: (payload: RefineAspecPayload) =>
    ipcRenderer.invoke('studio:refine-aspec', payload) as Promise<RefineAspecResult>,
  buildCoverageReport: (payload: {
    aspecSource: string
    asflSource: string
    traceJson?: string
    guiSource?: string
  }) => ipcRenderer.invoke('studio:build-coverage-report', payload) as Promise<CoverageReportPayload>,
  patchInformal: (payload: { source: string; span: SerializableSpan; text: string }) =>
    ipcRenderer.invoke('studio:patch-informal', payload) as Promise<string>,
  buildHybridRegions: (source: string) =>
    ipcRenderer.invoke('studio:build-hybrid-regions', source) as Promise<HybridRegionPayload[]>,
  getInformalSpans: (source: string) =>
    ipcRenderer.invoke('studio:get-informal-spans', source) as Promise<InformalSpanPayload[]>,
  scanProject: (root: string) => ipcRenderer.invoke('studio:scan-project', root) as Promise<ProjectScanPayload>,
  workspaceScan: (root: string) =>
    ipcRenderer.invoke('studio:workspace-scan', root) as Promise<WorkspaceScanPayload>,
  moduleHashes: (source: string) =>
    ipcRenderer.invoke('studio:module-hashes', source) as Promise<Record<string, string>>,
  modulesFromSource: (payload: { source: string; filePath: string; guiModule?: string }) =>
    ipcRenderer.invoke('studio:modules-from-source', {
      source: payload.source,
      filePath: payload.filePath,
      guiModule: payload.guiModule
    }) as Promise<ProjectModuleInfo[]>,
  projectList: () => ipcRenderer.invoke('studio:project-list') as Promise<IndexedProject[]>,
  projectCreate: (name: string) =>
    ipcRenderer.invoke('studio:project-create', name) as Promise<{
      project: IndexedProject
      root: string
    } | null>,
  projectCreateFromTemplate: (name: string, templateId: string) =>
    ipcRenderer.invoke('studio:project-create-from-template', name, templateId) as Promise<{
      project: IndexedProject
      root: string
    } | null>,
  projectOpenFolder: () =>
    ipcRenderer.invoke('studio:project-open-folder') as Promise<{
      project: IndexedProject
      root: string
    } | null>,
  projectRemove: (projectId: string) =>
    ipcRenderer.invoke('studio:project-remove', projectId) as Promise<boolean>,
  projectRename: (projectId: string, name: string) =>
    ipcRenderer.invoke('studio:project-rename', projectId, name) as Promise<IndexedProject | null>,
  projectTouch: (projectId: string) =>
    ipcRenderer.invoke('studio:project-touch', projectId) as Promise<boolean>,
  projectUiState: (projectId: string) =>
    ipcRenderer.invoke('studio:project-ui-state', projectId) as Promise<ProjectUiState>,
  projectSaveUiState: (projectId: string, state: ProjectUiState) =>
    ipcRenderer.invoke('studio:project-save-ui-state', projectId, state) as Promise<boolean>,
  projectCachedModules: (projectId: string) =>
    ipcRenderer.invoke('studio:project-cached-modules', projectId) as Promise<ProjectModuleInfo[]>,
  projectCacheModules: (projectId: string, modules: ProjectModuleInfo[]) =>
    ipcRenderer.invoke('studio:project-cache-modules', projectId, modules) as Promise<boolean>,
  writeTraceFile: (filePath: string, traceJson: string) =>
    ipcRenderer.invoke('studio:write-trace-file', filePath, traceJson) as Promise<boolean>,
  updateTraceContentHash: (tracePath: string, aspecSource: string) =>
    ipcRenderer.invoke('studio:update-trace-content-hash', { tracePath, aspecSource }) as Promise<boolean>,
  formatAspec: (source: string) => ipcRenderer.invoke('studio:format-aspec', source) as Promise<string>,
  parseInformalSpec: (source: string, options?: { projectRoot?: string; filePath?: string | null }) =>
    ipcRenderer.invoke('studio:parse-informal-spec', {
      source,
      projectRoot: options?.projectRoot,
      filePath: options?.filePath ?? undefined
    }) as Promise<InformalParsePayload>,
  patchInformalSpec: (payload: { source: string; patch: InformalPatchPayload }) =>
    ipcRenderer.invoke('studio:patch-informal-spec', JSON.parse(JSON.stringify(payload))) as Promise<{
      content: string
      ok: boolean
      error?: string
    }>,
  llmStatus: () =>
    ipcRenderer.invoke('studio:llm-status') as Promise<{
      configured: boolean
      model: string
      baseUrl?: string
    }>,
  llmListProfiles: () =>
    ipcRenderer.invoke('studio:llm-list-profiles') as Promise<{
      activeId: string | null
      profiles: LlmProfilePublicPayload[]
    }>,
  llmSaveProfile: (draft: LlmProfileDraftPayload) =>
    ipcRenderer.invoke('studio:llm-save-profile', JSON.parse(JSON.stringify(draft))) as Promise<{
      activeId: string | null
      savedId: string
      profiles: LlmProfilePublicPayload[]
    }>,
  llmDeleteProfile: (id: string) =>
    ipcRenderer.invoke('studio:llm-delete-profile', id) as Promise<{
      activeId: string | null
      profiles: LlmProfilePublicPayload[]
    }>,
  llmSetActiveProfile: (id: string) =>
    ipcRenderer.invoke('studio:llm-set-active-profile', id) as Promise<{
      activeId: string | null
      profiles: LlmProfilePublicPayload[]
    }>,
  llmExportProfiles: () => ipcRenderer.invoke('studio:llm-export-profiles') as Promise<string>,
  llmImportProfiles: (raw: unknown) =>
    ipcRenderer.invoke('studio:llm-import-profiles', raw) as Promise<{
      activeId: string | null
      profiles: LlmProfilePublicPayload[]
    }>,
  llmTestProfile: (request: LlmTestRequestPayload) =>
    ipcRenderer.invoke('studio:llm-test-profile', JSON.parse(JSON.stringify(request))) as Promise<{
      ok: boolean
      message: string
      ms: number
      detail?: string
    }>,
  agentSkills: () =>
    ipcRenderer.invoke('studio:agent-skills') as Promise<Array<{ id: string; name: string }>>,
  agentListSessions: (projectRoot: string) =>
    ipcRenderer.invoke('studio:agent-list-sessions', projectRoot) as Promise<AgentSessionPayload[]>,
  agentCreateSession: (payload: {
    projectRoot: string
    moduleId?: string
    title?: string
    skillId?: string
    permissions?: AgentSpecPermissionsPayload
    promptExtras?: string
  }) => ipcRenderer.invoke('studio:agent-create-session', payload) as Promise<AgentSessionPayload>,
  agentRenameSession: (payload: { projectRoot: string; id: string; title: string }) =>
    ipcRenderer.invoke('studio:agent-rename-session', payload) as Promise<AgentSessionPayload | null>,
  agentDeleteSession: (payload: { projectRoot: string; id: string }) =>
    ipcRenderer.invoke('studio:agent-delete-session', payload) as Promise<boolean>,
  agentLoadSession: (payload: { projectRoot: string; id: string }) =>
    ipcRenderer.invoke('studio:agent-load-session', payload) as Promise<AgentSessionPayload | null>,
  agentDuplicateSession: (payload: { projectRoot: string; id: string }) =>
    ipcRenderer.invoke('studio:agent-duplicate-session', payload) as Promise<AgentSessionPayload | null>,
  agentForkSession: (payload: {
    projectRoot: string
    id: string
    throughMessageId: string
    mode?: 'keep' | 'reset'
    title?: string
  }) => ipcRenderer.invoke('studio:agent-fork-session', payload) as Promise<AgentSessionPayload | null>,
  agentRewindSession: (payload: {
    projectRoot: string
    id: string
    throughMessageId: string
    mode?: 'keep' | 'reset'
    exclusive?: boolean
  }) =>
    ipcRenderer.invoke('studio:agent-rewind-session', payload) as Promise<AgentSessionPayload | null>,
  agentFlagSession: (payload: {
    projectRoot: string
    id: string
    flag: 'pinned' | 'archived'
    value: boolean
  }) => ipcRenderer.invoke('studio:agent-flag-session', payload) as Promise<AgentSessionPayload | null>,
  agentChat: (payload: {
    projectRoot: string
    sessionId: string
    text: string
    context: AgentTurnContextPayload
  }) => ipcRenderer.invoke('studio:agent-chat', payload) as Promise<AgentSessionPayload>,
  agentResume: (payload: {
    projectRoot: string
    sessionId: string
    toolCallId: string
    result: string
    context: AgentTurnContextPayload
    continueTurn?: boolean
  }) =>
    ipcRenderer.invoke('studio:agent-resume', payload) as Promise<AgentSessionPayload | null>,
  agentAbort: (sessionId: string) =>
    ipcRenderer.invoke('studio:agent-abort', sessionId) as Promise<{ ok: boolean }>,
  onAgentDelta: (
    cb: (payload: {
      sessionId: string
      kind: 'session' | 'reasoning' | 'content' | 'tool_call' | 'tool_status'
      session?: AgentSessionPayload
      messageId?: string
      text?: string
      index?: number
      id?: string
      name?: string
      arguments?: string
      status?: AgentToolCallPayload['status']
    }) => void
  ) => {
    const handler = (
      _: unknown,
      payload: {
        sessionId: string
        kind: 'session' | 'reasoning' | 'content' | 'tool_call' | 'tool_status'
        session?: AgentSessionPayload
        messageId?: string
        text?: string
        index?: number
        id?: string
        name?: string
        arguments?: string
        status?: AgentToolCallPayload['status']
      }
    ) => cb(payload)
    ipcRenderer.on('studio:agent-delta', handler)
    return () => ipcRenderer.removeListener('studio:agent-delta', handler)
  },
  listHybridGenerators: () =>
    ipcRenderer.invoke('studio:list-hybrid-generators') as Promise<
      Array<{ id: string; name: string; runtime?: 'batch' | 'agent' }>
    >,
  generateHybrid: (payload: {
    source: string
    generatorId?: string
    projectName?: string
    projectRoot?: string
    existingAsfl?: string
    scope?: 'hybrid' | 'module' | 'process' | 'scenario'
    moduleName?: string
    processName?: string
    selectedNodeIds?: string[]
    specification?: unknown
    params?: HybridGenerateParamsPayload
  }) =>
    ipcRenderer.invoke('studio:generate-hybrid', JSON.parse(JSON.stringify(payload))) as Promise<
      | {
          ok: true
          kind?: 'document'
          asflText: string
          traceLinks: unknown[]
          warnings: Array<{ code: string; message: string }>
          specification?: unknown
          changes?: Array<{ id: string; kind: string; name: string; summary: string; selected?: boolean }>
        }
      | {
          ok: true
          kind: 'agent-session'
          bootstrap: HybridAgentBootstrapPayload
        }
      | { ok: false; error: string }
    >,
  hybridInventory: (source: string) =>
    ipcRenderer.invoke('studio:hybrid-inventory', source) as Promise<{ inventory: string }>,
  patchHybridSpec: (payload: { source: string; patch: InformalPatchPayload }) =>
    ipcRenderer.invoke('studio:patch-hybrid-spec', JSON.parse(JSON.stringify(payload))) as Promise<{
      content: string
      error?: string
    }>,
  acceptHybridWrite: (payload: { before: string; after: string }) =>
    ipcRenderer.invoke('studio:accept-hybrid-write', payload) as Promise<{
      ok: boolean
      content: string
      error?: string
      repairNotes?: string[]
    }>,
  refinementStep: (payload: { source: string; projectRoot: string; step: Record<string, unknown> }) =>
    ipcRenderer.invoke('studio:refinement-step', JSON.parse(JSON.stringify(payload))) as Promise<{
      source: string
      error?: string
      state: unknown
      repairNotes?: string[]
    }>,
  refinementState: (payload: { source: string; projectRoot: string }) =>
    ipcRenderer.invoke('studio:refinement-state', {
      source: payload.source,
      projectRoot: payload.projectRoot
    }) as Promise<unknown>,
  gitIsRepo: (rootPath: string) => ipcRenderer.invoke('studio:git-is-repo', rootPath) as Promise<boolean>,
  gitStatus: (rootPath: string) =>
    ipcRenderer.invoke('studio:git-status', rootPath) as Promise<{
      isRepo: boolean
      files: Array<{
        path: string
        status: 'untracked' | 'added' | 'modified' | 'deleted' | 'conflicted' | 'ignored' | 'renamed'
      }>
    }>,
  gitInit: (rootPath: string) =>
    ipcRenderer.invoke('studio:git-init', rootPath) as Promise<{ ok: boolean; error?: string }>,
  buildGuiModel: (payload: { source: string; informalSource?: string; hybridSource?: string }) =>
    ipcRenderer.invoke('studio:build-gui-model', payload) as Promise<GuiModelPayload>,
  patchGui: (payload: PatchGuiPayload & { source: string }) =>
    ipcRenderer.invoke('studio:patch-gui', payload) as Promise<string>,
  formatGui: (source: string) => ipcRenderer.invoke('studio:format-gui', source) as Promise<string>,
  animateGuiProcess: (payload: {
    asfl: string
    process: string
    env: Record<string, string | number | boolean | null>
    scenarioId?: string
  }) =>
    ipcRenderer.invoke('studio:animate-gui-process', payload) as Promise<{
      process: string
      unevaluable: boolean
      matched: Array<{ id: string; name: string; kind: string; guard: string; definingCondition: string }>
      scenarios: Array<{ id: string; name: string; kind: string; guard: string; definingCondition: string }>
      outputs: Record<string, string | number | boolean | null>
    }>,
  resolveGuiForAspec: (payload: { aspecSource: string; externalGuiSource?: string }) =>
    ipcRenderer.invoke('studio:resolve-gui-for-aspec', payload) as Promise<GuiModelPayload>,
  patchAspecGui: (payload: { aspecSource: string; action: PatchGuiActionOnly }) =>
    ipcRenderer.invoke('studio:patch-aspec-gui', payload) as Promise<string>,
  findHybridSymbolSpan: (payload: { source: string; symbolName: string; kind?: 'process' | 'function' }) =>
    ipcRenderer.invoke('studio:find-hybrid-symbol-span', payload) as Promise<SerializableSpan | null>
}

export type SerializableSpan = {
  start: number
  end: number
  line: number
  column: number
}

export type DiagnosticSummary = {
  code: string
  message: string
  severity: string
  span: SerializableSpan
  source?: 'parse' | 'fsf' | 'lsp'
}

export type VisualDeclarationItem = {
  name: string
  text: string
  span: { start: number; end: number; line: number; column: number }
  fields?: Array<{ name: string; type: string }>
}

export type VisualFunctionItem = VisualDeclarationItem & {
  hasFsf?: boolean
  body?: string
  signature?: string
  params?: ParamGroupItem[]
  returnType?: string
  fsfFormal?: 'formal' | 'semi-formal' | null
}

export type VisualInvariantItem = {
  text: string
  span: SerializableSpan
}

export type ExtVarItem = {
  access: 'rd' | 'wr'
  name: string
  type?: string
}

export type ParamGroupItem = {
  names: string
  type: string
}

export type VisualModuleProcess = {
  name: string
  span?: SerializableSpan
  decom: string
  comment: string
  hasFsf: boolean
  isAlias?: boolean
  aliasTarget?: string
  isInit?: boolean
  signature?: string
  inputs?: ParamGroupItem[]
  outputs?: ParamGroupItem[]
  ext?: ExtVarItem[]
  fsfFormal?: 'formal' | 'semi-formal' | null
  pre?: string
  post?: string
  hasPre?: boolean
  hasPost?: boolean
  scenarioCount?: number
  exceptionalCount?: number
  formalizationStatus?: 'semi-formal' | 'formal' | 'mixed'
  fsfSource?: 'derived' | 'editor-internal-dsl'
}

export type VisualGuiWidget = {
  name: string
  kind: string
  text: string
  triggersProcess?: string
  span: { start: number; end: number; line: number; column: number }
}

export type VisualGuiScreen = {
  name: string
  span: { start: number; end: number; line: number; column: number }
  triggersProcess?: string
  widgets: VisualGuiWidget[]
}

export type VisualGuiBlock = {
  name: string
  span: { start: number; end: number; line: number; column: number }
  screens: VisualGuiScreen[]
}

export type VisualModuleSummary = {
  name: string
  isSystem: boolean
  parentName?: string
  span: { start: number; end: number; line: number; column: number }
  constCount: number
  typeCount: number
  varCount: number
  invCount: number
  invariants: VisualInvariantItem[]
  processes: VisualModuleProcess[]
  functions: VisualFunctionItem[]
  consts: VisualDeclarationItem[]
  types: VisualDeclarationItem[]
  vars: VisualDeclarationItem[]
  gui?: VisualGuiBlock
}

export type ModuleGraphLayoutPayload = {
  compounds: Array<{
    moduleId: string
    name: string
    moduleRole?: string
    depth?: number
    x: number
    y: number
    width: number
    height: number
    sections: Array<{
      key: string
      titleKey: string
      rows: Array<{
        nodeId: string
        kind: string
        label: string
        moduleName: string
        processName?: string
        functionName?: string
        hidden?: boolean
      }>
      y: number
      height: number
    }>
    rowByNodeId: Record<string, { x: number; y: number; w: number; h: number }>
  }>
  edges: Array<{
    from: string
    to: string
    kind: string
    x1: number
    y1: number
    x2: number
    y2: number
  }>
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

export type ModuleGraphPayload = {
  nodes: Array<{ id: string; kind: string; name: string; parentId?: string; moduleRole?: string }>
  edges: Array<{ from: string; to: string; kind: string }>
}

export type VisualModelPayload = {
  parseFailed: boolean
  hasDiagnostics: boolean
  documentModel: unknown
  diagnostics: DiagnosticSummary[]
  moduleGraph: unknown
  cdfdGraphs?: unknown[]
  fsfModels: unknown[]
  modules: VisualModuleSummary[]
}

export type PatchProcessPayload = {
  source: string
  moduleName: string
  kind: 'process' | 'function'
  action: 'add' | 'remove' | 'rename'
  name: string
  newName?: string
  template?: string
}

export type PatchGuiWidgetPayload = {
  source: string
  moduleName: string
  screenName: string
  widgetName: string
  text: string
}

export type PatchDeclarationPayload = {
  source: string
  moduleName: string
  kind: 'const' | 'type' | 'var'
  action: 'patch' | 'add' | 'remove'
  name?: string
  text?: string
}

export type PatchDocumentPayload = {
  source: string
  kind: 'fsf' | 'comment' | 'decom' | 'pre' | 'post'
  processName: string
  scenarios?: Array<{ id: string; test: string; def: string; span: unknown; kind?: string; guard?: string; definingCondition?: string }>
  others?: string
  text?: string
}

export type PatchInvariantPayload = {
  source: string
  action?: 'patch' | 'add' | 'remove' | 'reorder'
  moduleName?: string
  span?: SerializableSpan
  index?: number
  text?: string
  fromIndex?: number
  toIndex?: number
}

export type PatchFunctionPayload = {
  source: string
  moduleName: string
  name: string
  body?: string
  fsf?: {
    scenarios: Array<{ id: string; test: string; def: string; span: unknown }>
    others?: string
  }
}

export type PatchExtPayload = {
  source: string
  moduleName: string
  processName: string
  vars: ExtVarItem[]
}

export type PatchProcessSignaturePayload = {
  source: string
  moduleName: string
  processName: string
  signature: string
}

export type PatchFunctionSignaturePayload = {
  source: string
  moduleName: string
  functionName: string
  signature: string
}

export type PatchAliasPayload = {
  source: string
  moduleName: string
  processName: string
  aliasTarget: string
}

export type PatchModulePayload = {
  source: string
  action: 'add' | 'remove' | 'rename'
  moduleName: string
  newName?: string
  parentName?: string
  isSystem?: boolean
}

export type PatchProcessInitPayload = {
  source: string
  moduleName: string
  processName: string
  isInit: boolean
  fallbackName?: string
}

export type InformalDiagnostic = {
  code: string
  message: string
  severity: string
  path?: string
  line?: number
  column?: number
}

export type InformalScenarioPayload = {
  id: string
  condition: string
  outcome: string
}

export type InformalProcessPayload = {
  id: string
  name: string
  description?: string
  decomposition?: string
  notes?: string
  preconditions?: string
  postconditions?: string
  scenarios?: InformalScenarioPayload[]
  refinementHints?: { bottomLevel?: boolean; expectedFsfLevel?: 'semi-formal' | 'formal' }
  signature?: {
    inputs?: Array<{ name: string; typeHint?: string }>
    outputs?: Array<{ name: string; typeHint?: string }>
  }
}

export type InformalModulePayload = {
  id: string
  name: string
  description: string
  processes?: InformalProcessPayload[]
  functions?: Array<{
    id: string
    name: string
    description?: string
    bodyHint?: string
    signature?: InformalProcessPayload['signature']
    refinementHints?: InformalProcessPayload['refinementHints']
  }>
  constants?: Array<{ id: string; name: string; valueHint?: string; description?: string }>
  types?: Array<{ id: string; name: string; typeHint?: string }>
  variables?: Array<{ id: string; name: string; typeHint?: string }>
  invariants?: Array<{ id: string; textHint?: string; description?: string }>
}

export type BookAlignPayload = {
  functions?: Array<{ ref: string; description: string }>
  data?: Array<{ ref: string; description: string; usedBy?: string[] }>
  constraints?: Array<{ ref: string; description: string; refs?: string[] }>
}

export type InformalNodePayload = {
  id: string
  type: 'function' | 'data-resource' | 'data-field' | 'constraint' | 'text'
  title: string
  description?: string
  parentId?: string
  children: string[]
  metadata?: Record<string, unknown>
}

export type InformalSpecPayload = {
  id: string
  moduleId: string
  version: number
  metadata: { title?: string; hybridTarget?: string; guiTarget?: string; sourceFormat?: string }
  sections: Array<{
    id: string
    type: 'functions' | 'data-resources' | 'constraints'
    title: string
    children: InformalNodePayload[]
  }>
}

export type InformalParsePayload = {
  specification: InformalSpecPayload | null
  diagnostics: InformalDiagnostic[]
  format: 'yaml' | 'markdown'
  displaySource?: string
}

export type InformalPatchPayload = {
  target?: 'informal' | 'hybrid' | 'gui'
  mode?: 'crud' | 'source'
  explanation?: string
  operations: Array<Record<string, unknown>>
}

export type AgentSpecPermissionsPayload = {
  informal: { read: boolean; write: boolean }
  hybrid: { read: boolean; write: boolean }
}

export type HybridGenerateParamsPayload = {
  stages: {
    hybridSpec: boolean
    modules: boolean
    processes: boolean
    scenarios: boolean
    typesVars?: boolean
    invariants?: boolean
    gui?: boolean
  }
  detailLevel: 0 | 1 | 2 | 3 | 4
  strategy: 'ask' | 'merge' | 'rebuild'
  inferUnstatedDesign: boolean
  moduleSplit: 'ask' | 'single-system' | 'cluster-by-function'
  locale?: 'zh-CN' | 'zh-TW' | 'ja' | 'en'
}

export type HybridAgentBootstrapPayload = {
  skillId: string
  title: string
  initialUserMessage: string
  promptExtras: string
  permissions: AgentSpecPermissionsPayload
}

export type AgentTurnContextPayload = {
  projectName?: string
  projectRoot?: string
  moduleId?: string
  informalMarkdown: string
  hybridAsfl?: string
  guiHtml?: string
  selectedNodeId?: string
  selectedNodeSummary?: string
  skillId?: string
  permissions?: AgentSpecPermissionsPayload
  promptExtras?: string
}

export type AgentToolCallPayload = {
  id: string
  name: string
  arguments: string
  status?: 'streaming' | 'running' | 'done' | 'error'
}

export type AgentSessionPayload = {
  id: string
  moduleId: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  archived?: boolean
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    timestamp: string
    skillId?: string
    thinking?: string
    streaming?: boolean
    toolCalls?: AgentToolCallPayload[]
    proposedChanges?: InformalPatchPayload
    clarification?: {
      id: string
      question: string
      options?: Array<{ id: string; label: string }>
      allowCustom: boolean
      multiSelect?: boolean
      pendingToolCallId?: string
      answer?: string
    }
    review?: { issues: Array<{ dimension: string; message: string; nodeId?: string }> }
    pending?: boolean
    resolution?: 'applied' | 'rejected' | 'answered' | 'error'
    toolError?: string
  }>
  context: {
    skillId?: string
    selectedNodeId?: string
    pendingToolCallId?: string
    permissions?: AgentSpecPermissionsPayload
    promptExtras?: string
    lastFailedWrite?: { fingerprint: string; error: string; count: number; mode?: string }
  }
}

export type InformalModelPayload = {
  meta: { id: string; title: string; hybridTarget?: string; guiTarget?: string }
  system: {
    name: string
    purpose: string
    scope?: string
    stakeholders?: string[]
    assumptions?: string
    glossary?: Array<{ term: string; definition: string }>
  }
  modules: InformalModulePayload[]
  bookAlign?: BookAlignPayload
  gui?: { appName: string; screenCount: number; flowCount: number; embedded: boolean; externalPath?: string }
  diagnostics: InformalDiagnostic[]
  format?: 'yaml' | 'markdown'
  informal?: InformalSpecPayload
}

export type PatchAspecPayload = {
  source: string
  action:
    | 'patch-field'
    | 'patch-by-id'
    | 'add-process'
    | 'remove-process'
    | 'add-scenario'
    | 'remove-scenario'
    | 'add-module'
    | 'remove-module'
    | 'add-function'
    | 'remove-function'
    | 'add-type'
    | 'remove-type'
    | 'add-variable'
    | 'remove-variable'
    | 'add-invariant'
    | 'remove-invariant'
    | 'add-constant'
    | 'remove-constant'
    | 'patch-book-align'
  path?: string
  idPath?: string
  value?: unknown
  moduleId?: string
  processId?: string
  scenarioId?: string
  functionId?: string
  typeId?: string
  variableId?: string
  invariantId?: string
  process?: InformalProcessPayload
  scenario?: InformalScenarioPayload
  module?: InformalModulePayload
  function?: { id: string; name: string; description?: string; bodyHint?: string }
  type?: { id: string; name: string; typeHint?: string; description?: string }
  variable?: { id: string; name: string; typeHint?: string; description?: string }
  invariant?: { id: string; textHint?: string; description?: string }
  constant?: { id: string; name: string; valueHint?: string; description?: string }
  constantId?: string
  bookAlign?: BookAlignPayload
}

export type RefineAspecPayload = {
  source: string
  aspecUri?: string
  asflUri?: string
  existingAsfl?: string
  skeletonOnly?: boolean
  mergePlans?: Array<{ aspecId: string; processName: string; strategy: string }>
  guiSource?: string
  emitGuiBlock?: boolean
}

export type RefineAspecResult = {
  asflText: string
  traceability: { traceVersion: string; links: Array<{ aspecId: string; kind: string; status: string }> }
  warnings: InformalDiagnostic[]
  checkOk: boolean
  checkDiagnostics?: InformalDiagnostic[]
}

export type CoverageReportPayload = {
  total: number
  covered: number
  partial: number
  missing: number
  stale: number
  percent: number
  items: Array<{ aspecId: string; kind: string; name: string; status: string; detail?: string }>
}

export type HybridRegionPayload = {
  type: 'fsf' | 'informal' | 'comment' | 'decom'
  span: SerializableSpan
}

export type InformalSpanPayload = {
  processName: string
  field: 'comment' | 'decom' | 'fsf'
  text: string
  span: SerializableSpan
}

export type ProjectScanPayload = {
  root: string
  aspecFiles: string[]
  asflFiles: string[]
  guispecFiles: string[]
  pairs: Array<{ aspecPath: string; asflPath?: string; guispecPath?: string; tracePath?: string }>
}

export type GuiWidgetKind =
  | 'label'
  | 'text-input'
  | 'button'
  | 'checkbox'
  | 'select'
  | 'list'
  | 'table'
  | 'section'
  | 'navigation'

export type GuiWidget = {
  id: string
  kind: GuiWidgetKind
  label?: string
  description?: string
  action?: string
  binds?: { param?: string; variable?: string; display?: string }
  options?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  events?: Array<{ on: string; action: string; targetView?: string }>
  process?: string
  nav?: string
}

export type GuiScreenDto = {
  id: string
  name: string
  title?: string
  description?: string
  triggersProcess?: string
  widgets?: GuiWidget[]
  widgetCount: number
  size?: { width: number; height: number }
}

export type GuiModelPayload = {
  meta: { id: string; title: string; informalTarget?: string }
  app: { name: string; description?: string }
  screens: GuiScreenDto[]
  flows: Array<{ from: string; to: string; on?: string; label?: string }>
  diagnostics: InformalDiagnostic[]
  sourceKind: 'guispec' | 'aspec-embedded' | 'gui-html'
  html: string
}

export type PatchGuiActionOnly =
  | { action: 'patch-by-id'; idPath: string; value: unknown }
  | {
      action: 'add-screen'
      screen: {
        id: string
        name: string
        title?: string
        widgets?: GuiWidget[]
        size?: { width: number; height: number }
      }
    }
  | { action: 'remove-screen'; screenId: string }
  | { action: 'add-widget'; screenId: string; widget: GuiWidget }
  | { action: 'remove-widget'; widgetId: string }
  | { action: 'add-flow'; flow: { from: string; to: string; on?: string } }
  | { action: 'remove-flow'; from: string; to: string }
  | { action: 'patch-app'; field: string; value: unknown }
  | { action: 'replace-html'; html: string }
  | { action: 'replace-screen-html'; screenId: string; html: string }
  | { action: 'patch-node'; path: string; attrs?: Record<string, string | null>; text?: string }
  | { action: 'insert-html'; parentPath: string; html: string }
  | { action: 'remove-node'; path: string }

export type PatchGuiPayload = PatchGuiActionOnly

export type InformalProcessOption = { id: string; name: string; moduleId: string }

export type LlmProfilePublicPayload = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  hasKey: boolean
  active: boolean
}

export type LlmProfileDraftPayload = {
  id?: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  activate?: boolean
}

export type LlmTestRequestPayload = {
  kind: 'connectivity' | 'params'
  profileId?: string
  draft?: { baseUrl?: string; apiKey?: string; model?: string }
}

contextBridge.exposeInMainWorld('studio', studio)

export type StudioApi = typeof studio
