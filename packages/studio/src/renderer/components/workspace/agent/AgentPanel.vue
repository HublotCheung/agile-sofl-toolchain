<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useSettingsStore } from '../../../stores/settings'
import { useModalStore } from '../../../stores/modal'
import type {
  AgentSessionPayload,
  AgentSpecPermissionsPayload,
  HybridAgentBootstrapPayload,
  InformalPatchPayload
} from '../../../../preload/index'
import { consumeAgentLaunchPending, subscribeAgentLaunch } from '../../../lib/agentLaunchBus'
import { toIpcValue } from '../../../lib/toIpcValue'
import { applyGuiDocumentPatch } from '../../../lib/applyGuiDocumentPatch'
import ClarificationCard from './ClarificationCard.vue'
import AgentMarkdownPreview from './AgentMarkdownPreview.vue'
import PatchPreview from './PatchPreview.vue'
import AgentSessionDialog from './AgentSessionDialog.vue'
import AgentToolActivity from './AgentToolActivity.vue'
import StudioIcon from '../../ui/StudioIcon.vue'
import IconActionButton from '../../ui/IconActionButton.vue'
import ResizeSplit from '../../ui/ResizeSplit.vue'
import { toggleClarificationDraft, type ClarificationDraft } from './clarificationDraft'
import {
  composeClarificationAnswer,
  encodeClarificationAnswer,
  mergeClarificationCustom
} from '../../../../shared/clarificationAnswer'
import { contextMenuPoint } from '../../../lib/contextMenuPoint'
import {
  composerAction,
  enqueueMessage,
  removeQueuedMessage,
  sessionStillRunning,
  shiftQueuedMessage,
  shouldAutoFlushQueue,
  takeQueuedMessage,
  updateQueuedMessage,
  type AgentQueuedMessage
} from './agentQueue'
import {
  activeToolCall,
  formatToolArgsSize,
  isThinkingLive,
  resolvedToolStatus,
  shouldShowThinkingPlaceholder,
  toolLabelKey,
  upsertToolCall
} from './agentToolUx'

type MenuAction = 'copy' | 'rename' | 'delete' | 'pin' | 'archive'
type AgentMessageView = AgentSessionPayload['messages'][0]

const props = defineProps<{
  informalMarkdown: string
  onApplyPatch: (patch: InformalPatchPayload) => Promise<{ ok: boolean; error?: string; applied?: boolean; repairNotes?: string[] }>
  onApplyHybridPatch: (
    patch: InformalPatchPayload
  ) => Promise<{ ok: boolean; error?: string; applied?: boolean; repairNotes?: string[] }>
  embedInDock?: boolean
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const settings = useSettingsStore()
const modal = useModalStore()
const sessions = ref<AgentSessionPayload[]>([])
const session = ref<AgentSessionPayload | null>(null)
const input = ref('')
type SessionRun = {
  busy: boolean
  stopRequested: boolean
  turnInFlight: boolean
  holdQueue: boolean
  agentCalls: number
  autoApplyLock: boolean
  queue: AgentQueuedMessage[]
}
const runs = ref<Record<string, SessionRun>>({})
const editingQueueId = ref<string | null>(null)
const queueEditDraft = ref('')
const queueEditInput = ref<HTMLInputElement | null>(null)
const editingUserMessageId = ref<string | null>(null)
const userMessageEditDraft = ref('')
const error = ref('')
const configured = ref(true)
const thread = ref<HTMLElement | null>(null)
const showArchived = ref(false)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const menu = ref<{ x: number; y: number; id: string } | null>(null)
const writeMenuOpen = ref(false)
const cardOpen = ref<Record<string, boolean>>({})
const drafts = ref<Record<string, ClarificationDraft>>({})
const pendingAnswerDrafts = ref<Record<string, ClarificationDraft>>({})
const showSessionDialog = ref(false)
const sessionListRatio = ref(0.2)
const copiedId = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let launchInFlight = false
let projectGen = 0
let openSeq = 0
let pinThreadToBottom = true
let scrollFrame = 0
const agentSource = `agent-panel-${crypto.randomUUID()}`

const projectRoot = computed(() => workspace.activeProject?.rootPath ?? '')
const visibleSessions = computed(() =>
  sessions.value.filter((s) => (showArchived.value ? s.archived : !s.archived))
)
const visibleMessages = computed(
  () => session.value?.messages.filter((m) => m.role !== 'tool') ?? []
)
const liveSessions = new Map<string, AgentSessionPayload>()
const activeSessionId = computed(() => session.value?.id ?? '')
const busy = computed(() => (activeSessionId.value ? runOf(activeSessionId.value).busy : false))
const queuedMessages = computed(() =>
  activeSessionId.value ? runOf(activeSessionId.value).queue : []
)
const anyBusy = computed(() => Object.values(runs.value).some((run) => run.busy))
const composerMode = computed(() => composerAction(busy.value, input.value))
const liveToolStatus = computed(() => {
  if (!busy.value) return ''
  const msgs = session.value?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    const active = activeToolCall(msg.toolCalls, {
      messageStreaming: Boolean(msg.streaming),
      busy: true
    })
    if (!active) continue
    const name = active.name ? t(toolLabelKey(active.name)) : t('agent.tool.generic')
    const verb =
      resolvedToolStatus(active, { messageStreaming: Boolean(msg.streaming), busy: true }) === 'running'
        ? t('agent.toolRunning', { name })
        : t('agent.toolGenerating', { name })
    return `${verb} · ${formatToolArgsSize(active.arguments || '')}`
  }
  if (msgs.some((m) => m.role === 'assistant' && isThinkingLive(m))) return t('agent.thinking')
  return t('agent.working')
})

function emptyRun(): SessionRun {
  return {
    busy: false,
    stopRequested: false,
    turnInFlight: false,
    holdQueue: false,
    agentCalls: 0,
    autoApplyLock: false,
    queue: []
  }
}

function runOf(id: string): SessionRun {
  return runs.value[id] ?? emptyRun()
}

function patchRun(id: string, patch: Partial<SessionRun>): void {
  if (!id) return
  const prev = runs.value[id] ?? emptyRun()
  runs.value = { ...runs.value, [id]: { ...prev, ...patch } }
}

function sessionIsBusy(id: string): boolean {
  return Boolean(runs.value[id]?.busy)
}

function publishSession(next: AgentSessionPayload): void {
  liveSessions.set(next.id, next)
  const listed = sessions.value.find((item) => item.id === next.id)
  if (listed && listed.title !== next.title) listed.title = next.title
  if (session.value?.id === next.id) session.value = next
}

function showSession(next: AgentSessionPayload): void {
  liveSessions.set(next.id, next)
  session.value = next
}

