/**
 * Renderer-safe subset of @agile-sofl/editor-api (no @agile-sofl/parser dependency).
 * Vite aliases `@agile-sofl/editor-api` to this module in the renderer bundle.
 */
export { namesEqual, canonicalModuleName, labelsMatch, uniqueSlug } from '../../../../editor-api/src/hybridIds.js'
export {
  countBySeverity,
  mergeDiagnostics,
  adjustFsfDiagnosticSeverity,
  adjustRefinementDiagnosticSeverity,
  hasBlockingHybridDiagnostics
} from '../../../../editor-api/src/mergeDiagnostics.js'
export { filterDiagnosticsBySelection } from '../../../../editor-api/src/filterDiagnostics.js'
export { buildModuleGraphLayout, decorateProcessLabel } from '../../../../editor-api/src/moduleGraphLayout.js'
export { layoutCdfdGraph } from '../../../../editor-api/src/cdfdLayout.js'
export type { CdfdGraph } from '../../../../editor-api/src/cdfdGraph.js'
export type { CdfdLayout } from '../../../../editor-api/src/cdfdLayout.js'
export {
  SPEC_MAP_KINDS,
  PRIMARY_NODE_LIMIT,
  isSpecMapKind,
  structureModeFromChrome,
  buildSpecMap,
  buildSpecMaps,
  layoutSpecMap
} from '../../../../editor-api/src/specMaps/index.js'
export type {
  SpecMapKind,
  SpecMap,
  SpecMapRef,
  SpecMapEmptyReason,
  SpecMapSource,
  SpecMapLayout,
  SpecMapSemanticKind,
  InformalMapInput,
  InformalMapNode,
  GuiMapInput,
  HybridMapInput
} from '../../../../editor-api/src/specMaps/index.js'
export type {
  MergedDiagnostic,
  DiagnosticSource
} from '../../../../editor-api/src/mergeDiagnostics.js'
export type {
  DiagnosticLike,
  SelectionFilterInput,
  ModuleSpanIndex
} from '../../../../editor-api/src/filterDiagnostics.js'
export type {
  ModuleGraph,
  ModuleGraphNode,
  ModuleGraphEdge,
  ModuleGraphNodeRole
} from '../../../../editor-api/src/moduleGraph.js'
export type {
  ModuleGraphLayoutOptions,
  ModuleGraphModuleSize,
  ProcessNodeMeta
} from '../../../../editor-api/src/moduleGraphLayout.js'
