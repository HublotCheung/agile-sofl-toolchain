export type HistorySelection = {
  moduleName?: string | null
  informalNodeId?: string | null
}

export type HistoryMutation = {
  tabId: string
  filePath?: string
  before: string
  after: string
}

export type HistoryEffect = { key: string; before: string; after: string }

export type HistoryCommitInput = {
  effects?: HistoryEffect[]
  kind: string
  mutations: HistoryMutation[]
  label?: string
  labelParams?: Record<string, unknown>
  coalesceKey?: string
  immediate?: boolean
  selectionBefore?: HistorySelection
  selectionAfter?: HistorySelection
}

export type HistoryCommand = {
  effects?: HistoryEffect[]
  id: string
  kind: string
  label?: string
  labelParams?: Record<string, unknown>
  coalesceKey?: string | null
  timestamp: number
  mutations: HistoryMutation[]
  selectionBefore?: HistorySelection
  selectionAfter?: HistorySelection
}

export type HistoryKindDefinition = {
  id: string
  labelKey: string
  /** Module add/rename/delete and similar structural edits. */
  affectsWorkspace?: boolean
}

export type ApplyDocumentOptions = Omit<HistoryCommitInput, 'mutations'> & {
  kind?: string
}
