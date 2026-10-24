export {
  buildDocumentModel,
  buildHybridRegions,
  collectHybridRegions,
  buildSymbolIndex,
  findProcess
} from './documentModel.js'
export type {
  DocumentModel,
  ModuleSummary,
  DiagnosticSummary,
  HybridRegion
} from './documentModel.js'

export {
  buildFsfModel,
  buildFsfModelFromSpec,
  buildAllFsfModels,
  buildFsfModelByName
} from './fsfModel.js'
export type { FsfScenarioDto, FsfModelDto } from './fsfModel.js'

export { buildModuleGraph, drawableGraphEdges, resolveDecomTargetId } from './moduleGraph.js'
export type {
  ModuleGraph,
  ModuleGraphNode,
  ModuleGraphEdge,
  ModuleGraphNodeKind,
  ModuleGraphNodeRole
} from './moduleGraph.js'

export { buildModuleGraphLayout, decorateProcessLabel } from './moduleGraphLayout.js'
export type {
  CompoundModule,
  CompoundRow,
  CompoundSection,
  ModuleGraphLayout,
  ModuleGraphLayoutOptions,
  ModuleGraphLayoutOrientation,
  ModuleGraphModuleSize,
  ProcessNodeMeta,
  DrawableGraphEdge
} from './moduleGraphLayout.js'

export { filterDiagnosticsBySelection } from './filterDiagnostics.js'
export type {
  DiagnosticLike,
  SelectionFilterInput,
  ModuleSpanIndex
} from './filterDiagnostics.js'

export {
  mergeDiagnostics,
  countBySeverity,
  adjustFsfDiagnosticSeverity,
  adjustRefinementDiagnosticSeverity,
  hasBlockingHybridDiagnostics
} from './mergeDiagnostics.js'
export type { MergedDiagnostic, DiagnosticSource } from './mergeDiagnostics.js'

export {
  parsePredicateFragment,
  predicateToUi,
  printPredicateText,
  uiToPredicateText,
  parsePredicateUi,
  filterSymbolHints
} from './predicateModel.js'
export type { PredicateUiNode, ParsePredicateResult, SymbolHint } from './predicateModel.js'

export { buildVisualModelTolerant } from './visualParse.js'
export type { VisualModelResult, VisualParseDiagnostic, FsfFormalStatus, FormalizationStatus } from './visualParse.js'

export {
  processSignatureText,
  functionSignatureText,
  paramGroupsFromNodes,
  buildProcessSignatureFromGroups,
  buildFunctionSignatureFromGroups
} from './signatureUtils.js'
export type { ParamGroupDto } from './signatureUtils.js'

export { patchExt } from './extPatch.js'
export type { ExtVarDto } from './extPatch.js'

export {
  patchProcessSignature,
  patchFunctionSignature,
  validateProcessSignature,
  validateFunctionSignature
} from './signaturePatch.js'
export type { SignatureValidationResult } from './signaturePatch.js'

export {
  addModule,
  removeModule,
  renameModule,
  patchModule,
  setModuleParent,
  stripOrphanParents
} from './modulePatch.js'
export type { ModulePatchAction } from './modulePatch.js'

export {
  patchFsfSpec,
  patchProcessFsfText,
  patchProcessCondition,
  patchComment,
  patchDecom,
  patchInformal,
  patchInvariant,
  formatDocument,
  getInformalSpans
} from './patch.js'

export {
  addInvariant,
  removeInvariantInModule,
  removeInvariantByIndex,
  patchInvariantByIndex,
  reorderInvariants
} from './invariantPatch.js'

export { VISUAL_DUPLICATE_CODE, collectVisualDuplicateDiagnostics } from './visualDuplicateDiagnostics.js'

export {
  patchConst,
  addConst,
  removeConst,
  patchType,
  addType,
  removeType,
  patchVar,
  addVar,
  removeVar,
  patchDeclaration
} from './declarationPatch.js'
export type { DeclarationKind } from './declarationPatch.js'

