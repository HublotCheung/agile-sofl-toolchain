import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { getHistoryKind } from '../history/kinds'
import type {
  ApplyDocumentOptions,
  HistoryCommand,
  HistoryCommitInput,
  HistoryMutation,
  HistoryEffect,
  HistorySelection
} from '../history/types'
import { useDocumentStore } from './document'
import { filePathsEqual } from './tabUtils'
import { useWorkspaceStore } from './workspace'

const MAX_STACK = 100
const DEBOUNCE_MS = 300
const COALESCE_MS = 2000

type PendingCommit = HistoryCommitInput & { timer: ReturnType<typeof setTimeout> }

export const useHistoryStore = defineStore('studioHistory', () => {
  const undoStack = ref<HistoryCommand[]>([])
  const redoStack = ref<HistoryCommand[]>([])
  const applying = ref(false)
  const pending = shallowRef<PendingCommit | null>(null)
  const flushers = new Set<() => void | Promise<void>>()
  const effectHandlers = new Map<string, (value: string) => void | Promise<void>>()
  function registerEffect(key: string, handler: (value: string) => void | Promise<void>): () => void {
    effectHandlers.set(key, handler)
    return () => { effectHandlers.delete(key) }
  }
  async function applyEffects(cmd: HistoryCommand, side: 'before' | 'after'): Promise<void> {
    const effects = side === 'before' ? [...(cmd.effects ?? [])].reverse() : cmd.effects ?? []
    for (const effect of effects) {
      const handler = effectHandlers.get(effect.key)
      if (!handler) throw new Error('History metadata handler unavailable.')
      await handler(effect[side])
    }
  }
  let nextId = 1

  const canUndo = computed(() => undoStack.value.length > 0 || pending.value !== null)
  const canRedo = computed(() => redoStack.value.length > 0)

  function commandLabel(cmd: HistoryCommand | null | undefined): string | null {
    if (!cmd) return null
    if (cmd.label) return cmd.label
    return getHistoryKind(cmd.kind)?.labelKey ?? cmd.kind
  }

  const undoCommand = computed<HistoryCommand | null>(() => {
    const open = pending.value
    if (open) {
      return {
        id: 'pending',
        kind: open.kind,
        label: open.label,
        labelParams: open.labelParams,
        coalesceKey: open.coalesceKey ?? null,
        timestamp: 0,
        mutations: open.mutations,
        selectionBefore: open.selectionBefore,
        selectionAfter: open.selectionAfter
      }
    }
    return undoStack.value[undoStack.value.length - 1] ?? null
  })
  const redoCommand = computed(() => redoStack.value[redoStack.value.length - 1] ?? null)

  const undoLabel = computed(() => commandLabel(undoCommand.value))
  const redoLabel = computed(() => commandLabel(redoCommand.value))

  function registerFlusher(fn: () => void | Promise<void>): () => void {
    flushers.add(fn)
    return () => {
      flushers.delete(fn)
    }
  }

  function currentSelection(): HistorySelection {
    const ws = useWorkspaceStore()
    return {
      moduleName: ws.selectedModuleName,
      informalNodeId: ws.informalSelectedNodeId
    }
  }

  function findTab(mutation: HistoryMutation) {
    const doc = useDocumentStore()
    const byId = doc.tabs.find((t) => t.id === mutation.tabId && t.kind === 'document')
    if (byId) return byId
    if (!mutation.filePath) return undefined
    return doc.documentTabs.find((t) => t.filePath && filePathsEqual(t.filePath, mutation.filePath!))
  }

  function restoreSelection(sel: HistorySelection | undefined): void {
    if (!sel) return
    const ws = useWorkspaceStore()
    if (sel.moduleName !== undefined && sel.moduleName !== ws.selectedModuleName) {
      ws.selectedModuleName = sel.moduleName
      ws.selection = sel.moduleName ? { kind: 'module', moduleName: sel.moduleName } : null
    }
    if (sel.informalNodeId !== undefined) {
      ws.informalSelectedNodeId = sel.informalNodeId
    }
  }

  function applyMutations(mutations: HistoryMutation[], side: 'before' | 'after'): void {
    const doc = useDocumentStore()
    for (const mutation of mutations) {
      const tab = findTab(mutation)
      if (!tab) continue
      doc.setContent(tab.id, mutation[side])
      doc.setActive(tab.id)
    }
  }

  function sameTargets(a: HistoryMutation[], b: HistoryMutation[]): boolean {
    if (a.length !== b.length) return false
    return a.every((m, i) => m.tabId === b[i]?.tabId)
  }

  function mergeMutations(base: HistoryMutation[], next: HistoryMutation[]): HistoryMutation[] {
    return next.map((incoming, i) => {
      const prev = base[i]
      if (!prev || prev.tabId !== incoming.tabId) return incoming
      return { ...prev, after: incoming.after, filePath: incoming.filePath ?? prev.filePath }
    })
  }

  function toCommand(input: HistoryCommitInput): HistoryCommand {
    return {
      id: `hist_${nextId++}`,
      kind: input.kind,
      label: input.label,
      labelParams: input.labelParams,
      coalesceKey: input.coalesceKey ?? null,
      timestamp: Date.now(),
      effects: input.effects,
      mutations: input.mutations.map((m) => ({ ...m })),
      selectionBefore: input.selectionBefore,
      selectionAfter: input.selectionAfter
    }
  }

  function pushOrCoalesce(input: HistoryCommitInput): void {
    const last = undoStack.value[undoStack.value.length - 1]
    const now = Date.now()
    const canCoalesce = Boolean(
      !input.effects?.length && !last?.effects?.length && input.coalesceKey &&
        last &&
        last.coalesceKey === input.coalesceKey &&
        now - last.timestamp < COALESCE_MS &&
        sameTargets(last.mutations, input.mutations)
    )
    if (canCoalesce && last) {
      last.mutations = mergeMutations(last.mutations, input.mutations)
      last.selectionAfter = input.selectionAfter ?? last.selectionAfter
      last.timestamp = now
      if (input.label) last.label = input.label
      if (input.labelParams) last.labelParams = input.labelParams
      redoStack.value = []
      return
    }
    undoStack.value.push(toCommand(input))
    if (undoStack.value.length > MAX_STACK) undoStack.value.shift()
    redoStack.value = []
  }

  function scheduleCommit(input: HistoryCommitInput): void {
    const key = `${input.mutations.map((m) => m.tabId).join(',')}:${input.coalesceKey ?? ''}`
    const current = pending.value
    const pendingKey = current
      ? `${current.mutations.map((m) => m.tabId).join(',')}:${current.coalesceKey ?? ''}`
      : null
    if (current && pendingKey !== key) {
      flushPending()
    }
    const open = pending.value
    if (open && `${open.mutations.map((m) => m.tabId).join(',')}:${open.coalesceKey ?? ''}` === key) {
      clearTimeout(open.timer)
      open.mutations = mergeMutations(open.mutations, input.mutations)
      open.selectionAfter = input.selectionAfter ?? open.selectionAfter
      open.label = input.label ?? open.label
      open.labelParams = input.labelParams ?? open.labelParams
      open.timer = setTimeout(() => {
        flushPending()
      }, DEBOUNCE_MS)
      return
    }
    pending.value = {
      ...input,
      effects: input.effects,
      mutations: input.mutations.map((m) => ({ ...m })),
      timer: setTimeout(() => {
        flushPending()
      }, DEBOUNCE_MS)
    }
  }

  function flushPending(): void {
    const current = pending.value
    if (!current) return
    const { timer, ...input } = current
    clearTimeout(timer)
    pending.value = null
    if (input.mutations.every((m) => m.before === m.after) && !input.effects?.length) return
    pushOrCoalesce(input)
  }

  async function flushRegistered(): Promise<void> {
    for (const fn of [...flushers]) {
      await fn()
    }
    flushPending()
  }

  function commit(input: HistoryCommitInput): void {
    if (applying.value) return
    const mutations = input.mutations.filter((m) => m.before !== m.after)
    if (mutations.length === 0 && !input.effects?.length) return
    const payload: HistoryCommitInput = {
      ...input,
      mutations,
      selectionBefore: input.selectionBefore ?? currentSelection(),
      selectionAfter: input.selectionAfter ?? currentSelection()
    }
    if (input.immediate) {
      if (pending.value) flushPending()
      pushOrCoalesce(payload)
      return
    }
    scheduleCommit(payload)
  }

  function attachEffects(commandId: string, effects: HistoryEffect[]): boolean {
    const command = undoStack.value[undoStack.value.length - 1]
    if (pending.value || applying.value || !command || command.id !== commandId) return false
    command.effects = [...(command.effects ?? []), ...effects]
    return true
  }

  function applyDocument(tabId: string, after: string, options?: ApplyDocumentOptions): boolean {
    if (applying.value) return false
    const doc = useDocumentStore()
    const tab = doc.tabs.find((t) => t.id === tabId && t.kind === 'document')
    if (!tab) return false
    const before = tab.content
    if (before === after) return false
    doc.setContent(tab.id, after)
    commit({
      kind: options?.kind ?? 'document-edit',
      label: options?.label,
      labelParams: options?.labelParams,
      coalesceKey: options?.coalesceKey,
      immediate: options?.immediate,
      selectionBefore: options?.selectionBefore,
      selectionAfter: options?.selectionAfter,
      mutations: [
        {
          tabId: tab.id,
          filePath: tab.filePath ?? undefined,
          before,
          after
        }
      ]
    })
    return true
  }

  async function undo(): Promise<boolean> {
    if (applying.value) return false
    await flushRegistered()
    if (applying.value) return false
    const cmd = undoStack.value[undoStack.value.length - 1]
    if (!cmd) return false
    applying.value = true
    try {
      await applyEffects(cmd, 'before')
      undoStack.value.pop()
      applyMutations(cmd.mutations, 'before')
      restoreSelection(cmd.selectionBefore)
      redoStack.value.push(cmd)
    } finally {
      applying.value = false
    }
    return true
  }

  async function redo(): Promise<boolean> {
    if (applying.value) return false
    await flushRegistered()
    if (applying.value) return false
    const cmd = redoStack.value[redoStack.value.length - 1]
    if (!cmd) return false
    applying.value = true
    try {
      await applyEffects(cmd, 'after')
      redoStack.value.pop()
      applyMutations(cmd.mutations, 'after')
      restoreSelection(cmd.selectionAfter)
      undoStack.value.push(cmd)
    } finally {
      applying.value = false
    }
    return true
  }

  function clear(): void {
    if (pending.value) {
      clearTimeout(pending.value.timer)
      pending.value = null
    }
    undoStack.value = []
    redoStack.value = []
  }

  return {
    applying,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    undoCommand,
    redoCommand,
    undoStack,
    redoStack,
    registerFlusher,
    registerEffect,
    commit,
    attachEffects,
    applyDocument,
    flushPending,
    flushRegistered,
    undo,
    redo,
    clear,
    commandLabel
  }
})