function liveSession(id: string): AgentSessionPayload | null {
  if (session.value?.id === id) return session.value
  return liveSessions.get(id) ?? null
}

function ctxFor(target: AgentSessionPayload) {
  const root = workspace.activeProject?.rootPath ?? ''
  return {
    projectName: workspace.activeProject?.name,
    projectRoot: root,
    moduleId: workspace.selectedModuleName ?? 'project',
    informalMarkdown: props.informalMarkdown,
    hybridAsfl: workspace.hybridTab?.content ?? '',
    guiHtml: workspace.guiTab?.content ?? '',
    selectedNodeId: workspace.informalSelectedNodeId ?? undefined,
    skillId: target.context.skillId || 'requirement-discovery',
    permissions: target.context.permissions,
    promptExtras: target.context.promptExtras
  }
}

function beginCall(sessionId: string, opts?: { turn?: boolean; clearStop?: boolean }): void {
  const prev = runOf(sessionId)
  patchRun(sessionId, {
    busy: true,
    stopRequested: opts?.clearStop ? false : prev.stopRequested,
    turnInFlight: opts?.turn ? true : prev.turnInFlight,
    agentCalls: prev.agentCalls + 1
  })
}

async function finishCall(
  sessionId: string,
  rootAtStart: string,
  gen: number,
  opts: { releaseTurn: boolean }
): Promise<void> {
  if (gen !== projectGen) return
  patchRun(sessionId, { agentCalls: Math.max(0, runOf(sessionId).agentCalls - 1) })
  try {
    const alive = stillOnProject(rootAtStart)
    const ready =
      alive &&
      runOf(sessionId).agentCalls === 0 &&
      !runOf(sessionId).autoApplyLock &&
      !runOf(sessionId).stopRequested
    if (ready) await maybeAutoApply(sessionId)
  } finally {
    if (gen !== projectGen || !opts.releaseTurn) return
    if (runOf(sessionId).agentCalls > 0 || runOf(sessionId).autoApplyLock) return
    patchRun(sessionId, { busy: false, turnInFlight: false })
    await nextTick()
    if (session.value?.id === sessionId) {
      thread.value?.scrollTo({ top: thread.value.scrollHeight, behavior: 'smooth' })
    }
    if (stillOnProject(rootAtStart)) await flushQueue(sessionId, false)
  }
}

function stillOnProject(root: string): boolean {
  return Boolean(root) && workspace.activeProject?.rootPath === root
}

function onThreadScroll(): void {
  const el = thread.value
  if (!el) return
  pinThreadToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72
}

async function scrollThreadIfPinned(): Promise<void> {
  if (!pinThreadToBottom) return
  await nextTick()
  thread.value?.scrollTo({ top: thread.value.scrollHeight })
}

function queueScroll(): void {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    void scrollThreadIfPinned()
  })
}

function isCardExpanded(id: string): boolean {
  if (cardOpen.value[id] != null) return cardOpen.value[id]
  const msg = session.value?.messages.find((m) => m.id === id)
  if (!msg?.clarification) return false
  if (msg.clarification.answer && !msg.pending) return false
  return true
}

function toolResultText(callId: string): string {
  if (!callId) return ''
  const hit = session.value?.messages.find((m) => m.role === 'tool' && m.id === callId)
  return hit?.content ?? ''
}

function messageIsToolOnly(msg: AgentMessageView): boolean {
  if (msg.role !== 'assistant') return false
  if (editingUserMessageId.value === msg.id) return false
  if (String(msg.content ?? '').trim() || String(msg.thinking ?? '').trim()) return false
  return Boolean(msg.toolCalls?.length)
}

watch(
  () => {
    const id = session.value?.id ?? ''
    const answered = (session.value?.messages ?? [])
      .filter((m) => Boolean(m.clarification?.answer) && !m.pending)
      .map((m) => m.id)
      .join('\n')
    return `${id}::${answered}`
  },
  (now, prev) => {
    if (prev == null) return
    const split = (value: string) => {
      const mark = value.indexOf('::')
      return [value.slice(0, mark), value.slice(mark + 2)] as const
    }
    const [prevSession, prevIds] = split(prev)
    const [nextSession, nextIds] = split(now)
    if (prevSession !== nextSession) return
    const before = new Set(prevIds ? prevIds.split('\n') : [])
    const next = { ...cardOpen.value }
    let changed = false
    for (const id of nextIds.split('\n')) {
      if (!id || before.has(id) || next[id] !== true) continue
      next[id] = false
      changed = true
    }
    if (changed) cardOpen.value = next
  }
)

function toggleCard(id: string): void {
  cardOpen.value = { ...cardOpen.value, [id]: !isCardExpanded(id) }
}

async function syncLlmConfigured(): Promise<boolean> {
  const status = await window.studio?.llmStatus?.()
  configured.value = status?.configured ?? false
  if (configured.value && error.value === t('agent.missingKey')) error.value = ''
  return configured.value
}

async function refresh(): Promise<void> {
  if (!projectRoot.value || !window.studio?.agentListSessions) return
  sessions.value = await window.studio.agentListSessions(projectRoot.value)
  await syncLlmConfigured()
}

async function ensureSession(): Promise<AgentSessionPayload | null> {
  if (session.value) return session.value
  if (!projectRoot.value || !window.studio?.agentCreateSession) return null
  const created = await window.studio.agentCreateSession(
    toIpcValue({
      projectRoot: projectRoot.value,
      moduleId: workspace.selectedModuleName ?? 'project',
      permissions: {
        informal: { read: true, write: true },
        hybrid: { read: true, write: true }
      }
    })
  )
  if (!created) return null
  showSession(created)
  await refresh()
  return created
}

