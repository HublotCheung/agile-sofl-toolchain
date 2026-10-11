export type {
  GuiDocument,
  GuiDocumentModel,
  GuiScreen,
  GuiScreenDto,
  GuiWidget,
  GuiWidgetKind,
  GuiWidgetEvent,
  GuiBounds,
  GuiViewSize,
  GuiFlow,
  GuiSection,
  GuiApp,
  GuiMeta,
  GuiBinds,
  GuiBindRef,
  GuiDiagnostic,
  InformalProcessRef,
  InformalVariableRef,
  HybridProcessRef
} from './model.js'

export { parseGuiSpec, parseGuiFromAspecYaml } from './parse.js'
export type { ParseResult } from './parse.js'

export { validateGuiSpec } from './validate.js'
export { serializeGuiSpec, formatGuiSpec, guiSectionToYaml } from './serialize.js'

export {
  patchGui,
  patchFieldById,
  addGuiScreen,
  removeGuiScreen,
  addGuiWidget,
  removeGuiWidget,
  addGuiFlow,
  removeGuiFlow,
  extractGuiFromAspec,
  embedGuiInAspec,
  removeGuiFromAspec,
  mergeGuiSources,
  guispecFromGuiSection,
  formatGui,
  defaultGuiHtml,
  extractScreenHtml,
  wrapPrototypeHtml,
  patchHtmlNode,
  insertHtml,
  removeHtmlNode
} from './patch.js'
export type { PatchGuiAction } from './patch.js'

export {
  buildGuiModel,
  buildGuiModelFromAspec,
  buildGuiModelTolerant,
  collectProcessRefs,
  collectVariableRefs
} from './buildGuiModel.js'

export { DiagnosticCodes, createDiagnostic } from './diagnostics/codes.js'
export { extendCoverageWithGui, buildGuiTraceLinks } from './trace/coverageGui.js'
export { formatGuiInventory, formatGuiModelInventory, numberedGuiSource } from './inventory.js'
export { buildSlimGuiBlock, buildSlimGuiBlockFromHtml } from './asflTrace.js'
export {
  evalSimpleCondition,
  matchScenarios,
  applyDefiningOutputs
} from './scenarioEval.js'
export type { ScenarioCandidate, ScenarioMatchResult, EvalValue } from './scenarioEval.js'
export { prototypeStylesheet } from './stylesheet.js'
export { buildPrototypeSrcdoc, GUI_IFRAME_SANDBOX, GUI_SANDBOX_CHANNEL } from './prototypeDoc.js'
export {
  ALLOWED_TAGS,
  ALLOWED_CLASSES,
  ALLOWED_ATTRS,
  GUI_HTML_VERSION,
  emptyGuiHtml,
  looksLikeYamlGui
} from './dialect.js'
export { parseHtmlFragment, sanitizeHtml, findElements, listHtmlTree, findTreeItem } from './html.js'
export type { HtmlNode, HtmlTreeItem } from './html.js'
export { parseBindAttr } from './project.js'
export { tryParseYamlGui, migrateYamlDocument } from './migrate.js'