export {
  addProcess,
  removeProcess,
  renameProcess,
  addFunction,
  removeFunction,
  renameFunction,
  patchAlias,
  patchProcessInit,
  patchProcess,
  patchFunction
} from './processPatch.js'
export type { ProcessPatchAction, FunctionPatchAction } from './processPatch.js'

export { patchGuiWidgetText, addGuiScreen } from './guiPatch.js'
export { toSerializableSpan, sliceText } from './span.js'

export {
  SPEC_MAP_KINDS,
  PRIMARY_NODE_LIMIT,
  isSpecMapKind,
  structureModeFromChrome,
  capSpecMap,
  emptySpecMap,
  mapId,
  buildSpecMap,
  buildSpecMaps,
  layoutSpecMap
} from './specMaps/index.js'
export type {
  SpecMapKind,
  SpecMapSemanticKind,
  SpecMapEdgeKind,
  SpecMapEmptyReason,
  SpecMapRef,
  SpecMapNode,
  SpecMapEdge,
  SpecMapLane,
  SpecMap,
  HybridMapInput,
  HybridModuleInput,
  HybridProcessInput,
  HybridFsfInput,
  InformalMapNode,
  InformalMapInput,
  GuiMapInput,
  GuiMapWidget,
  SpecMapSource,
  SpecMapBBox,
  SpecMapLayout,
  SpecMapLayoutNode,
  SpecMapLayoutEdge,
  SpecMapLayoutLane
} from './specMaps/index.js'

export {
  parseHybridId,
  formatHybridId,
  slug,
  uniqueSlug,
  canonicalModuleName,
  namesEqual,
  labelsMatch
} from './hybridIds.js'
export type { HybridIdKind, ParsedHybridId } from './hybridIds.js'

export {
  formatHybridInventory,
  hybridInventoryFromSource,
  formatHybridDiagnostics,
  collectHybridAgentDiagnostics,
  collectHybridWriteLintDiagnostics
} from './hybridInventory.js'
export type { HybridAgentDiagnostic } from './hybridInventory.js'

export { applyHybridPatch } from './hybridPatch.js'
export type { HybridEntityKind, HybridPatchOp, HybridPatch, HybridScenarioInput } from './hybridPatch.js'
export type { SerializableSpan } from './span.js'

export { buildCdfdGraph, buildAllCdfdGraphs } from './cdfdGraph.js'
export type { CdfdGraph, CdfdGraphNode, CdfdGraphEdge, CdfdNodeKind } from './cdfdGraph.js'
export { layoutCdfdGraph } from './cdfdLayout.js'
export type { CdfdLayout, CdfdLayoutNode, CdfdLayoutEdge } from './cdfdLayout.js'
export { patchCdfdBlock, addCdfdFlow } from './cdfdPatch.js'
export {
  applyRefinementStep,
  buildRefinementState,
  dualLineRates,
  formatRefinementDigest,
  parseRefinementLog,
  serializeRefinementLog,
  decomposeProcess
} from './refinement.js'
export type {
  RefinementStep,
  RefinementStepKind,
  RefinementLogEntry,
  RefinementState,
  RefinementProcessRow,
  RefinementModuleRow,
  ProcessAmbiguityBreakdown,
  DataRefinementItemView,
  DataItemKind,
  AtomicityStatus,
  RefinementDigestView,
  DualLineRates
} from './refinement.js'
export type { AuthorTextNote } from '@agile-sofl/parser'

export {
  ProjectIndex,
  createProjectIndex,
  checkIncremental,
  createIncrementalState,
  getChangedModules,
  check,
  parse,
  parseSpecification,
  formatDiagnostic
} from '@agile-sofl/parser'
export type {
  ProjectDocument,
  ProjectSymbol,
  DefinitionLocation,
  IncrementalCheckState,
  ProgramNode,
  ProcessNode,
  Diagnostic
} from '@agile-sofl/parser'