async function send(text?: string, opts?: { sessionId?: string }): Promise<void> {
  const fromComposer = text == null
  const typed = (text ?? input.value).trim()
  let targetId = opts?.sessionId ?? session.value?.id ?? ''
  if (!typed) {
    if (targetId && !runOf(targetId).busy) await flushQueue(targetId, true)
    return
  }
  if (targetId && runOf(targetId).busy) {
    const next = enqueueMessage(runOf(targetId).queue, typed)
    if (next !== runOf(targetId).queue) {
      patchRun(targetId, { queue: next })
      if (fromComposer && session.value?.id === targetId) input.value = ''
    }
    return
  }
  const showError = !opts?.sessionId || opts.sessionId === session.value?.id
  if (showError) error.value = ''
  // Status is cached at the last session refresh. Re-read it so a profile saved
  // in Settings is visible on the next send.
  if (!(await syncLlmConfigured())) {
    if (showError) error.value = t('agent.missingKey')
    return
  }
  const rootAtStart = projectRoot.value
  const gen = projectGen
  let target = targetId ? liveSession(targetId) : null
  if (!target && targetId && window.studio?.agentLoadSession) {
    target = await window.studio.agentLoadSession(
      toIpcValue({ projectRoot: rootAtStart, id: targetId })
    )
    if (target) liveSessions.set(target.id, target)
  }
  if (!target && fromComposer) {
    target = await ensureSession()
    targetId = target?.id ?? ''
  }
  if (!target || !targetId || !window.studio?.agentChat) return
  if (!stillOnProject(rootAtStart) || gen !== projectGen) return
  if (fromComposer && session.value?.id === targetId) input.value = ''
  const pendingId = target.context.pendingToolCallId
  if (pendingId) {
    const pendingWrite = target.messages.find(
      (m) => m.pending && m.proposedChanges && !m.clarification
    )
    patchRun(targetId, { stopRequested: false })
    if (pendingWrite) {
      if (settings.agentWriteMode === 'auto') {
        await applyPatch(pendingWrite, typed, targetId)
        await maybeAutoApply(targetId)
        return
      }
      await resume(targetId, pendingId, JSON.stringify({ type: 'user_instruction', text: typed }), true)
      await maybeAutoApply(targetId)
      return
    }
    await resume(targetId, pendingId, clarificationResumePayload(target, pendingId, typed), true)
    await maybeAutoApply(targetId)
    return
  }
  if (session.value?.id === targetId) pinThreadToBottom = true
  const context = ctxFor(target)
  beginCall(targetId, { turn: true, clearStop: true })
  try {
    const next = await window.studio.agentChat(
      toIpcValue({
        projectRoot: rootAtStart,
        sessionId: targetId,
        text: typed,
        context
      })
    )
    if (!stillOnProject(rootAtStart) || gen !== projectGen) return
    if (next) publishSession(next)
    await refresh()
  } catch (e) {
    if (!stillOnProject(rootAtStart) || gen !== projectGen) return
    if (session.value?.id === targetId) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    await finishCall(targetId, rootAtStart, gen, { releaseTurn: true })
  }
}

function enqueueFromComposer(text?: string): void {
  const sessionId = session.value?.id
  if (!sessionId) return
  const body = (text ?? input.value).trim()
  const next = enqueueMessage(runOf(sessionId).queue, body)
  if (next !== runOf(sessionId).queue) {
    patchRun(sessionId, { queue: next })
    input.value = ''
  }
}

async function flushQueue(sessionId: string, manual: boolean): Promise<void> {
  if (!sessionId) return
  const run = runOf(sessionId)
  if (run.busy || run.agentCalls > 0 || run.autoApplyLock) return
  if (
    !manual &&
    !shouldAutoFlushQueue({
      busy: false,
      interrupted: run.holdQueue || run.stopRequested,
      stillRunning: sessionStillRunning(liveSession(sessionId))
    })
  ) {
    return
  }
  if (manual) patchRun(sessionId, { holdQueue: false, stopRequested: false })
  const { next, rest } = shiftQueuedMessage(runOf(sessionId).queue)
  if (!next) return
  patchRun(sessionId, { queue: rest })
  await send(next.text, { sessionId })
}

async function sendQueued(itemId: string): Promise<void> {
  const sessionId = session.value?.id
  if (!sessionId || runOf(sessionId).busy) return
  const { item, rest } = takeQueuedMessage(runOf(sessionId).queue, itemId)
  if (!item) return
  patchRun(sessionId, { queue: rest, stopRequested: false })
  if (editingQueueId.value === itemId) cancelQueueEdit()
  await send(item.text, { sessionId })
}

async function startQueueEdit(item: AgentQueuedMessage): Promise<void> {
  editingQueueId.value = item.id
  queueEditDraft.value = item.text
  await nextTick()
  queueEditInput.value?.focus()
  queueEditInput.value?.select()
}

function commitQueueEdit(): void {
  const id = editingQueueId.value
  const sessionId = session.value?.id
  if (!id || !sessionId) return
  patchRun(sessionId, { queue: updateQueuedMessage(runOf(sessionId).queue, id, queueEditDraft.value) })
  editingQueueId.value = null
  queueEditDraft.value = ''
}

function cancelQueueEdit(): void {
  editingQueueId.value = null
  queueEditDraft.value = ''
}

async function focusUserMessageEditor(messageId: string): Promise<void> {
  await nextTick()
  const el = thread.value?.querySelector<HTMLTextAreaElement>(
    `textarea[data-user-message-edit="${messageId}"]`
  )
  el?.focus()
  el?.select()
}

async function startUserMessageEdit(msg: AgentMessageView): Promise<void> {
  if (msg.role !== 'user' || busy.value) return
  editingUserMessageId.value = msg.id
  userMessageEditDraft.value = msg.content || ''
  await focusUserMessageEditor(msg.id)
}

function cancelUserMessageEdit(): void {
  editingUserMessageId.value = null
  userMessageEditDraft.value = ''
}

async function commitUserMessageEdit(msg: AgentMessageView): Promise<void> {
  if (editingUserMessageId.value !== msg.id) return
  const text = userMessageEditDraft.value.trim()
  cancelUserMessageEdit()
  if (!text || !session.value || busy.value || msg.role !== 'user') return
  const sessionId = session.value.id
  const original = (msg.content || '').trim()
  const msgIdx = session.value.messages.findIndex((m) => m.id === msg.id)
  const hasLater = msgIdx >= 0 && msgIdx < session.value.messages.length - 1
  if (text === original && !hasLater) return
  const next = await window.studio?.agentRewindSession?.(
    toIpcValue({
      projectRoot: projectRoot.value,
      id: sessionId,
      throughMessageId: msg.id,
      mode: 'keep',
      exclusive: true
    })
  )
  if (!next) return
  showSession(next)
  patchRun(sessionId, { queue: [], holdQueue: false })
  autoApplyTried.clear()
  await refresh()
  await send(text)
}

function deleteQueued(id: string): void {
  const sessionId = session.value?.id
  if (!sessionId) return
  patchRun(sessionId, { queue: removeQueuedMessage(runOf(sessionId).queue, id) })
  if (editingQueueId.value === id) cancelQueueEdit()
}

async function resume(
  sessionId: string,
  toolCallId: string,
  result: string,
  continueTurn = true
): Promise<void> {
  const target = liveSession(sessionId)
  if (!target || !window.studio?.agentResume) return
  if (runOf(sessionId).stopRequested) continueTurn = false
  const nested = runOf(sessionId).turnInFlight
  const rootAtStart = projectRoot.value
  const gen = projectGen
  if (session.value?.id === sessionId) pinThreadToBottom = true
  const context = ctxFor(target)
  beginCall(sessionId)
  try {
    const next = await window.studio.agentResume(
      toIpcValue({
        projectRoot: rootAtStart,
        sessionId,
        toolCallId,
        result,
        context,
        continueTurn
      })
    )
    if (!stillOnProject(rootAtStart) || gen !== projectGen) return
    if (next) publishSession(next)
    await refresh()
  } catch (e) {
    if (!stillOnProject(rootAtStart) || gen !== projectGen) return
    if (session.value?.id === sessionId) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    await finishCall(sessionId, rootAtStart, gen, { releaseTurn: !nested })
  }
}

