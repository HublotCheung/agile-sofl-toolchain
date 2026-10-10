import { acceptHybridWrite } from '../../shared/asflRepair'
import { ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProjectIndex, walk, textOf, parse, moduleSourceHashes, deriveFsf } from '@agile-sofl/parser'
import {
  buildModuleGraphLayout,
  buildVisualModelTolerant,
  patchFsfSpec,
  patchProcessCondition,
  patchComment,
  patchDecom,
  patchInvariant,
  addInvariant,
  removeInvariantInModule,
  removeInvariantByIndex,
  patchInvariantByIndex,
  reorderInvariants,
  patchDeclaration,
  patchProcess,
  patchFunction,
  patchExt,
  patchProcessSignature,
  patchFunctionSignature,
  patchAlias,
  patchProcessInit,
  patchModule,
  formatDocument,
  patchGuiWidgetText,
  findProcess,
  parsePredicateUi,
  uiToPredicateText,
  validateProcessSignature,
  validateFunctionSignature,
  type FsfScenarioDto,
  type ExtVarDto,
  patchInformal,
  buildHybridRegions,
  getInformalSpans,
  type DeclarationKind,
  applyHybridPatch,
  formatHybridInventory,
  type HybridPatch,
  type RefinementStep
} from '@agile-sofl/editor-api'
import {
  buildInformalModel,
  patchAspec,
  refineAspecWithCheck,
  buildCoverageReport,
  parseTraceJson,
  scanProject,
  formatAspec,
  updateTraceContentHash,
  parseAspec,
  parseInformalSpec,
  applyInformalSourcePatch,
  applyInformalMeta,
  aspecToInformal,
  listHybridGenerators,
  getHybridGenerator,
  registerLlmHybridGenerator,
  informalToHybridIR,
  normalizeHybridIR,
  irToGenerationResult,
  normalizeGenerateParams,
  stagesToScope,
  type PatchAspecAction,
  type InformalPatch,
  type GenerationScope,
  type HybridGenerateParams
} from '@agile-sofl/aspec'
import { chatEcnu } from './llm/chatEcnu.js'
import { migrateInformalSource, readInformalMeta } from './informalMeta.js'
import { applyProjectRefinementStep, projectRefinementState } from './refinementLog.js'
import {
  buildGuiModel,
  buildGuiModelFromAspec,
  patchGui,
  formatGui,
  embedGuiInAspec,
  extractGuiFromAspec,
  parseGuiSpec,
  serializeGuiSpec,
  guispecFromGuiSection,
  extendCoverageWithGui,
  matchScenarios,
  applyDefiningOutputs,
  type PatchGuiAction,
  type HybridProcessRef
} from '@agile-sofl/gui'
import { loadOrCreateManifest } from './projectManifest.js'
import type { ProjectFileInfo, ProjectModuleInfo, WorkspaceScanPayload } from '../../shared/projectTypes.js'
import { cloneForIpc } from './ipcClone.js'
import { isGuiModuleName, modulesFromSource } from '../../shared/modulesFromSource.js'

function collectHybridProcessRefs(asfl?: string): HybridProcessRef[] {
  if (!asfl?.trim()) return []
  const { ast } = parse(asfl)
  if (!ast || ast.type !== 'program') return []
  return ast.modules.flatMap((m) => {
    const vars = m.vars.map((v) => v.variable.name)
    return m.processes.map((p) => ({
      moduleName: m.name,
      processName: p.name,
      inputs: p.inputs.flatMap((g) => g.names),
      outputs: p.outputs.flatMap((g) => g.names),
      vars
    }))
  })
}

function collectAsflFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...collectAsflFiles(full))
    else if (entry.endsWith('.asfl')) out.push(full)
  }
  return out
}

export function isGuiModule(
  mod: { name: string; gui?: unknown },
  guiModule?: string
): boolean {
  return isGuiModuleName(mod, guiModule)
}

