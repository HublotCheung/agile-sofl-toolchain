"use strict";
const electron = require("electron");
const studio = {
  minimize: () => electron.ipcRenderer.invoke("studio:window-minimize"),
  maximize: () => electron.ipcRenderer.invoke("studio:window-maximize"),
  close: () => electron.ipcRenderer.invoke("studio:window-close"),
  isMaximized: () => electron.ipcRenderer.invoke("studio:window-is-maximized"),
  getPlatform: () => electron.ipcRenderer.invoke("studio:app-get-platform"),
  getLocale: () => electron.ipcRenderer.invoke("studio:app-get-locale"),
  whenBackendReady: () => electron.ipcRenderer.invoke("studio:backend-ready"),
  openDevTools: () => electron.ipcRenderer.invoke("studio:open-devtools"),
  onMaximizedChanged: (cb) => {
    const handler = (_, maximized) => cb(maximized);
    electron.ipcRenderer.on("studio:window-maximized-changed", handler);
    return () => electron.ipcRenderer.removeListener("studio:window-maximized-changed", handler);
  },
  onRequestClose: (cb) => {
    const handler = () => cb();
    electron.ipcRenderer.on("studio:request-close", handler);
    return () => electron.ipcRenderer.removeListener("studio:request-close", handler);
  },
  confirmClose: () => electron.ipcRenderer.send("studio:confirm-close"),
  fileOpenDialog: (kind) => electron.ipcRenderer.invoke("studio:file-open-dialog", kind),
  fileSaveDialog: (defaultName, kind) => electron.ipcRenderer.invoke("studio:file-save-dialog", defaultName, kind),
  fileRead: (path) => electron.ipcRenderer.invoke("studio:file-read", path),
  fileWrite: (path, content) => electron.ipcRenderer.invoke("studio:file-write", path, content),
  lspSend: (jsonBody) => electron.ipcRenderer.send("studio:lsp-send", jsonBody),
  lspOnMessage: (cb) => {
    const handler = (_, message) => cb(message);
    electron.ipcRenderer.on("studio:lsp-message", handler);
    return () => electron.ipcRenderer.removeListener("studio:lsp-message", handler);
  },
  lspOnStatusChanged: (cb) => {
    const handler = (_, status) => cb(status);
    electron.ipcRenderer.on("studio:lsp-status-changed", handler);
    return () => electron.ipcRenderer.removeListener("studio:lsp-status-changed", handler);
  },
  getLspStatus: () => electron.ipcRenderer.invoke("studio:lsp-status"),
  buildVisualModel: (source, channelId) => electron.ipcRenderer.invoke("studio:build-visual-model", source, channelId),
  buildModuleGraphLayout: (graph, options) => {
    const safeGraph = JSON.parse(JSON.stringify(graph));
    const safeOptions = options ? JSON.parse(JSON.stringify(options)) : void 0;
    return electron.ipcRenderer.invoke(
      "studio:build-module-graph-layout",
      safeGraph,
      safeOptions
    );
  },
  resetVisualChannel: (channelId) => electron.ipcRenderer.invoke("studio:reset-visual-channel", channelId),
  patchDocument: (payload) => electron.ipcRenderer.invoke("studio:patch-document", payload),
  formatDocument: (source) => electron.ipcRenderer.invoke("studio:format-document", source),
  patchDeclaration: (payload) => electron.ipcRenderer.invoke("studio:patch-declaration", payload),
  patchGuiWidget: (payload) => electron.ipcRenderer.invoke("studio:patch-gui-widget", payload),
  patchProcess: (payload) => electron.ipcRenderer.invoke("studio:patch-process", payload),
  patchFunction: (payload) => electron.ipcRenderer.invoke("studio:patch-function", payload),
  patchInvariant: (payload) => electron.ipcRenderer.invoke("studio:patch-invariant", payload),
  patchExt: (payload) => electron.ipcRenderer.invoke("studio:patch-ext", payload),
  patchProcessSignature: (payload) => electron.ipcRenderer.invoke("studio:patch-process-signature", payload),
  patchFunctionSignature: (payload) => electron.ipcRenderer.invoke("studio:patch-function-signature", payload),
  patchAlias: (payload) => electron.ipcRenderer.invoke("studio:patch-alias", payload),
  patchModule: (payload) => electron.ipcRenderer.invoke("studio:patch-module", payload),
  patchProcessInit: (payload) => electron.ipcRenderer.invoke("studio:patch-process-init", payload),
  parsePredicateUi: (text) => electron.ipcRenderer.invoke("studio:parse-predicate-ui", text),
  uiToPredicateText: (node) => electron.ipcRenderer.invoke("studio:ui-to-predicate-text", node),
  validateSignature: (kind, signature) => electron.ipcRenderer.invoke("studio:validate-signature", kind, signature),
  searchWorkspaceFiles: (rootDir, query) => electron.ipcRenderer.invoke("studio:search-workspace-files", rootDir, query),
  searchWorkspaceSymbols: (rootDir, query) => electron.ipcRenderer.invoke("studio:search-workspace-symbols", rootDir, query),
  searchProjectText: (payload) => electron.ipcRenderer.invoke("studio:search-project-text", payload),
  openProjectFolder: () => electron.ipcRenderer.invoke("studio:open-project-folder"),
  revealInFolder: (filePath) => electron.ipcRenderer.invoke("studio:reveal-in-folder", filePath),
  buildInformalModel: (source, options) => electron.ipcRenderer.invoke("studio:build-informal-model", source, options),
  patchAspec: (payload) => electron.ipcRenderer.invoke("studio:patch-aspec", payload),
  refineAspec: (payload) => electron.ipcRenderer.invoke("studio:refine-aspec", payload),
  buildCoverageReport: (payload) => electron.ipcRenderer.invoke("studio:build-coverage-report", payload),
  patchInformal: (payload) => electron.ipcRenderer.invoke("studio:patch-informal", payload),
  buildHybridRegions: (source) => electron.ipcRenderer.invoke("studio:build-hybrid-regions", source),
  getInformalSpans: (source) => electron.ipcRenderer.invoke("studio:get-informal-spans", source),
  scanProject: (root) => electron.ipcRenderer.invoke("studio:scan-project", root),
  workspaceScan: (root) => electron.ipcRenderer.invoke("studio:workspace-scan", root),
  moduleHashes: (source) => electron.ipcRenderer.invoke("studio:module-hashes", source),
  modulesFromSource: (payload) => electron.ipcRenderer.invoke("studio:modules-from-source", {
    source: payload.source,
    filePath: payload.filePath,
    guiModule: payload.guiModule
  }),
  projectList: () => electron.ipcRenderer.invoke("studio:project-list"),
  projectCreate: (name) => electron.ipcRenderer.invoke("studio:project-create", name),
  projectCreateFromTemplate: (name, templateId) => electron.ipcRenderer.invoke("studio:project-create-from-template", name, templateId),
  projectOpenFolder: () => electron.ipcRenderer.invoke("studio:project-open-folder"),
  projectRemove: (projectId) => electron.ipcRenderer.invoke("studio:project-remove", projectId),
  projectRename: (projectId, name) => electron.ipcRenderer.invoke("studio:project-rename", projectId, name),
  projectTouch: (projectId) => electron.ipcRenderer.invoke("studio:project-touch", projectId),
  projectUiState: (projectId) => electron.ipcRenderer.invoke("studio:project-ui-state", projectId),
  projectSaveUiState: (projectId, state) => electron.ipcRenderer.invoke("studio:project-save-ui-state", projectId, state),
  projectCachedModules: (projectId) => electron.ipcRenderer.invoke("studio:project-cached-modules", projectId),
  projectCacheModules: (projectId, modules) => electron.ipcRenderer.invoke("studio:project-cache-modules", projectId, modules),
  writeTraceFile: (filePath, traceJson) => electron.ipcRenderer.invoke("studio:write-trace-file", filePath, traceJson),
  updateTraceContentHash: (tracePath, aspecSource) => electron.ipcRenderer.invoke("studio:update-trace-content-hash", { tracePath, aspecSource }),
  formatAspec: (source) => electron.ipcRenderer.invoke("studio:format-aspec", source),
  parseInformalSpec: (source, options) => electron.ipcRenderer.invoke("studio:parse-informal-spec", {
    source,
    projectRoot: options?.projectRoot,
    filePath: options?.filePath ?? void 0
  }),
  patchInformalSpec: (payload) => electron.ipcRenderer.invoke("studio:patch-informal-spec", JSON.parse(JSON.stringify(payload))),
  llmStatus: () => electron.ipcRenderer.invoke("studio:llm-status"),
  llmListProfiles: () => electron.ipcRenderer.invoke("studio:llm-list-profiles"),
  llmSaveProfile: (draft) => electron.ipcRenderer.invoke("studio:llm-save-profile", JSON.parse(JSON.stringify(draft))),
  llmDeleteProfile: (id) => electron.ipcRenderer.invoke("studio:llm-delete-profile", id),
  llmSetActiveProfile: (id) => electron.ipcRenderer.invoke("studio:llm-set-active-profile", id),
  llmExportProfiles: () => electron.ipcRenderer.invoke("studio:llm-export-profiles"),
  llmImportProfiles: (raw) => electron.ipcRenderer.invoke("studio:llm-import-profiles", raw),
  llmTestProfile: (request) => electron.ipcRenderer.invoke("studio:llm-test-profile", JSON.parse(JSON.stringify(request))),
  agentSkills: () => electron.ipcRenderer.invoke("studio:agent-skills"),
  agentListSessions: (projectRoot) => electron.ipcRenderer.invoke("studio:agent-list-sessions", projectRoot),
  agentCreateSession: (payload) => electron.ipcRenderer.invoke("studio:agent-create-session", payload),
  agentRenameSession: (payload) => electron.ipcRenderer.invoke("studio:agent-rename-session", payload),
  agentDeleteSession: (payload) => electron.ipcRenderer.invoke("studio:agent-delete-session", payload),
  agentLoadSession: (payload) => electron.ipcRenderer.invoke("studio:agent-load-session", payload),
  agentDuplicateSession: (payload) => electron.ipcRenderer.invoke("studio:agent-duplicate-session", payload),
  agentForkSession: (payload) => electron.ipcRenderer.invoke("studio:agent-fork-session", payload),
  agentRewindSession: (payload) => electron.ipcRenderer.invoke("studio:agent-rewind-session", payload),
  agentFlagSession: (payload) => electron.ipcRenderer.invoke("studio:agent-flag-session", payload),
  agentChat: (payload) => electron.ipcRenderer.invoke("studio:agent-chat", payload),
  agentResume: (payload) => electron.ipcRenderer.invoke("studio:agent-resume", payload),
  agentAbort: (sessionId) => electron.ipcRenderer.invoke("studio:agent-abort", sessionId),
  onAgentDelta: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on("studio:agent-delta", handler);
    return () => electron.ipcRenderer.removeListener("studio:agent-delta", handler);
  },
  listHybridGenerators: () => electron.ipcRenderer.invoke("studio:list-hybrid-generators"),
  generateHybrid: (payload) => electron.ipcRenderer.invoke("studio:generate-hybrid", JSON.parse(JSON.stringify(payload))),
  hybridInventory: (source) => electron.ipcRenderer.invoke("studio:hybrid-inventory", source),
  patchHybridSpec: (payload) => electron.ipcRenderer.invoke("studio:patch-hybrid-spec", JSON.parse(JSON.stringify(payload))),
  acceptHybridWrite: (payload) => electron.ipcRenderer.invoke("studio:accept-hybrid-write", payload),
  refinementStep: (payload) => electron.ipcRenderer.invoke("studio:refinement-step", JSON.parse(JSON.stringify(payload))),
  refinementState: (payload) => electron.ipcRenderer.invoke("studio:refinement-state", {
    source: payload.source,
    projectRoot: payload.projectRoot
  }),
  gitIsRepo: (rootPath) => electron.ipcRenderer.invoke("studio:git-is-repo", rootPath),
  gitStatus: (rootPath) => electron.ipcRenderer.invoke("studio:git-status", rootPath),
  gitInit: (rootPath) => electron.ipcRenderer.invoke("studio:git-init", rootPath),
  buildGuiModel: (payload) => electron.ipcRenderer.invoke("studio:build-gui-model", payload),
  patchGui: (payload) => electron.ipcRenderer.invoke("studio:patch-gui", payload),
  formatGui: (source) => electron.ipcRenderer.invoke("studio:format-gui", source),
  animateGuiProcess: (payload) => electron.ipcRenderer.invoke("studio:animate-gui-process", payload),
  resolveGuiForAspec: (payload) => electron.ipcRenderer.invoke("studio:resolve-gui-for-aspec", payload),
  patchAspecGui: (payload) => electron.ipcRenderer.invoke("studio:patch-aspec-gui", payload),
  findHybridSymbolSpan: (payload) => electron.ipcRenderer.invoke("studio:find-hybrid-symbol-span", payload)
};
electron.contextBridge.exposeInMainWorld("studio", studio);