async function applyPatch(
  msg: AgentMessageView,
  userNote?: string,
  sessionId?: string
): Promise<boolean> {
  const id = sessionId ?? session.value?.id ?? ''
  if (!id || runOf(id).stopRequested) return false
  const rootAtStart = projectRoot.value
  if (!stillOnProject(rootAtStart)) return false
  if (!msg.proposedChanges) return false
  const toolId = liveSession(id)?.context.pendingToolCallId
  const continueTurn = !runOf(id).stopRequested
  try {
    const patch = JSON.parse(JSON.stringify(msg.proposedChanges)) as InformalPatchPayload
    const result =
      patch.target === 'hybrid'
        ? await props.onApplyHybridPatch(patch)
        : patch.target === 'gui'
          ? await applyGuiDocumentPatch(patch, {
              noTab: t('agent.noGuiTab'),
              applyFailed: t('agent.applyFailed')
            })
          : await props.onApplyPatch(patch)
    if (!stillOnProject(rootAtStart)) return false
    const repair =
      'repairNotes' in result ? result.repairNotes?.filter(Boolean).join('; ') : undefined
    if (result.ok) {
      if (session.value?.id === id) error.value = ''
      if (!toolId) return false
      await resume(
        id,
        toolId,
        JSON.stringify({ action: 'applied', userNote, repair: repair || undefined }),
        continueTurn
      )
      return true
    }
    if (session.value?.id === id) error.value = ''
    if (!toolId) {
      if (session.value?.id === id) error.value = result.error || t('agent.applyFailed')
      return false
    }
    await resume(
      id,
      toolId,
      JSON.stringify({
        action: result.applied ? 'applied' : 'error',
        error: result.error || t('agent.applyFailed'),
        userNote,
        repair: repair || undefined
      }),
      continueTurn
    )
    return false
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!stillOnProject(rootAtStart)) return false
    if (!toolId) {
      if (session.value?.id === id) error.value = message
      return false
    }
    await resume(id, toolId, JSON.stringify({ action: 'error', error: message, userNote }), continueTurn)
    return false
  }
}

async function rejectPatch(_msg: AgentMessageView): Promise<void> {
  const id = session.value?.id
  if (!id) return
  const toolId = liveSession(id)?.context.pendingToolCallId
  if (!toolId) return
  await resume(id, toolId, JSON.stringify({ action: 'rejected' }), true)
}

const autoApplyTried = new Set<string>()

async function maybeAutoApply(sessionId?: string): Promise<void> {
  const id = sessionId ?? session.value?.id ?? ''
  if (!id) return
  if (settings.agentWriteMode !== 'auto') return
  if (!stillOnProject(projectRoot.value)) return
  if (runOf(id).agentCalls > 0 || runOf(id).autoApplyLock) return
  const target = liveSession(id)
  const pending = target?.messages.find((m) => m.pending && m.proposedChanges)
  if (!pending) return
  if (runOf(id).stopRequested) {
    const toolId = target?.context.pendingToolCallId
    if (toolId) await resume(id, toolId, JSON.stringify({ action: 'rejected' }), false)
    return
  }
  if (autoApplyTried.has(pending.id)) return
  patchRun(id, { autoApplyLock: true })
  autoApplyTried.add(pending.id)
  let applied = false
  try {
    applied = await applyPatch(pending, undefined, id)
  } finally {
    patchRun(id, { autoApplyLock: false })
  }
  if (!applied) {
    const stillPending = liveSession(id)?.messages.some(
      (m) => m.id === pending.id && m.pending && m.proposedChanges
    )
    if (stillPending) {
      autoApplyTried.delete(pending.id)
      return
    }
    // The failure was handed back to the agent, and the resumed turn may already have
    // proposed a repair while autoApplyLock was held. Apply it instead of stalling.
  }
  await maybeAutoApply(id)
}

function clarificationResumePayload(
  target: AgentSessionPayload,
  pendingId: string,
  composerText: string
): string {
  const msg = target.messages.find(
    (item) => item.pending && item.clarification?.pendingToolCallId === pendingId
  )
  if (!msg?.clarification) return composerText
  const draft = pendingAnswerDrafts.value[msg.id]
  const labels = (msg.clarification.options ?? [])
    .filter((option) => draft?.ids.includes(option.id))
    .map((option) => option.label)
  const custom = [draft?.custom, composerText]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('\n')
  const nextDrafts = { ...pendingAnswerDrafts.value }
  delete nextDrafts[msg.id]
  pendingAnswerDrafts.value = nextDrafts
  return encodeClarificationAnswer(
    composeClarificationAnswer({
      selectedLabels: labels,
      custom,
      multiSelect: msg.clarification.multiSelect
    })
  )
}

function onClarificationDraft(msg: AgentMessageView, draft: ClarificationDraft): void {
  pendingAnswerDrafts.value = { ...pendingAnswerDrafts.value, [msg.id]: draft }
}

async function answer(msg: AgentMessageView, value: string): Promise<void> {
  const id = session.value?.id
  if (!id) return
  const toolId = msg.clarification?.pendingToolCallId || liveSession(id)?.context.pendingToolCallId
  if (!toolId) return
  const composer = input.value.trim()
  const payload = composer ? mergeClarificationCustom(value, composer) : value
  if (composer) input.value = ''
  const nextDrafts = { ...drafts.value }
  delete nextDrafts[msg.id]
  drafts.value = nextDrafts
  const nextPending = { ...pendingAnswerDrafts.value }
  delete nextPending[msg.id]
  pendingAnswerDrafts.value = nextPending
  await resume(id, toolId, payload, true)
  await maybeAutoApply(id)
}

function messageText(msg: AgentMessageView): string {
  return (msg.content || msg.thinking || '').trim()
}

async function copyMessage(msg: AgentMessageView): Promise<void> {
  const text = messageText(msg)
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    error.value = t('agent.copyFailed')
    return
  }
  copiedId.value = msg.id
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    if (copiedId.value === msg.id) copiedId.value = null
  }, 1600)
}