export async function scanWorkspaceProject(root: string): Promise<WorkspaceScanPayload> {
  const manifest = await loadOrCreateManifest(root)
  const files: ProjectFileInfo[] = [{ kind: 'manifest', path: join(root, '.agile-sofl.json') }]
  const informalAbs = join(root, manifest.informal)
  if (existsSync(informalAbs)) files.push({ kind: 'aspec', path: informalAbs })
  for (const rel of manifest.hybrid) {
    const abs = join(root, rel)
    if (existsSync(abs)) files.push({ kind: 'asfl', path: abs })
  }
  if (manifest.gui) {
    const abs = join(root, manifest.gui)
    if (existsSync(abs)) files.push({ kind: 'guispec', path: abs })
  }

  const modules: ProjectModuleInfo[] = []
  for (const file of files.filter((f) => f.kind === 'asfl')) {
    const source = readFileSync(file.path, 'utf-8')
    modules.push(...modulesFromSource(source, file.path, manifest.guiModule))
  }

  return { root, manifest, files, modules }
}

function toSerializableSpan(span: { start: number; end: number; line: number; column: number }) {
  return { start: span.start, end: span.end, line: span.line, column: span.column }
}

function ensureLlmHybridGenerator(): void {
  registerLlmHybridGenerator(async ({ system, user, json }) => {
    const result = await chatEcnu({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      json,
      temperature: 0.2
    })
    return result.content
  })
}

