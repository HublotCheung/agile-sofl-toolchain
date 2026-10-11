import type { HistoryKindDefinition } from './types'

export const HistoryKinds = {
  documentEdit: 'document-edit',
  informalEdit: 'informal-edit',
  hybridEdit: 'hybrid-edit',
  visualPatch: 'visual-patch',
  guiEdit: 'gui-edit',
  moduleAdd: 'module-add',
  moduleRename: 'module-rename',
  moduleDelete: 'module-delete',
  searchReplace: 'search-replace'
} as const

export type HistoryKind = (typeof HistoryKinds)[keyof typeof HistoryKinds]

const registry = new Map<string, HistoryKindDefinition>()

export function registerHistoryKind(def: HistoryKindDefinition): void {
  registry.set(def.id, def)
}

export function getHistoryKind(id: string): HistoryKindDefinition | undefined {
  return registry.get(id)
}

export function historyCommandTitle(
  cmd: { kind: string; label?: string; labelParams?: Record<string, unknown> },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (cmd.label) return cmd.label
  const def = getHistoryKind(cmd.kind)
  return t(def?.labelKey ?? 'history.kind.documentEdit', cmd.labelParams ?? {})
}

export function historyKindForDocument(documentKind?: string): string {
  if (documentKind === 'aspec') return HistoryKinds.informalEdit
  if (documentKind === 'guispec') return HistoryKinds.guiEdit
  if (documentKind === 'asfl') return HistoryKinds.hybridEdit
  return HistoryKinds.documentEdit
}

const builtins: HistoryKindDefinition[] = [
  { id: HistoryKinds.documentEdit, labelKey: 'history.kind.documentEdit' },
  { id: HistoryKinds.informalEdit, labelKey: 'history.kind.informalEdit' },
  { id: HistoryKinds.hybridEdit, labelKey: 'history.kind.hybridEdit' },
  { id: HistoryKinds.visualPatch, labelKey: 'history.kind.visualPatch' },
  { id: HistoryKinds.guiEdit, labelKey: 'history.kind.guiEdit' },
  { id: HistoryKinds.moduleAdd, labelKey: 'history.kind.moduleAdd', affectsWorkspace: true },
  { id: HistoryKinds.moduleRename, labelKey: 'history.kind.moduleRename', affectsWorkspace: true },
  { id: HistoryKinds.moduleDelete, labelKey: 'history.kind.moduleDelete', affectsWorkspace: true },
  { id: HistoryKinds.searchReplace, labelKey: 'history.kind.searchReplace' }
]

for (const def of builtins) registerHistoryKind(def)