async function forkFromMessage(msg: AgentMessageView): Promise<void> {
  if (!session.value || busy.value || !window.studio?.agentForkSession) return
  const copy = await window.studio.agentForkSession(
    toIpcValue({
      projectRoot: projectRoot.value,
      id: session.value.id,
      throughMessageId: msg.id,
      mode: 'keep',
      title: t('agent.forkedTitle', { title: session.value.title })
    })
  )
  if (copy) showSession(copy)
  await refresh()
}

async function reopenClarification(msg: AgentMessageView, optionId: string): Promise<void> {
  if (!session.value || busy.value) return
  if (!msg.clarification?.pendingToolCallId) return
  const { index } = await modal.show({
    title: t('agent.changeAnswerTitle'),
    message: t('agent.changeAnswerMessage'),
    buttons: [t('agent.changeAnswerFork'), t('agent.changeAnswerOverwrite'), t('agent.changeAnswerNo')],
    buttonVariants: ['accent', 'warning', 'default']
  })
  if (index === 2) return
  const draft = toggleClarificationDraft(msg.clarification, optionId)
  if (index === 0) {
    const copy = await window.studio?.agentForkSession?.(
      toIpcValue({
        projectRoot: projectRoot.value,
        id: session.value.id,
        throughMessageId: msg.id,
        mode: 'reset',
        title: t('agent.forkedTitle', { title: session.value.title })
      })
    )
    if (!copy) return
    drafts.value = { ...drafts.value, [msg.id]: draft }
    cardOpen.value = { ...cardOpen.value, [msg.id]: true }
    showSession(copy)
    await refresh()
    return
  }
  const next = await window.studio?.agentRewindSession?.(
    toIpcValue({
      projectRoot: projectRoot.value,
      id: session.value.id,
      throughMessageId: msg.id,
      mode: 'reset'
    })
  )
  if (!next) return
  drafts.value = { ...drafts.value, [msg.id]: draft }
  cardOpen.value = { ...cardOpen.value, [msg.id]: true }
  showSession(next)
  await refresh()
}

async function stopAgent(targetId?: string): Promise<void> {
  const id = targetId ?? session.value?.id
  if (!id || !runOf(id).busy) return
  patchRun(id, { stopRequested: true, holdQueue: true })
  await window.studio?.agentAbort?.(id)
}

async function stopAllAgents(): Promise<void> {
  const ids = Object.entries(runs.value)
    .filter(([, run]) => run.busy)
    .map(([id]) => id)
  await Promise.all(ids.map((id) => stopAgent(id)))
}

async function onComposerSubmit(): Promise<void> {
  if (composerMode.value === 'enqueue') {
    enqueueFromComposer()
    return
  }
  if (composerMode.value === 'stop') {
    await stopAgent()
    return
  }
  await send()
}

async function newSession(): Promise<void> {
  showSessionDialog.value = true
}

async function createSessionFromDialog(payload: {
  title?: string
  permissions: AgentSpecPermissionsPayload
}): Promise<void> {
  if (!projectRoot.value || !window.studio?.agentCreateSession) return
  showSessionDialog.value = false
  const created = await window.studio.agentCreateSession(
    toIpcValue({
      projectRoot: projectRoot.value,
      moduleId: workspace.selectedModuleName ?? 'project',
      title: payload.title,
      permissions: payload.permissions
    })
  )
  if (created) showSession(created)
  await refresh()
}

async function launchFromBootstrap(req: HybridAgentBootstrapPayload): Promise<void> {
  if (launchInFlight) return
  consumeAgentLaunchPending()
  launchInFlight = true
  error.value = ''
  showArchived.value = false
  const rootAtStart = projectRoot.value
  const gen = projectGen
  let launchedId = ''
  let launchOpenedAgent = false
  try {
    if (!rootAtStart || !window.studio?.agentCreateSession) {
      error.value = t('informal.startGenerateFailed')
      return
    }
    if (!configured.value) await syncLlmConfigured()
    const created = await window.studio.agentCreateSession(
      toIpcValue({
        projectRoot: rootAtStart,
        moduleId: workspace.selectedModuleName ?? 'project',
        title: req.title,
        skillId: req.skillId,
        permissions: req.permissions,
        promptExtras: req.promptExtras
      })
    )
    if (!created || gen !== projectGen) return
    launchedId = created.id
    showSession(created)
    await refresh()
    if (!configured.value) {
      error.value = t('agent.missingKey')
      return
    }
    pinThreadToBottom = true
    launchOpenedAgent = true
    const context = {
      ...ctxFor(created),
      skillId: req.skillId,
      permissions: req.permissions,
      promptExtras: req.promptExtras
    }
    beginCall(launchedId, { turn: true, clearStop: true })
    const next = await window.studio.agentChat(
      toIpcValue({
        projectRoot: rootAtStart,
        sessionId: launchedId,
        text: req.initialUserMessage,
        context
      })
    )
    if (!stillOnProject(rootAtStart) || gen !== projectGen) return
    if (next) publishSession(next)
    await refresh()
  } catch (e) {
    if (gen === projectGen) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    launchInFlight = false
    if (launchOpenedAgent && launchedId && gen === projectGen) {
      await finishCall(launchedId, rootAtStart, gen, { releaseTurn: true })
    }
    if (gen === projectGen && stillOnProject(rootAtStart)) {
      const queuedLaunch = consumeAgentLaunchPending()
      if (queuedLaunch) void launchFromBootstrap(queuedLaunch)
    }
  }
}

async function openSession(id: string): Promise<void> {
  const seq = ++openSeq
  cancelQueueEdit()
  const live = liveSessions.get(id)
  if (live && runOf(id).busy) {
    session.value = live
    return
  }
  if (!window.studio?.agentLoadSession) return
  const loaded = await window.studio.agentLoadSession(
    toIpcValue({ projectRoot: projectRoot.value, id })
  )
  if (seq !== openSeq || !loaded) return
  showSession(loaded)
}

function startRename(id: string, title: string): void {
  renamingId.value = id
  renameDraft.value = title
  menu.value = null
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  if (!id || !renameDraft.value.trim()) {
    renamingId.value = null
    return
  }
  const next = await window.studio?.agentRenameSession?.(
    toIpcValue({
      projectRoot: projectRoot.value,
      id,
      title: renameDraft.value.trim()
    })
  )
  renamingId.value = null
  if (next) publishSession(next)
  await refresh()
}