export function registerParseHandlers(): void {
  ensureLlmHybridGenerator()

  ipcMain.handle(
    'studio:parse-informal-spec',
    (
      _event,
      payload: string | { source: string; projectRoot?: string; filePath?: string }
    ) => {
      const input = typeof payload === 'string' ? { source: payload } : payload
      let source = input.source
      let meta = input.projectRoot ? readInformalMeta(input.projectRoot) ?? undefined : undefined
      if (input.projectRoot) {
        const migrated = migrateInformalSource(input.projectRoot, source)
        source = migrated.body
        meta = migrated.meta
      }
      const parsed = parseAspec(source, meta ? { meta } : undefined)
      if (parsed.informal) {
        return cloneForIpc({
          specification: parsed.informal,
          diagnostics: parsed.diagnostics,
          format: parsed.format ?? 'markdown',
          displaySource: source
        })
      }
      if (parsed.document) {
        return cloneForIpc({
          specification: aspecToInformal(parsed.document),
          diagnostics: parsed.diagnostics,
          format: parsed.format ?? 'yaml',
          displaySource: source
        })
      }
      return cloneForIpc({ ...parseInformalSpec(source, meta ? { meta } : undefined), displaySource: source })
    }
  )

  ipcMain.handle(
    'studio:patch-informal-spec',
    (_event, payload: { source: string; patch: InformalPatch }) =>
      cloneForIpc(applyInformalSourcePatch(payload.source, cloneForIpc(payload.patch)))
  )

  ipcMain.handle('studio:list-hybrid-generators', () =>
    cloneForIpc(listHybridGenerators().map((g) => ({ id: g.id, name: g.name, runtime: g.runtime ?? 'batch' })))
  )

  ipcMain.handle('studio:hybrid-inventory', (_event, source: string) =>
    cloneForIpc({ inventory: formatHybridInventory(typeof source === 'string' ? source : '') })
  )

  ipcMain.handle(
    'studio:accept-hybrid-write',
    (_event, payload: { before: string; after: string }) =>
      cloneForIpc(acceptHybridWrite(String(payload?.before ?? ''), String(payload?.after ?? '')))
  )

  ipcMain.handle(
    'studio:patch-hybrid-spec',
    (_event, payload: { source: string; patch: HybridPatch }) =>
      cloneForIpc(applyHybridPatch(payload.source, cloneForIpc(payload.patch)))
  )

  ipcMain.handle(
    'studio:refinement-step',
    (
      _event,
      payload: { source: string; projectRoot: string; step: RefinementStep }
    ) => cloneForIpc(applyProjectRefinementStep(payload.projectRoot, payload.source, cloneForIpc(payload.step)))
  )

  ipcMain.handle(
    'studio:refinement-state',
    (_event, payload: { source: string; projectRoot: string }) =>
      cloneForIpc(projectRefinementState(payload.projectRoot, payload.source))
  )

  ipcMain.handle(
    'studio:generate-hybrid',
    async (
      _event,
      payload: {
        source: string
        generatorId?: string
        projectName?: string
        projectRoot?: string
        existingAsfl?: string
        scope?: GenerationScope
        moduleName?: string
        processName?: string
        selectedNodeIds?: string[]
        specification?: unknown
        params?: Partial<HybridGenerateParams>
      }
    ) => {
      ensureLlmHybridGenerator()
      const parsed = parseAspec(payload.source, payload.projectRoot ? { meta: readInformalMeta(payload.projectRoot) ?? undefined } : undefined)
      const spec = parsed.informal ?? (parsed.document ? aspecToInformal(parsed.document) : null)
      if (!spec) return { ok: false as const, error: 'Informal specification could not be parsed.' }
      const sidecar = payload.projectRoot ? readInformalMeta(payload.projectRoot) : null
      if (sidecar) applyInformalMeta(spec, sidecar)
      const params = normalizeGenerateParams({
        ...payload.params,
        locale: payload.params?.locale ?? 'zh-CN'
      })
      const context = {
        projectName: payload.projectName,
        existingAsfl: payload.existingAsfl,
        scope: payload.scope ?? stagesToScope(params.stages),
        moduleName: payload.moduleName,
        processName: payload.processName,
        selectedNodeIds: payload.selectedNodeIds,
        params,
        locale: params.locale
      }
      try {
        if (payload.specification) {
          const fallback = informalToHybridIR(spec)
          const validated = normalizeHybridIR(payload.specification, fallback)
          const result = irToGenerationResult(spec, validated.ir, context)
          return cloneForIpc({
            ok: true as const,
            kind: 'document' as const,
            asflText: result.asflText,
            traceLinks: result.traceLinks,
            warnings: result.warnings,
            specification: result.specification,
            changes: result.changes
          })
        }
        const generator = getHybridGenerator(payload.generatorId || 'rule-based')
        if (!generator) return { ok: false as const, error: `Unknown generator "${payload.generatorId}".` }
        if (generator.runtime === 'agent') {
          const bootstrap = generator.agentBootstrap?.({ input: spec, params, context })
          if (!bootstrap) return { ok: false as const, error: 'Agent generator is missing agentBootstrap.' }
          return cloneForIpc({ ok: true as const, kind: 'agent-session' as const, bootstrap })
        }
        const result = await generator.generate(spec, context)
        return cloneForIpc({
          ok: true as const,
          kind: 'document' as const,
          asflText: result.asflText,
          traceLinks: result.traceLinks,
          warnings: result.warnings,
          specification: result.specification,
          changes: result.changes
        })
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('studio:build-visual-model', (_event, source: string, _channelId: string) => {
    const result = buildVisualModelTolerant(source)
    return cloneForIpc({
      parseFailed: result.parseFailed,
      hasDiagnostics: result.hasDiagnostics,
      documentModel: result.ast ? { modules: result.modules } : null,
      diagnostics: result.diagnostics,
      moduleGraph: result.moduleGraph,
      cdfdGraphs: result.cdfdGraphs,
      fsfModels: result.fsfModels,
      modules: result.modules
    })
  })

  ipcMain.handle('studio:reset-visual-channel', () => {
    /* tolerant build is stateless per request */
  })

  ipcMain.handle(
    'studio:build-module-graph-layout',
    (
      _event,
      graph: Parameters<typeof buildModuleGraphLayout>[0],
      options?: Parameters<typeof buildModuleGraphLayout>[1]
    ) => cloneForIpc(buildModuleGraphLayout(cloneForIpc(graph), options ?? {}))
  )

  ipcMain.handle('studio:format-document', (_event, source: string) => {
    return formatDocument(source)
  })

  ipcMain.handle(
    'studio:patch-document',
    (
      _event,
      payload: {
        source: string
        kind: 'fsf' | 'comment' | 'decom' | 'pre' | 'post'
        processName: string
        scenarios?: FsfScenarioDto[]
        others?: string
        text?: string
      }
    ) => {
      const { source, kind, processName } = payload
      switch (kind) {
        case 'fsf':
          return patchFsfSpec(source, processName, payload.scenarios ?? [], payload.others)
        case 'pre':
          return patchProcessCondition(source, processName, 'pre', payload.text ?? '')
        case 'post':
          return patchProcessCondition(source, processName, 'post', payload.text ?? '')
        case 'comment':
          return patchComment(source, processName, payload.text ?? '')
        case 'decom':
          return patchDecom(source, processName, payload.text ?? '')
        default:
          return source
      }
    }
  )

  ipcMain.handle(
    'studio:patch-declaration',
    (
      _event,
      payload: {
        source: string
        moduleName: string
        kind: DeclarationKind
        action: 'patch' | 'add' | 'remove'
        name?: string
        text?: string
      }
    ) => patchDeclaration(payload.source, payload)
  )

  ipcMain.handle(
    'studio:patch-gui-widget',
    (
      _event,
      payload: {
        source: string
        moduleName: string
        screenName: string
        widgetName: string
        text: string
      }
    ) => {
      const { ast } = parse(payload.source)
      if (!ast || ast.type !== 'program') return payload.source
      return (
        patchGuiWidgetText(
          payload.source,
          ast,
          payload.moduleName,
          payload.screenName,
          payload.widgetName,
          payload.text
        ) ?? payload.source
      )
    }
  )

  ipcMain.handle(
    'studio:patch-process',
    (
      _event,
      payload: {
        source: string
        moduleName: string
        kind: 'process' | 'function'
        action: 'add' | 'remove' | 'rename'
        name: string
        newName?: string
        template?: string
      }
    ) => patchProcess(payload.source, payload)
  )

  ipcMain.handle(
    'studio:patch-function',
    (
      _event,
      payload: {
        source: string
        moduleName: string
        name: string
        body?: string
        fsf?: { scenarios: FsfScenarioDto[]; others?: string }
      }
    ) => patchFunction(payload.source, payload)
  )

  ipcMain.handle('studio:find-process-has-fsf', (_event, source: string, processName: string) => {
    const { ast } = buildVisualModelTolerant(source)
    if (!ast) return false
    const proc = findProcess(ast, processName)
    return Boolean(proc?.body?.fsf)
  })

  ipcMain.handle(
    'studio:patch-invariant',
    (
      _event,
      payload: {
        source: string
        action?: 'patch' | 'add' | 'remove' | 'reorder'
        moduleName?: string
        span?: { start: number; end: number }
        index?: number
        text?: string
        fromIndex?: number
        toIndex?: number
      }
    ) => {
      const action = payload.action ?? 'patch'
      if (action === 'add' && payload.moduleName) {
        return addInvariant(payload.source, payload.moduleName, payload.text ?? 'true')
      }
      if (action === 'remove' && payload.moduleName) {
        if (typeof payload.index === 'number') {
          return removeInvariantByIndex(payload.source, payload.moduleName, payload.index)
        }
        if (payload.span) {
          return removeInvariantInModule(payload.source, payload.moduleName, payload.span)
        }
      }
      if (
        action === 'reorder' &&
        payload.moduleName &&
        typeof payload.fromIndex === 'number' &&
        typeof payload.toIndex === 'number'
      ) {
        return reorderInvariants(payload.source, payload.moduleName, payload.fromIndex, payload.toIndex)
      }
      if (
        action === 'patch' &&
        payload.moduleName &&
        typeof payload.index === 'number' &&
        payload.text != null
      ) {
        return patchInvariantByIndex(payload.source, payload.moduleName, payload.index, payload.text)
      }
      if (payload.span && payload.text != null) {
        return patchInvariant(payload.source, payload.span, payload.text)
      }
      return payload.source
    }
  )

  ipcMain.handle('studio:parse-predicate-ui', (_event, text: string) =>
    cloneForIpc(parsePredicateUi(text))
  )

  ipcMain.handle('studio:ui-to-predicate-text', (_event, node: Parameters<typeof uiToPredicateText>[0]) =>
    uiToPredicateText(node)
  )

  ipcMain.handle(
    'studio:validate-signature',
    (_event, kind: 'process' | 'function', signature: string) =>
      cloneForIpc(
        kind === 'process'
          ? validateProcessSignature(signature)
          : validateFunctionSignature(signature)
      )
  )

  ipcMain.handle(
    'studio:patch-ext',
    (
      _event,
      payload: { source: string; moduleName: string; processName: string; vars: ExtVarDto[] }
    ) => patchExt(payload.source, payload.moduleName, payload.processName, payload.vars)
  )

  ipcMain.handle(
    'studio:patch-process-signature',
    (
      _event,
      payload: { source: string; moduleName: string; processName: string; signature: string }
    ) => patchProcessSignature(payload.source, payload.moduleName, payload.processName, payload.signature)
  )

  ipcMain.handle(
    'studio:patch-function-signature',
    (
      _event,
      payload: { source: string; moduleName: string; functionName: string; signature: string }
    ) =>
      patchFunctionSignature(
        payload.source,
        payload.moduleName,
        payload.functionName,
        payload.signature
      )
  )

  ipcMain.handle(
    'studio:patch-alias',
    (
      _event,
      payload: { source: string; moduleName: string; processName: string; aliasTarget: string }
    ) => patchAlias(payload.source, payload.moduleName, payload.processName, payload.aliasTarget)
  )

  ipcMain.handle(
    'studio:patch-process-init',
    (
      _event,
      payload: {
        source: string
        moduleName: string
        processName: string
        isInit: boolean
        fallbackName?: string
      }
    ) =>
      patchProcessInit(
        payload.source,
        payload.moduleName,
        payload.processName,
        payload.isInit,
        payload.fallbackName
      )
  )

  ipcMain.handle(
    'studio:patch-module',
    (
      _event,
      payload: {
        source: string
        action: 'add' | 'remove' | 'rename'
        moduleName: string
        newName?: string
        parentName?: string
        isSystem?: boolean
      }
    ) => patchModule(payload.source, payload)
  )

  ipcMain.handle('studio:search-workspace-files', (_event, rootDir: string, query?: string) => {
    if (!rootDir || !existsSync(rootDir)) return []
    const needle = query?.trim().toLowerCase() ?? ''
    const files = collectAsflFiles(rootDir)
      .filter((path) => !needle || path.toLowerCase().includes(needle))
      .slice(0, 50)
    return cloneForIpc(files.map((path) => ({ path })))
  })

  ipcMain.handle('studio:search-workspace-symbols', (_event, rootDir: string, query?: string) => {
    if (!rootDir || !existsSync(rootDir)) return []
    const index = new ProjectIndex()
    index.scan(rootDir, (p) => pathToFileURL(p.replace(/\\/g, '/')).href)

    const needle = query?.trim().toLowerCase() ?? ''
    const results: Array<{
      uri: string
      name: string
      kind: string
      moduleName: string
      span: ReturnType<typeof toSerializableSpan>
      containerName?: string
    }> = []

    for (const sym of index.symbols(query)) {
      results.push({
        uri: sym.uri,
        name: sym.name,
        kind: sym.kind,
        moduleName: sym.moduleName,
        span: toSerializableSpan(sym.span),
        containerName: sym.containerName
      })
    }

    for (const doc of index.documents()) {
      if (!doc.ast || doc.ast.type !== 'program') continue
      walk(doc.ast, {
        enterModule(mod) {
          const label = moduleLabel(mod)
          for (const inv of mod.invariants) {
            const text = textOf(inv.condition).trim()
            const name = text.length > 48 ? text.slice(0, 47) + '…' : text || 'invariant'
            if (needle && !name.toLowerCase().includes(needle)) continue
            results.push({
              uri: doc.uri,
              name,
              kind: 'invariant',
              moduleName: mod.name,
              span: toSerializableSpan(inv.span),
              containerName: label
            })
          }
          for (const proc of mod.processes) {
            const fsf = proc.body?.fsf
            if (!fsf) continue
            const fsfName = `FSF (${proc.name})`
            if (!needle || fsfName.toLowerCase().includes(needle) || proc.name.toLowerCase().includes(needle)) {
              results.push({
                uri: doc.uri,
                name: fsfName,
                kind: 'fsf',
                moduleName: mod.name,
                span: toSerializableSpan(fsf.span),
                containerName: label
              })
            }
            fsf.scenarios.forEach((scenario, i) => {
              const test = textOf(scenario.test).trim()
              const name = test.length > 40 ? test.slice(0, 39) + '…' : test || `Scenario ${i + 1}`
              if (needle && !name.toLowerCase().includes(needle) && !proc.name.toLowerCase().includes(needle)) {
                return
              }
              results.push({
                uri: doc.uri,
                name: `${proc.name}: ${name}`,
                kind: 'fsf',
                moduleName: mod.name,
                span: toSerializableSpan(scenario.span),
                containerName: label
              })
            })
          }
        }
      })
    }

    return cloneForIpc(results)
  })

  ipcMain.handle(
    'studio:build-informal-model',
    (_event, source: string, options?: { bookAlignStrict?: boolean }) => {
      return cloneForIpc(buildInformalModel(source, options))
    }
  )

  ipcMain.handle('studio:patch-aspec', (_event, payload: { source: string } & PatchAspecAction) => {
    const { source, ...action } = payload
    return patchAspec(source, action as PatchAspecAction)
  })

  ipcMain.handle(
    'studio:refine-aspec',
    (
      _event,
      payload: {
        source: string
        aspecUri?: string
        asflUri?: string
        existingAsfl?: string
        skeletonOnly?: boolean
        mergePlans?: Array<{ aspecId: string; processName: string; strategy: string }>
        guiSource?: string
        emitGuiBlock?: boolean
      }
    ) => {
      const result = refineAspecWithCheck(payload.source, {
        aspecUri: payload.aspecUri,
        asflUri: payload.asflUri,
        preserveExisting: Boolean(payload.existingAsfl),
        existingAsfl: payload.existingAsfl,
        skeletonOnly: payload.skeletonOnly,
        mergePlans: payload.mergePlans,
        guiSource: payload.guiSource,
        emitGuiBlock: payload.emitGuiBlock
      })
      return cloneForIpc(result)
    }
  )

  ipcMain.handle(
    'studio:build-coverage-report',
    (_event, payload: { aspecSource: string; asflSource: string; traceJson?: string; guiSource?: string }) => {
      const trace = payload.traceJson ? parseTraceJson(payload.traceJson) : null
      const report = buildCoverageReport(payload.aspecSource, payload.asflSource, trace)
      if (payload.guiSource || payload.aspecSource.includes('\ngui:')) {
        const informalModules = buildInformalModel(payload.aspecSource).modules
        const guiModel = payload.guiSource
          ? buildGuiModel(payload.guiSource, {
              informalModules,
              hybridProcesses: collectHybridProcessRefs(payload.asflSource)
            })
          : buildGuiModelFromAspec(payload.aspecSource, payload.guiSource ?? null, informalModules)
        const processCovered = new Set(
          report.items.filter((i) => i.kind === 'process' && i.status === 'covered').map((i) => i.aspecId)
        )
        const guiItems = extendCoverageWithGui(guiModel, processCovered)
        for (const g of guiItems) {
          report.items.push({
            aspecId: g.aspecId,
            kind: g.kind,
            name: g.name,
            status: g.status,
            detail: g.detail
          })
          report.total++
          if (g.status === 'covered') report.covered++
          else if (g.status === 'partial') report.partial++
          else if (g.status === 'missing') report.missing++
        }
        report.percent = report.total === 0 ? 100 : Math.round((report.covered / report.total) * 100)
      }
      return cloneForIpc(report)
    }
  )

  ipcMain.handle('studio:patch-informal', (_event, payload: { source: string; span: { start: number; end: number }; text: string }) => {
    return patchInformal(payload.source, payload.span, payload.text)
  })

  ipcMain.handle('studio:build-hybrid-regions', (_event, source: string) => {
    const { ast } = parse(source)
    if (!ast || ast.type !== 'program') return []
    return cloneForIpc(buildHybridRegions(ast))
  })

  ipcMain.handle('studio:get-informal-spans', (_event, source: string) => {
    const { ast } = parse(source)
    if (!ast || ast.type !== 'program') return []
    return cloneForIpc(getInformalSpans(source, ast))
  })

  ipcMain.handle('studio:scan-project', async (_event, root: string) => {
    return cloneForIpc(await scanProject(root))
  })

  ipcMain.handle('studio:workspace-scan', async (_event, root: string) => {
    return cloneForIpc(await scanWorkspaceProject(root))
  })

  ipcMain.handle('studio:module-hashes', (_event, source: string) => {
    const { ast } = parse(source)
    if (!ast || ast.type !== 'program') return {}
    return moduleSourceHashes(source, ast)
  })

  ipcMain.handle(
    'studio:modules-from-source',
    (
      _event,
      payload: { source: string; filePath: string; guiModule?: string }
    ) => cloneForIpc(modulesFromSource(payload.source, payload.filePath, payload.guiModule))
  )

  ipcMain.handle('studio:write-trace-file', (_event, filePath: string, traceJson: string) => {
    writeFileSync(filePath, traceJson, 'utf8')
    return true
  })

  ipcMain.handle(
    'studio:update-trace-content-hash',
    (_event, payload: { tracePath: string; aspecSource: string }) => {
      if (!existsSync(payload.tracePath)) return false
      const existing = readFileSync(payload.tracePath, 'utf8')
      const updated = updateTraceContentHash(existing, payload.aspecSource)
      writeFileSync(payload.tracePath, updated, 'utf8')
      return true
    }
  )

  ipcMain.handle('studio:format-aspec', (_event, source: string) => formatAspec(source))

  ipcMain.handle(
    'studio:build-gui-model',
    (_event, payload: { source: string; informalSource?: string; hybridSource?: string }) => {
      const informalModules = payload.informalSource
        ? buildInformalModel(payload.informalSource).modules
        : undefined
      return cloneForIpc(
        buildGuiModel(payload.source, {
          informalModules,
          hybridProcesses: collectHybridProcessRefs(payload.hybridSource)
        })
      )
    }
  )

  ipcMain.handle('studio:patch-gui', (_event, payload: { source: string } & PatchGuiAction) => {
    const { source, ...action } = payload
    return patchGui(source, action as PatchGuiAction)
  })

  ipcMain.handle('studio:format-gui', (_event, source: string) => formatGui(source))

  ipcMain.handle(
    'studio:animate-gui-process',
    (
      _event,
      payload: {
        asfl: string
        process: string
        env: Record<string, string | number | boolean | null>
        scenarioId?: string
      }
    ) => {
      const { ast } = parse(payload.asfl)
      if (!ast || ast.type !== 'program') {
        return { process: payload.process, scenarios: [], matched: [], unevaluable: true, outputs: payload.env }
      }
      const dotted = payload.process.includes('.')
      const moduleName = dotted ? payload.process.slice(0, payload.process.lastIndexOf('.')) : undefined
      const procName = dotted ? payload.process.slice(payload.process.lastIndexOf('.') + 1) : payload.process
      let processNode = ast.modules.flatMap((m) => m.processes.map((p) => ({ m, p }))).find(({ m, p }) => {
        if (p.name !== procName) return false
        if (moduleName) return m.name === moduleName || m.name === moduleName.replace(/^SYSTEM_/, '')
        return true
      })
      if (!processNode) {
        return { process: payload.process, scenarios: [], matched: [], unevaluable: true, outputs: payload.env }
      }
      const form = deriveFsf(processNode.p)
      const scenarios = [
        ...(form?.scenarios ?? []),
        ...(form?.exceptionalScenarios ?? [])
      ].map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        guard: s.guard || s.testCondition || 'true',
        definingCondition: s.definingCondition
      }))
      if (payload.scenarioId) {
        const chosen = scenarios.find((s) => s.id === payload.scenarioId) ?? scenarios[0]
        const outputs = chosen
          ? applyDefiningOutputs(chosen.definingCondition, payload.env)
          : payload.env
        return {
          process: payload.process,
          scenarios,
          matched: chosen ? [chosen] : [],
          unevaluable: !chosen,
          outputs
        }
      }
      const result = matchScenarios(scenarios, payload.env)
      return { process: payload.process, scenarios, ...result }
    }
  )

  ipcMain.handle(
    'studio:resolve-gui-for-aspec',
    (_event, payload: { aspecSource: string; externalGuiSource?: string }) => {
      const model = buildGuiModelFromAspec(payload.aspecSource, payload.externalGuiSource ?? null)
      return cloneForIpc(model)
    }
  )

  ipcMain.handle(
    'studio:patch-aspec-gui',
    (_event, payload: { aspecSource: string; action: PatchGuiAction }) => {
      const embedded = extractGuiFromAspec(payload.aspecSource)
      const informal = buildInformalModel(payload.aspecSource)
      const base = embedded ?? {
        app: { name: informal.system.name || informal.meta.title || 'App' },
        screens: [],
        flows: []
      }
      const doc = guispecFromGuiSection(base, {
        id: `${informal.meta.id}-gui`,
        title: `${informal.meta.title} GUI`
      })
      const patched = patchGui(serializeGuiSpec(doc), payload.action)
      const { document: guiDoc } = parseGuiSpec(patched)
      if (!guiDoc) return payload.aspecSource
      return embedGuiInAspec(payload.aspecSource, guiDoc.gui)
    }
  )

  ipcMain.handle(
    'studio:find-hybrid-symbol-span',
    (_event, payload: { source: string; symbolName: string; kind?: 'process' | 'function' }) => {
      const { ast } = parse(payload.source)
      if (!ast || ast.type !== 'program') return null
      for (const mod of ast.modules) {
        if (payload.kind === 'function' || !payload.kind) {
          const fn = mod.functions.find((f) => f.name === payload.symbolName)
          if (fn) {
            return cloneForIpc({
              start: fn.span.start,
              end: fn.span.end,
              line: fn.span.line,
              column: fn.span.column
            })
          }
        }
        if (payload.kind === 'process' || !payload.kind) {
          const proc = findProcess(ast, payload.symbolName)
          if (proc) {
            return cloneForIpc({
              start: proc.span.start,
              end: proc.span.end,
              line: proc.span.line,
              column: proc.span.column
            })
          }
        }
      }
      return null
    }
  )
}