async function onMenu(action: MenuAction): Promise<void> {
  const id = menu.value?.id
  menu.value = null
  if (!id) return
  const target = sessions.value.find((s) => s.id === id)
  if (action === 'rename' && target) {
    startRename(id, target.title)
    return
  }
  if (action === 'copy') {
    const copy = await window.studio?.agentDuplicateSession?.(
      toIpcValue({ projectRoot: projectRoot.value, id })
    )
    if (copy) showSession(copy)
    await refresh()
    return
  }
  if (action === 'delete') {
    if (runOf(id).busy) {
      patchRun(id, { stopRequested: true, holdQueue: true })
      void window.studio?.agentAbort?.(id)
    }
    await window.studio?.agentDeleteSession?.(toIpcValue({ projectRoot: projectRoot.value, id }))
    liveSessions.delete(id)
    if (session.value?.id === id) session.value = null
    await refresh()
    return
  }
  if (action === 'pin') {
    await window.studio?.agentFlagSession?.(
      toIpcValue({
        projectRoot: projectRoot.value,
        id,
        flag: 'pinned',
        value: !target?.pinned
      })
    )
    await refresh()
    return
  }
  if (action === 'archive') {
    await window.studio?.agentFlagSession?.(
      toIpcValue({
        projectRoot: projectRoot.value,
        id,
        flag: 'archived',
        value: !target?.archived
      })
    )
    if (session.value?.id === id && !showArchived.value) session.value = null
    await refresh()
  }
}

function openMenu(e: MouseEvent, id: string): void {
  e.preventDefault()
  e.stopPropagation()
  const pt = contextMenuPoint(e)
  menu.value = { x: pt.x, y: pt.y, id }
}

onMounted(() => {
  workspace.registerAgentAbort(agentSource, stopAllAgents)
  void refresh()
  const closeMenu = () => {
    menu.value = null
    writeMenuOpen.value = false
  }
  document.addEventListener('mousedown', closeMenu)
  const unsubLaunch = subscribeAgentLaunch((req) => {
    void launchFromBootstrap(req)
  })
  const unsub = window.studio?.onAgentDelta?.((payload) => {
    if (payload.kind === 'session' && payload.session) {
      publishSession(payload.session)
      if (session.value?.id === payload.sessionId) queueScroll()
      return
    }
    const target = liveSession(payload.sessionId)
    if (!target || !payload.messageId) return
    const msg = target.messages.find((m) => m.id === payload.messageId)
    if (!msg) return
    if (payload.kind === 'reasoning') msg.thinking = payload.text
    if (payload.kind === 'content') msg.content = payload.text
    if (payload.kind === 'tool_call' && payload.index != null) {
      const prevArgs = msg.toolCalls?.[payload.index]?.arguments ?? ''
      const incoming = payload.arguments ?? ''
      msg.toolCalls = upsertToolCall(msg.toolCalls, payload.index, {
        id: payload.id ?? '',
        name: payload.name ?? '',
        arguments: incoming.length >= prevArgs.length ? incoming : prevArgs,
        status: payload.status
      })
    }
    if (payload.kind === 'tool_status' && payload.index != null && msg.toolCalls?.[payload.index]) {
      const calls = [...msg.toolCalls]
      calls[payload.index] = {
        ...calls[payload.index],
        status: payload.status ?? calls[payload.index].status
      }
      msg.toolCalls = calls
    }
    if (session.value?.id === payload.sessionId) queueScroll()
  })
  onUnmounted(() => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    document.removeEventListener('mousedown', closeMenu)
    unsubLaunch()
    unsub?.()
    workspace.registerAgentAbort(agentSource, null)
    workspace.setAgentBusy(agentSource, false)
    if (copiedTimer) clearTimeout(copiedTimer)
  })
})

watch(
  () => settings.open,
  (isOpen, wasOpen) => {
    if (wasOpen && !isOpen) void syncLlmConfigured()
  }
)

watch(projectRoot, () => {
  projectGen += 1
  openSeq += 1
  const ids = Object.entries(runs.value)
    .filter(([, run]) => run.busy)
    .map(([id]) => id)
  for (const id of ids) {
    patchRun(id, { stopRequested: true, holdQueue: true })
    void window.studio?.agentAbort?.(id)
  }
  session.value = null
  runs.value = {}
  liveSessions.clear()
  editingQueueId.value = null
  queueEditDraft.value = ''
  input.value = ''
  void refresh()
})

watch(anyBusy, (value) => workspace.setAgentBusy(agentSource, value), { immediate: true })

function permBadge(s: AgentSessionPayload): string {
  const p = s.context.permissions
  if (!p) return 'I'
  const bits: string[] = []
  if (p.informal.read || p.informal.write) bits.push(p.informal.write ? 'I+' : 'I')
  if (p.hybrid.read || p.hybrid.write) bits.push(p.hybrid.write ? 'H+' : 'H')
  return bits.join(' ') || '—'
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-surface-raised">
    <header
      v-if="!embedInDock"
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-2"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <h3 class="truncate text-[12px] font-semibold text-content-primary">{{ t('agent.title') }}</h3>
    </header>
    <ResizeSplit
      class="min-h-0 flex-1"
      direction="horizontal"
      :ratio="sessionListRatio"
      :min-first="0.12"
      :min-second="0.35"
      @update:ratio="sessionListRatio = $event"
    >
      <template #first>
        <aside class="flex h-full min-h-0 w-full flex-col">
          <button
            type="button"
            class="m-1.5 rounded-md border border-dashed border-border-subtle px-2 py-1.5 text-left text-[11px] text-content-secondary transition-colors hover:border-content-primary/30 hover:bg-surface-overlay active:bg-surface-base"
            @click="newSession"
          >
            + {{ t('agent.newSession') }}
          </button>
          <div class="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5 studio-scroll">
            <button
              v-for="s in visibleSessions"
              :key="s.id"
              type="button"
              class="mb-0.5 flex w-full items-center rounded-md px-1.5 py-1 text-left text-[11px] transition-colors"
              :class="
                session?.id === s.id
                  ? 'bg-content-primary/10 text-content-primary'
                  : 'text-content-secondary hover:bg-surface-overlay active:bg-surface-base'
              "
              @click="openSession(s.id)"
              @contextmenu="openMenu($event, s.id)"
              @dblclick.stop="startRename(s.id, s.title)"
            >
              <span v-if="s.pinned" class="mr-1 text-[10px] text-content-muted">📌</span>
              <span
                v-if="sessionIsBusy(s.id)"
                class="mr-1 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                :title="t('agent.working')"
              />
              <input
                v-if="renamingId === s.id"
                v-model="renameDraft"
                class="min-w-0 flex-1 rounded border border-field-border bg-field-bg px-1 py-0.5 text-[11px]"
                @click.stop
                @keydown.enter.prevent="commitRename"
                @keydown.esc="renamingId = null"
                @blur="commitRename"
              />
              <span v-else class="min-w-0 flex-1 truncate">{{ s.title }}</span>
              <span class="ml-1 shrink-0 font-mono text-[9px] text-content-muted">{{ permBadge(s) }}</span>
            </button>
            <p v-if="!visibleSessions.length" class="px-1 py-2 text-[11px] text-content-muted">
              {{ t('agent.noSessions') }}
            </p>
          </div>
          <button
            type="button"
            class="border-t border-border-subtle px-2 py-1 text-left text-[10px] text-content-muted hover:bg-surface-overlay"
            @click="showArchived = !showArchived"
          >
            {{ showArchived ? t('agent.hideArchived') : t('agent.showArchived') }}
          </button>
        </aside>
      </template>
      <template #second>
      <div class="flex h-full min-h-0 min-w-0 flex-col">
        <div
          ref="thread"
          class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-2 studio-scroll"
          @scroll.passive="onThreadScroll"
        >
          <p v-if="!visibleMessages.length" class="text-[13px] leading-relaxed text-content-secondary">
            {{ t('agent.emptyHint') }}
          </p>
          <div
            v-for="msg in visibleMessages"
            :key="msg.id"
            class="min-w-0 max-w-full"
            :class="messageIsToolOnly(msg) ? 'mb-1' : 'mb-2'"
          >
            <div
              class="agent-bubble studio-text-selectable max-w-[92%] min-w-0 overflow-hidden text-[13px] leading-snug break-words"
              :class="
                msg.role === 'user'
                  ? 'agent-bubble-user ml-auto rounded-lg px-2.5 py-1.5'
                  : messageIsToolOnly(msg)
                    ? 'agent-bubble-assistant rounded-md px-1.5 py-0.5'
                    : 'agent-bubble-assistant rounded-lg px-2.5 py-1.5'
              "
            >
              <details
                v-if="msg.thinking"
                class="mb-1 text-[12px] text-content-muted"
                :open="isThinkingLive(msg)"
              >
                <summary class="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wide">
                  {{ isThinkingLive(msg) ? t('agent.thinking') : t('agent.thought') }}
                </summary>
                <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed studio-scroll">{{ msg.thinking }}</pre>
              </details>
              <AgentToolActivity
                v-for="(call, i) in msg.toolCalls"
                :key="`${msg.id}-tool-${i}`"
                :call="call"
                :result="toolResultText(call.id)"
                :message-streaming="Boolean(msg.streaming)"
                :busy="busy"
              />
              <p
                v-if="msg.content && msg.role === 'assistant' && msg.streaming"
                class="cursor-text whitespace-pre-wrap"
              >{{ msg.content }}</p>
              <AgentMarkdownPreview
                v-else-if="msg.content && msg.role === 'assistant'"
                :markdown="msg.content"
              />
              <textarea
                v-else-if="msg.role === 'user' && editingUserMessageId === msg.id"
                :data-user-message-edit="msg.id"
                v-model="userMessageEditDraft"
                rows="3"
                class="w-full resize-y rounded-md border border-field-border bg-field-bg px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:ring-1 focus:ring-accent/40"
                @keydown.escape.prevent="cancelUserMessageEdit"
              />
              <p
                v-else-if="msg.content"
                class="cursor-text whitespace-pre-wrap"
                @dblclick="startUserMessageEdit(msg)"
              >
                {{ msg.content }}
              </p>
              <p v-else-if="shouldShowThinkingPlaceholder(msg)" class="text-[12px] text-content-muted">{{ t('agent.thinking') }}</p>
              <div
                v-if="!msg.streaming || msg.content"
                class="flex cursor-default select-none items-center gap-0.5"
                :class="messageIsToolOnly(msg) ? 'mt-0' : 'mt-1.5 border-t border-border-subtle pt-1'"
              >
                <template v-if="msg.role === 'user' && editingUserMessageId === msg.id">
                  <IconActionButton
                    icon="lucide:check"
                    :label="t('agent.resendEditedMessage')"
                    variant="accent"
                    :disabled="!userMessageEditDraft.trim() || busy"
                    @click="commitUserMessageEdit(msg)"
                  />
                  <IconActionButton
                    icon="lucide:x"
                    :label="t('agent.cancelEdit')"
                    @click="cancelUserMessageEdit"
                  />
                </template>
                <template v-else>
                  <IconActionButton
                    :icon="copiedId === msg.id ? 'lucide:check' : 'lucide:copy'"
                    :label="copiedId === msg.id ? t('agent.copied') : t('agent.copyText')"
                    :variant="copiedId === msg.id ? 'accent' : 'neutral'"
                    :disabled="!messageText(msg)"
                    @click="copyMessage(msg)"
                  />
                  <IconActionButton
                    v-if="msg.role === 'user'"
                    icon="lucide:pencil"
                    :label="t('agent.editUserMessage')"
                    :disabled="busy || Boolean(msg.streaming)"
                    @click="startUserMessageEdit(msg)"
                  />
                  <IconActionButton
                    icon="lucide:git-branch"
                    :label="t('agent.forkChat')"
                    :disabled="busy || Boolean(msg.streaming)"
                    @click="forkFromMessage(msg)"
                  />
                </template>
              </div>
            </div>
            <ClarificationCard
              v-if="msg.clarification"
              :question="msg.clarification.question"
              :options="msg.clarification.options"
              :allow-custom="msg.clarification.allowCustom"
              :multi-select="msg.clarification.multiSelect"
              :disabled="busy"
              :pending="Boolean(msg.pending)"
              :answer="msg.clarification.answer"
              :expanded="isCardExpanded(msg.id)"
              :prefill-ids="drafts[msg.id]?.ids"
              :prefill-custom="drafts[msg.id]?.custom"
              @toggle="toggleCard(msg.id)"
              @draft="onClarificationDraft(msg, $event)"
              @submit="answer(msg, $event)"
              @change="reopenClarification(msg, $event)"
            />
            <PatchPreview
              v-if="msg.proposedChanges"
              :patch="msg.proposedChanges"
              :disabled="busy"
              :pending="Boolean(msg.pending) && settings.agentWriteMode !== 'auto'"
              :auto-applying="Boolean(msg.pending) && settings.agentWriteMode === 'auto'"
              :resolution="msg.resolution"
              :tool-error="msg.toolError"
              @apply="applyPatch(msg)"
              @reject="rejectPatch(msg)"
            />
            <ul
              v-if="msg.review?.issues?.length"
              class="agent-bubble mt-1 min-w-0 max-w-full space-y-1 overflow-hidden rounded-lg bg-surface-raised p-2"
            >
              <li
                v-for="(issue, i) in msg.review.issues"
                :key="i"
                class="min-w-0 break-words text-[12px] text-content-secondary"
              >
                <span class="font-semibold uppercase tracking-wide text-content-muted">{{ issue.dimension }}</span>
                — {{ issue.message }}
              </li>
            </ul>
          </div>
          <p v-if="error" class="text-[12px] text-semantic-error">{{ error }}</p>
        </div>
        <div class="shrink-0 border-t border-border-subtle">
          <ul v-if="queuedMessages.length" class="max-h-28 overflow-y-auto studio-scroll px-2 py-1">
            <li class="px-1 pb-0.5 text-[10px] uppercase tracking-wide text-content-muted">
              {{ t('agent.queueTitle') }}
            </li>
            <li
              v-for="(item, index) in queuedMessages"
              :key="item.id"
              class="group/queue flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-overlay"
            >
              <span class="w-3 shrink-0 text-center text-[10px] text-content-muted">{{ index + 1 }}</span>
              <input
                v-if="editingQueueId === item.id"
                ref="queueEditInput"
                v-model="queueEditDraft"
                class="min-w-0 flex-1 rounded border border-field-border bg-field-bg px-1.5 py-0.5 text-[12px] outline-none focus:ring-1 focus:ring-accent/40"
                @keydown.enter.prevent="commitQueueEdit"
                @keydown.escape.prevent="cancelQueueEdit"
                @blur="commitQueueEdit"
              />
              <button
                v-else
                type="button"
                class="min-w-0 flex-1 truncate text-left text-[12px] text-content-secondary"
                :title="item.text"
                @click="startQueueEdit(item)"
              >
                {{ item.text }}
              </button>
              <button
                v-if="editingQueueId !== item.id"
                type="button"
                class="rounded p-0.5 text-content-muted hover:bg-surface-overlay hover:text-content-primary disabled:pointer-events-none disabled:opacity-30"
                :class="busy ? 'opacity-0 group-hover/queue:opacity-100' : 'opacity-100'"
                :title="t('agent.queueSend')"
                :aria-label="t('agent.queueSend')"
                :disabled="busy"
                @click="sendQueued(item.id)"
              >
                <StudioIcon icon="lucide:send-horizontal" :size="12" />
              </button>
              <button
                v-if="editingQueueId !== item.id"
                type="button"
                class="rounded p-0.5 text-content-muted opacity-0 hover:bg-surface-overlay hover:text-content-primary group-hover/queue:opacity-100"
                :title="t('agent.queueEdit')"
                :aria-label="t('agent.queueEdit')"
                @click="startQueueEdit(item)"
              >
                <StudioIcon icon="lucide:pencil" :size="12" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-content-muted opacity-0 hover:bg-semantic-error/10 hover:text-semantic-error group-hover/queue:opacity-100"
                :title="t('agent.queueDelete')"
                :aria-label="t('agent.queueDelete')"
                @click="deleteQueued(item.id)"
              >
                <StudioIcon icon="lucide:trash-2" :size="12" />
              </button>
              </li>
            </ul>
          <p
            v-if="busy && liveToolStatus"
            class="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] text-content-muted"
          >
            <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
            <span class="min-w-0 truncate">{{ liveToolStatus }}</span>
          </p>
          <form class="flex items-center gap-2 p-2" @submit.prevent="onComposerSubmit()">
          <div class="relative shrink-0">
            <button
              type="button"
              class="flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-field-border bg-field-bg text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
              :class="settings.agentWriteMode === 'auto' ? 'border-accent/50 text-accent' : ''"
              :title="
                settings.agentWriteMode === 'auto'
                  ? t('agent.writeModeAuto')
                  : t('agent.writeModeAsk')
              "
              :aria-label="t('agent.writeMode')"
              :aria-expanded="writeMenuOpen"
              @mousedown.stop
              @click="writeMenuOpen = !writeMenuOpen"
            >
              <StudioIcon icon="lucide:shield" :size="18" />
            </button>
            <div
              v-if="writeMenuOpen"
              class="absolute bottom-full left-0 z-[80] mb-1 min-w-[168px] rounded-md border border-border-subtle bg-surface-raised py-1 shadow-lg"
              @mousedown.stop
            >
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay"
                :class="settings.agentWriteMode === 'ask' ? 'text-content-primary font-medium' : 'text-content-secondary'"
                @click="settings.setAgentWriteMode('ask'); writeMenuOpen = false"
              >
                {{ t('agent.writeModeAsk') }}
              </button>
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay"
                :class="settings.agentWriteMode === 'auto' ? 'text-content-primary font-medium' : 'text-content-secondary'"
                @click="settings.setAgentWriteMode('auto'); writeMenuOpen = false; void maybeAutoApply()"
              >
                {{ t('agent.writeModeAuto') }}
              </button>
            </div>
          </div>
          <input
            v-model="input"
            class="min-w-0 flex-1 rounded-lg border border-field-border bg-field-bg px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/30"
            :placeholder="busy ? t('agent.queuePlaceholder') : t('agent.placeholder')"
          />
          <button
            type="submit"
            class="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg p-2.5 disabled:opacity-40"
            :class="
              composerMode === 'stop'
                ? 'bg-danger text-danger-fg hover:opacity-90'
                : 'bg-accent text-accent-fg'
            "
            :title="
              composerMode === 'stop'
                ? t('agent.stop')
                : composerMode === 'enqueue'
                  ? t('agent.queueEnqueue')
                  : t('agent.send')
            "
            :aria-label="
              composerMode === 'stop'
                ? t('agent.stop')
                : composerMode === 'enqueue'
                  ? t('agent.queueEnqueue')
                  : t('agent.send')
            "
            :disabled="composerMode === 'send' && !input.trim() && !queuedMessages.length"
          >
            <span v-if="composerMode === 'stop'" class="block h-3 w-3 rounded-[2px] bg-current" aria-hidden="true" />
            <StudioIcon v-else-if="composerMode === 'enqueue'" icon="lucide:arrow-up" :size="18" />
            <StudioIcon v-else icon="lucide:send-horizontal" :size="18" />
          </button>
        </form>
        </div>
      </div>
      </template>
    </ResizeSplit>
    <Teleport to="body">
      <div
        v-if="menu"
        class="fixed z-[200] min-w-[148px] rounded-md border border-border-subtle bg-surface-raised py-1 shadow-lg"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @mousedown.stop
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('copy')">
          {{ t('agent.menu.copy') }}
        </button>
        <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('rename')">
          {{ t('agent.menu.rename') }}
        </button>
        <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('pin')">
          {{ t('agent.menu.pin') }}
        </button>
        <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay" @click="onMenu('archive')">
          {{ t('agent.menu.archive') }}
        </button>
        <button type="button" class="block w-full px-3 py-1.5 text-left text-[12px] text-danger hover:bg-surface-overlay" @click="onMenu('delete')">
          {{ t('agent.menu.delete') }}
        </button>
      </div>
    </Teleport>
    <AgentSessionDialog
      :open="showSessionDialog"
      @close="showSessionDialog = false"
      @create="createSessionFromDialog"
    />
  </section>
</template>
