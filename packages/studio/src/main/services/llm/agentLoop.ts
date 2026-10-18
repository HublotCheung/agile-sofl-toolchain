import { chatEcnuStream, isChatAborted, type ChatMessage, type ChatStreamDelta } from './chatEcnu'
import { getEcnuConfig } from './profiles'
import { reasoningEffortFor } from './chatEcnu'
import { AGENT_TOOLS, skillById } from './skills'
import type {
  AgentMessage,
  AgentSession,
  AgentToolCallStatus,
  InformalPatchPayload
} from './agentTypes'
import { newId, normalizePermissions, type AgentSpecPermissions } from './agentTypes'
import { saveSession as writeSession } from './sessionStore'
import { informalInventoryFromMarkdown } from '@agile-sofl/aspec/dist/informal/inventory.js'
import { announceCondition, getExperimentConfig, logTelemetry, semanticDiagnostics, diagnosticCounts } from './experiment'
import { formatHybridInventory, formatHybridDiagnostics, collectHybridAgentDiagnostics, formatRefinementDigest } from '@agile-sofl/editor-api'
import { formatGuiInventory, numberedGuiSource } from '@agile-sofl/gui'
import { formatClarificationToolContent } from '../../../shared/clarificationAnswer'
import { normalizeHybridPatch } from '../../../shared/asflRepair'
import { numberedSource } from '../../../shared/sourceEdit.js'
import { projectRefinementState } from '../refinementLog.js'
import {
  appliedToolResult,
  assistantTurnIsComplete,
  continuationUserText,
  consecutiveWriteFailures,
  crudBlockedByFailures,
  failedToolResult,
  nextFailedWrite,
  patchFingerprint,
  rejectedToolResult,
  userInstructionToolResult,
  validateAgentPatch
} from './agentPatch'
import { parseToolArguments } from './parseToolArgs'

const MAX_HISTORY = 20

export type AgentTurnContext = {
  projectName?: string
  projectRoot?: string
  moduleId?: string
  informalMarkdown: string
  hybridAsfl?: string
  guiHtml?: string
  selectedNodeId?: string
  selectedNodeSummary?: string
  skillId?: string
  permissions?: AgentSpecPermissions
  promptExtras?: string
}

export type AgentStreamEvent =
  | { kind: 'session'; session: AgentSession }
  | { kind: 'reasoning'; messageId: string; text: string }
  | { kind: 'content'; messageId: string; text: string }
  | {
      kind: 'tool_call'
      messageId: string
      index: number
      id: string
      name: string
      arguments: string
      status: AgentToolCallStatus
    }
  | {
      kind: 'tool_status'
      messageId: string
      index: number
      id: string
      status: AgentToolCallStatus
    }

export type AgentStreamSink = (event: AgentStreamEvent) => void

function permissionsOf(session: AgentSession, ctx: AgentTurnContext): AgentSpecPermissions {
  return normalizePermissions(ctx.permissions ?? session.context.permissions)
}

function toolsFor(permissions: AgentSpecPermissions) {
  return AGENT_TOOLS.filter((tool) => {
    const name = tool.function.name
    if (name === 'ask_clarification') return true
    if (name === 'read_specification' || name === 'review_specification') return permissions.informal.read
    if (name === 'propose_changes') return permissions.informal.write
    if (name === 'read_hybrid_specification' || name === 'review_hybrid' || name === 'read_refinement_state')
      return permissions.hybrid.read
    if (name === 'propose_hybrid_changes' || name === 'propose_refinement_step') return permissions.hybrid.write
    if (name === 'read_gui_specification') return permissions.hybrid.read || permissions.informal.read
    if (name === 'propose_gui_changes') return permissions.hybrid.write || permissions.informal.write
    if (name === 'propose_source_edit') return permissions.informal.write || permissions.hybrid.write
    return true
  })
}

function compactSpec(markdown: string): string {
  return informalInventoryFromMarkdown(markdown, 12000)
}

function compactHybrid(asfl: string | undefined): string {
  if (!asfl?.trim()) return '(empty hybrid specification)'
  return formatHybridInventory(asfl, 12000)
}

function compactRefinement(ctx: AgentTurnContext): string {
  return compactRefinementView(ctx, 'summary')
}

function compactRefinementView(ctx: AgentTurnContext, view: 'summary' | 'tree' | 'log'): string {
  if (!ctx.hybridAsfl?.trim()) return '(no hybrid specification yet — generate Hybrid before dual-line refinement)'
  try {
    const state = projectRefinementState(ctx.projectRoot ?? '', ctx.hybridAsfl)
    return formatRefinementDigest(state, view, view === 'tree' ? 16000 : 12000)
  } catch {
    return '(refinement digest unavailable)'
  }
}

function hybridDiagnosticsPayload(asfl: string | undefined) {
  const items = collectHybridAgentDiagnostics(asfl ?? '')
  return {
    count: items.length,
    errors: items.filter((d) => d.severity === 'error').length,
    items
  }
}

async function hybridDiagnosticsWithSemantic(asfl: string | undefined, cfg: ReturnType<typeof getExperimentConfig>) {
  const base = hybridDiagnosticsPayload(asfl)
  let semantic: Awaited<ReturnType<typeof semanticDiagnostics>> = []
  try {
    semantic = await semanticDiagnostics(asfl ?? '', cfg)
  } catch { /* semantic checks are best-effort */ }
  const items: Array<Record<string, unknown>> = [
    ...base.items,
    ...semantic.map((d) => ({
      severity: d.severity,
      code: d.code,
      source: /^ASFL_FSF_1/.test(d.code) ? 'L1' : 'L2',
      line: d.span.line,
      column: d.span.column,
      message: d.message
    }))
  ]
  return {
    count: items.length,
    errors: items.filter((d) => d.severity === 'error').length,
    items,
    semanticChecks: cfg.semanticChecks
  }
}

function numberedHybridSource(asfl: string | undefined): string {
  const source = numberedSource(asfl ?? '')
  const report = formatHybridDiagnostics(asfl ?? '')
  if (report === '(no hybrid diagnostics)') return source
  return `${source}\n\n${report}`
}

function systemPrompt(ctx: AgentTurnContext, permissions: AgentSpecPermissions): string {
  const skill = skillById(ctx.skillId)
  const toolLines: string[] = [
    '- ask_clarification: when you need a decision (options the user can click, plus their own typed answer)'
  ]
  if (permissions.informal.read) {
    toolLines.push('- read_specification: Informal inventory (default) or numbered source (view=source)')
    toolLines.push('- review_specification: Informal quality review')
  }
  if (permissions.informal.write) {
    toolLines.push('- propose_changes: Informal add/update/remove/move (preferred)')
  }
  if (permissions.hybrid.read) {
    toolLines.push('- read_hybrid_specification: Hybrid inventory (default; includes per-module syntax/parse diagnostics) or numbered .asfl (view=source)')
    toolLines.push('- read_refinement_state: dual-line refinement tree/summary/log (empty modules and stub processes are gaps)')
    toolLines.push('- review_hybrid: Hybrid quality review')
  }
  if (permissions.hybrid.read || permissions.informal.read) {
    toolLines.push('- read_gui_specification: GUI HTML inventory or numbered .gui.html (view=source)')
  }
  if (permissions.hybrid.write) {
    toolLines.push('- propose_hybrid_changes: incremental Hybrid CRUD (preferred)')
    toolLines.push(
      '- propose_refinement_step: FormalizePredicate / DecomposeProcess / SetCdfd / DeclareAtomic / IntroduceRetrieve / DischargeDataObligation / ClassifyGrain / ResolveVariation. A module without cdfd is valid; do not treat ASFL_CDFD_001 as a syntax error. Grain ambiguity does not drop if you only rewrite pre/post.'
    )
  }
  if (permissions.hybrid.write || permissions.informal.write) {
    toolLines.push(
      '- propose_gui_changes: one GUI screen per call (full layout). Inline <script type="text/as-logic"> may animate that screen; it runs in a sandbox and cannot reload Studio'
    )
  }
  if (permissions.informal.write || permissions.hybrid.write) {
    toolLines.push(
      '- propose_source_edit: last-resort source edit (target informal, hybrid, or gui) when CRUD cannot unstick'
    )
  }

  const informalGuide = permissions.informal.write
    ? `For propose_changes, operate on the CURRENT Informal inventory (ids like fn-login, dr-account, c-unique):
- add: target = functions | data-resources | constraints, or any parent node id. Nesting depth is unlimited for functions, data sources (children are data-field), and constraints. node.type = function | data-resource | data-field | constraint. Include title and description. Optional node.children repeats the same shape.
- update: id = existing node id (or unique title). Set title and/or description.
- remove: id = existing node id.
- move: id + parentId + optional afterId.
Prefer update/remove on existing nodes over adding a second copy of the same idea.
Do not invent YAML frontmatter or document-level metadata.`
    : 'You do not have Informal write permission. Do not call propose_changes.'

  const hybridGuide = permissions.hybrid.write
    ? `For propose_hybrid_changes, operate on Hybrid inventory ids with CRUD only:
- add: kind (module|type|var|const|inv|process|function|scenario|gui-screen) + parentId (mod:Module or proc:Module.Name) + name. Bare ids like proc:Login or Chinese titles are resolved when possible, but prefer inventory ids. Types/vars/invs use text. Processes use signature + FSF (final grammar): FSF : T1 && D1 || T2 && D2 || … || others && Dn (Ti = test condition over inputs and ~x initial values, never outputs; Di = defining condition that constrains outputs / written ext vars). Inside Ti/Di use and, or, not; && and || only separate scenarios. If ports are unknown, signature is () — do not invent dummy (x: nat) ok: nat.
- update / remove: id of existing entity (mod:, proc:, type:, var:, inv:, scn:, gui:). Removing a parent module rewrites child headers (drops / Parent).
- replace-process-body: id of proc:, set fsf to the full FSF text "FSF : T1 && D1 || T2 && D2 || … || others && Dn" (structured natural language is allowed inside Ti/Di). Use pre/post only for legacy documents that already use them.
FORBIDDEN: replace-document, asflText, dumping several modules as one string, "-- comments" as source.
Add SYSTEM_ first, then one semantic module at a time with parentId pointing at the system module, then its types/vars/invs/processes as separate operations. Prefer updating an existing id over adding a duplicate.
Never put end_module, a whole module, or a process block inside type/var/inv/pre/post text — that wipes the document.
After a write is applied, call read_hybrid_specification and keep patching until the inventory matches the plan and Diagnostics lists no syntax errors. A module with processes and no cdfd is backward compatible — do not add a cdfd just to clear a warning.
Formalize informal FSF atoms only via propose_refinement_step kind=FormalizePredicate.
Decompose a process with kind=DecomposeProcess (child module, empty cdfd, matching ports, decom set to that module).
Write or replace a module CDFD with kind=SetCdfd: moduleName plus toText, either a full "cdfd ... end_cdfd" block or the inner lines. One cdfd per module. Syntax:
  port in <name> / port out <name>
  store <var>
  node <process>
  cond <name>
  flow <from> -> <to>
  flow <cond> | <predicate> -> <target>
  flow <cond> | others -> <target>
node names are processes in that module; store names are vars; ports match the parent process inputs and outputs when this module is a decom target. Do not store coordinates. Type keywords (time, nat, string, bool, …) are legal parameter and variable names.`
    : 'You do not have Hybrid write permission. Do not call propose_hybrid_changes.'

  const guiGuide =
    permissions.hybrid.write || permissions.informal.write
      ? `For propose_gui_changes, design a high-fidelity product prototype the user can walk through:
- Each screen should look like a finished app surface: shell/sidebar or navbar, hero or toolbar, cards/lists/tables/forms, badges, empty states, primary+secondary actions.
- Each screen is a separate HTML page. Clicking data-nav must switch screens; the screen list follows. Do not put the whole app into one un-navigable view.
- ONE screen per tool call (add-screen or replace-screen-html). A long multi-screen payload is often truncated and rejected. If a call is recovered after truncation, continue with the next screen in a new call.
- Prefer replace-screen-html (or add-screen with html) with the FULL inner markup of that screen. All children are kept; do not flatten a layout down to the first widget.
- Tags: common HTML5 (header/main/aside/nav/table/form/img/a/…). Classes: any as-* token (as-shell, as-hero, as-card, as-grid-3, as-btn-primary, …). Bind with data-process / data-bind / data-nav.
- Do not ship a page that is only two or three unlabeled buttons. Navigation must be visible in the layout, not implied.
- Prototype logic may be an inline <script type="text/as-logic"> (calculations, setInterval / requestAnimationFrame number ticks, button feedback). It runs in a sandbox iframe: it can query and update the prototype DOM, and it cannot reload Studio, open windows, or use the network. Also allowed: onclick, oninput, onchange. Do not emit <script src>, javascript: URLs, href, src, or style=.
- Buttons inside forms must not rely on form submit. Use type="button" plus data-nav / data-process, or a logic script.`
      : 'You do not have GUI write permission. Do not call propose_gui_changes.'

  const sourceGuide =
    permissions.informal.write || permissions.hybrid.write
      ? `propose_source_edit is an escape hatch, not the default:
- Prefer propose_changes / propose_hybrid_changes / propose_gui_changes / propose_refinement_step for almost every write.
- Use source edit after CRUD fails, when leftover unparsed text remains, when inventory is empty/out of sync with the file, when Diagnostics lists syntax/parse errors CRUD cannot fix, or when you must fix text CRUD cannot express. For GUI pass target "gui". Do not replace the whole GUI document in one call; patch one screen.
- First call read_* with view=source (or read_refinement_state then source). Then replace a UNIQUE oldText snippet, append, or replace-document.
- Informal atoms that you rewrite via source edit still need propose_refinement_step kind=FormalizePredicate or process ambiguity will not drop.
- Do not retry the same failing CRUD patch. After two CRUD failures you MUST switch to propose_source_edit.`
      : 'You do not have write permission for source edits.'

  const refinementGuide = permissions.hybrid.read
    ? `Dual-line refinement (guide the user; do not auto-refine the whole tree):
- Journey: Informal → Hybrid+GUI → process atomicity + data discharge + operational grain until the refinement digest reports unambiguous=true.
- Operational grain: a leaf is not atomic just because pre/post are formal. If the digest lists variations or a name-claim, ask_clarification about those extracted items only, then ClassifyGrain or ResolveVariation. Do not invent operations, and do not clear grainAmbiguity by rewriting pre/post.
- Predicate text must lex as ASFL. There is no VDM post-state prime and no ^. The final value is the bare name (~x is the initial value). Sequence append is conc(seq, elem). != is <>. Studio rewrites a trailing prime and a clear ^ before the write is kept, and it refuses a write that would add syntax errors. If a tool result says the write was not kept or a patch already failed, rewrite that fragment and re-propose. Do not retry the identical text and do not stop.
- Empty name-only modules and stub (name-only) processes are gaps. Hybrid generation does not finish the specification.
- After Hybrid/GUI work for this turn is done, if unambiguous=false, ask_clarification with 2–4 next slices from the digest. Wait for the user unless they already named a slice.
- Prefer propose_refinement_step, then propose_hybrid_changes. Fallback: propose_source_edit on Hybrid.
- After Hybrid writes, call read_refinement_state as well as read_hybrid_specification.
- Do not claim "no ambiguity" while processAmbiguity, dataAmbiguity, empty modules, or stubs remain.`
    : 'Refinement digest: (hybrid read permission off)'

  const informalBlock = permissions.informal.read
    ? `Current Informal Specification inventory:\n${compactSpec(ctx.informalMarkdown)}`
    : 'Informal Specification: (read permission off)'
  const hybridBlock = permissions.hybrid.read
    ? `Current Hybrid Specification inventory:\n${compactHybrid(ctx.hybridAsfl)}`
    : 'Hybrid Specification: (read permission off)'
  const guiBlock = permissions.hybrid.read || permissions.informal.read
    ? `Current GUI HTML inventory:\n${ctx.guiHtml?.trim() ? formatGuiInventory(ctx.guiHtml, 8000) : '(empty GUI specification)'}`
    : 'GUI Specification: (read permission off)'
  const refinementBlock = permissions.hybrid.read
    ? `Current dual-line refinement digest:\n${compactRefinement(ctx)}`
    : 'Refinement tree: (hybrid read permission off)'

  return `You are the Agile-SOFL Specification Agent inside Studio.
You help users build Informal Specification and/or Hybrid Specification (.asfl).
Markdown and SOFL text are views. You MUST NOT output a full document to apply.
You MUST use tools:
${toolLines.join('\n')}

Agile-SOFL conventions:
- There is exactly one system module. Name it SYSTEM_<SystemName> after the whole product (e.g. SYSTEM_FoodDelivery). It is the root; every other module is a child: module Auth / FoodDelivery;
- SYSTEM_ is listed first in the .asfl file. Do not treat GUI_App or a feature module as the system module.
- Processes without known ports use signature (). Inventing (x: nat) ok: nat is wrong.
- There is no implication operator: write not A or B instead. Process logic is written as FSF: FSF : T1 && D1 || T2 && D2 || … || others && Dn.
- GUI is a walkable high-fidelity prototype, not a wireframe of a few buttons.

Stakeholder decisions (product rule):
- If a threshold, permission/role scope, policy boundary, capacity limit, open course-assignment/export scope, undecided allow/deny rule, or other stakeholder choice is unresolved in the task text, call ask_clarification BEFORE writing that concrete value into Informal or Hybrid.
- Open policy/scope slots (e.g. "according to the course assignment policy" without defining who may export) require ask_clarification before propose_hybrid_changes / replace-process-body commits any concrete allow/deny default. Do not silently hard-code mappings such as assigned=true allows / assigned=false denies unless the user confirmed them.
- Until the user answers, do not invent defaults for those parameters and do not treat silence as approval of a specific number, role, scope, or allow/deny mapping.
- After an answer arrives, apply only what was confirmed; ask again if another distinct stakeholder choice remains open.

Never claim you already modified the file. Writes go through propose_* tools. User Apply/Reject (or auto-write) is only a tool result — you MUST continue the same task.
A tool result with type user_instruction is the user's own words while a change card was still open. That change was neither applied nor rejected. Interpret the words yourself: re-propose the same change if they want it, propose a revision if they want something else, or drop it if they declined. Then continue the task. Do not stop.
Clarification tool results include "selected" (clicked options) and "custom" (text the user typed). If custom is non-empty, you MUST use it. Single-choice (multiSelect false) does not discard custom, and a clicked option does not override it. When both are present, follow both.
After any applied write, call read_specification and/or read_hybrid_specification (and read_refinement_state when Hybrid changed), verify inventory, Hybrid Diagnostics, and dual-line gaps, and propose another patch if anything is missing, wrong, or still has syntax errors. Repeat until the current task slice is done.
When the whole task is done, your LAST message is a short summary of what was completed. Do not wait for the user to say "continue". If Hybrid exists and the digest is not unambiguous, that summary must invite the next refinement slice (ask_clarification) unless the user already declined further refinement.
Prefer structured CRUD. Do not dump raw Markdown or raw SOFL through propose_changes / propose_hybrid_changes. If those tools fail or cannot express the fix, read view=source and use propose_source_edit.

You are scoped to ONE project. Read/write only this project's Informal, Hybrid, and GUI files. Do not copy modules or text from any other Studio project.

${informalGuide}

${hybridGuide}

${guiGuide}

${refinementGuide}

${sourceGuide}

Active skill: ${skill.name}
${skill.prompt}

Current project: ${ctx.projectName ?? 'unknown'}
Project folder: ${ctx.projectRoot ?? '(unknown)'}
Current module: ${ctx.moduleId ?? 'project'}
Selected node: ${ctx.selectedNodeSummary || ctx.selectedNodeId || '(none — stay focused on selection when present)'}
Session permissions: Informal r=${permissions.informal.read} w=${permissions.informal.write}; Hybrid r=${permissions.hybrid.read} w=${permissions.hybrid.write}

${ctx.promptExtras ? `${ctx.promptExtras}\n` : ''}
${informalBlock}

${hybridBlock}

${guiBlock}

${refinementBlock}
`
}

export function toApiMessages(
  session: AgentSession,
  ctx: AgentTurnContext,
  permissions: AgentSpecPermissions,
  options?: { continuation?: boolean }
): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: systemPrompt(ctx, permissions) }]
  const toolResults = new Map<string, AgentMessage>()
  for (const m of session.messages) {
    if (m.role === 'tool') toolResults.set(m.id, m)
  }

  const body: ChatMessage[] = []
  for (const m of session.messages) {
    if (m.role === 'system' || m.role === 'tool') continue
    if (m.role === 'user') {
      body.push({ role: 'user', content: m.content })
      continue
    }
    if (m.role !== 'assistant') continue
    const toolCalls = m.toolCalls ?? []
    if (toolCalls.length) {
      const results = toolCalls.map((call) => toolResults.get(call.id))
      if (results.some((result) => !result)) continue
      const assistant: ChatMessage = {
        role: 'assistant',
        content: m.content || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        })),
        reasoning_content: m.thinking ?? ''
      }
      body.push(assistant)
      for (const call of toolCalls) {
        body.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResults.get(call.id)!.content
        })
      }
      continue
    }
    if (m.content.trim() || m.thinking?.trim()) {
      body.push({ role: 'assistant', content: m.content })
    }
  }

  const startIndexes = new Set<number>()
  for (let i = 0; i < body.length; i++) {
    const msg = body[i]!
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      startIndexes.add(i)
      let j = i + 1
      while (j < body.length && body[j]?.role === 'tool') {
        startIndexes.add(j)
        j += 1
      }
    }
  }
  for (let i = Math.max(0, body.length - MAX_HISTORY); i < body.length; i++) startIndexes.add(i)
  // Tool-heavy turns can push every user message outside MAX_HISTORY.
  // Keep the original task and latest user steering alongside complete tool pairs.
  const firstUser = body.findIndex((message) => message.role === 'user')
  let lastUser = -1
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]?.role === 'user') { lastUser = i; break }
  }
  if (firstUser >= 0) startIndexes.add(firstUser)
  if (lastUser >= 0) startIndexes.add(lastUser)
  const trimmed = body.filter((_, i) => startIndexes.has(i))
  msgs.push(...trimmed)
  if (options?.continuation) {
    const lastTool = [...session.messages].reverse().find((m) => m.role === 'tool')
    const toolContents = session.messages.filter((m) => m.role === 'tool').map((m) => m.content)
    const failures = Math.max(
      consecutiveWriteFailures(toolContents),
      session.context.lastFailedWrite?.count ?? 0
    )
    msgs.push({
      role: 'user',
      content: continuationUserText(lastTool?.content, failures)
    })
  }
  return msgs
}


function settleFinishedToolCalls(session: AgentSession): void {
  for (const msg of session.messages) {
    if (msg.role !== 'assistant' || msg.streaming) continue
    for (const call of msg.toolCalls ?? []) {
      if (call.status === 'streaming' || call.status === 'running' || !call.status) {
        call.status = 'done'
      }
    }
  }
}

function saveSession(projectRoot: string, session: AgentSession): void {
  settleFinishedToolCalls(session)
  writeSession(projectRoot, session)
}

function emit(sink: AgentStreamSink | undefined, event: AgentStreamEvent): void {
  if (event.kind === 'session') settleFinishedToolCalls(event.session)
  sink?.(event)
}

const TOOL_DELTA_THROTTLE_MS = 50
const TEXT_DELTA_THROTTLE_MS = 80

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function emitToolCall(
  sink: AgentStreamSink | undefined,
  live: AgentMessage,
  index: number,
  status: AgentToolCallStatus
): void {
  const call = live.toolCalls?.[index]
  if (!call) return
  const args =
    status === 'streaming' && call.arguments.length > 12000
      ? call.arguments.slice(0, 4000)
      : call.arguments
  emit(sink, {
    kind: 'tool_call',
    messageId: live.id,
    index,
    id: call.id,
    name: call.name,
    arguments: args,
    status
  })
}

function markCallStatus(
  live: AgentMessage,
  id: string,
  status: AgentToolCallStatus,
  sink?: AgentStreamSink
): void {
  const index = live.toolCalls?.findIndex((c) => c.id === id) ?? -1
  if (index < 0 || !live.toolCalls) return
  live.toolCalls[index].status = status
  emit(sink, { kind: 'tool_status', messageId: live.id, index, id, status })
}

function markRemainingToolCalls(
  live: AgentMessage,
  status: AgentToolCallStatus,
  sink?: AgentStreamSink
): void {
  for (const call of live.toolCalls ?? []) {
    if (call.status === 'done' || call.status === 'error') continue
    markCallStatus(live, call.id, status, sink)
  }
}

function attachStreamDeltas(live: AgentMessage, sink?: AgentStreamSink) {
  let lastToolEmitAt = 0
  let toolsPending = false
  let textTimer: ReturnType<typeof setTimeout> | null = null
  let lastTextEmitAt = 0
  let lastSentContent = ''
  let lastSentThinking = ''
  const seenNames = new Set<string>()

  const emitSnapshot = (): void => {
    toolsPending = false
    lastToolEmitAt = Date.now()
    for (let i = 0; i < (live.toolCalls?.length ?? 0); i++) {
      emitToolCall(sink, live, i, live.toolCalls![i].status ?? 'streaming')
    }
  }

  const flushText = (): void => {
    if (textTimer) {
      clearTimeout(textTimer)
      textTimer = null
    }
    lastTextEmitAt = Date.now()
    const thinking = live.thinking ?? ''
    if (thinking !== lastSentThinking) {
      lastSentThinking = thinking
      if (thinking) emit(sink, { kind: 'reasoning', messageId: live.id, text: thinking })
    }
    if (live.content !== lastSentContent) {
      lastSentContent = live.content
      if (live.content) emit(sink, { kind: 'content', messageId: live.id, text: live.content })
    }
  }

  const scheduleText = (): void => {
    const now = Date.now()
    if (now - lastTextEmitAt >= TEXT_DELTA_THROTTLE_MS) {
      flushText()
      return
    }
    if (textTimer) return
    textTimer = setTimeout(() => {
      textTimer = null
      flushText()
    }, TEXT_DELTA_THROTTLE_MS - (now - lastTextEmitAt))
  }

  return {
    onDelta(delta: ChatStreamDelta): void {
      if (delta.reasoning != null || delta.content != null) {
        if (delta.reasoning != null) live.thinking = delta.reasoning
        if (delta.content != null) live.content = delta.content
        scheduleText()
      }
      if (!delta.toolCalls) return
      live.toolCalls = delta.toolCalls.map((c, i) => ({
        id: c.id || live.toolCalls?.[i]?.id || `pending-${i}`,
        name: c.name,
        arguments: c.arguments,
        status: 'streaming' as const
      }))
      const nameAppeared = (live.toolCalls ?? []).some((c, i) => {
        if (!c.name) return false
        const key = `${i}:${c.name}`
        if (seenNames.has(key)) return false
        seenNames.add(key)
        return true
      })
      const heavy = (live.toolCalls ?? []).some((c) => c.arguments.length > 8000)
      const wait = heavy ? 200 : TOOL_DELTA_THROTTLE_MS
      const now = Date.now()
      if (nameAppeared || now - lastToolEmitAt >= wait) {
        emitSnapshot()
        return
      }
      toolsPending = true
    },
    flush(): void {
      flushText()
      if (toolsPending || live.toolCalls?.length) emitSnapshot()
    }
  }
}

/**
 * Experiment freeze v1.2 (decision 2026-10-08): reasoning/thinking is OFF for every agent LLM call in all
 * conditions, including the first attempt (request sends thinking: disabled and no reasoning_effort).
 * The retry path is unchanged (it also sends thinking: false). Telemetry records reasoning='off'.
 */
export const AGENT_THINKING = false

/** short, key-free reason for the thinking-disabled retry (telemetry only) */
export function retryReasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const status = /\b(4\d\d|5\d\d)\b/.exec(msg)?.[1]
  return (status ? `HTTP ${status}: ` : '') + msg.replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g, '[redacted]').slice(0, 120)
}

/** chatEcnuStream + per-call telemetry (model, tokens, latency, condition). Never logs API keys. */
async function loggedStream(
  projectRoot: string,
  sessionId: string,
  options: Parameters<typeof chatEcnuStream>[0],
  meta: { attempt: number; retryReason?: string } = { attempt: 1 }
): ReturnType<typeof chatEcnuStream> {
  const callMeta = { reasoning: reasoningEffortFor(options.thinking), attempt: meta.attempt, ...(meta.retryReason ? { retryReason: meta.retryReason } : {}) }
  const cfg = getExperimentConfig(projectRoot)
  announceCondition(projectRoot, sessionId, cfg)
  const t0 = Date.now()
  const promptChars = JSON.stringify(options.messages).length
  try {
    const c = await chatEcnuStream(options)
    logTelemetry(projectRoot, cfg, sessionId, {
      event: 'llm_call',
      model: c.model ?? getEcnuConfig().model,
      promptTokens: c.usage?.promptTokens ?? null,
      completionTokens: c.usage?.completionTokens ?? null,
      latencyMs: Date.now() - t0,
      ok: true,
      ...callMeta,
      finishReason: c.finishReason,
      toolCalls: c.toolCalls.map((t) => t.function.name),
      promptChars,
      prompt: cfg.logPrompts ? options.messages : undefined
    })
    return c
  } catch (e) {
    logTelemetry(projectRoot, cfg, sessionId, {
      event: 'llm_call',
      model: getEcnuConfig().model,
      promptTokens: null,
      completionTokens: null,
      latencyMs: Date.now() - t0,
      ok: false,
      ...callMeta,
      promptChars,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
    })
    throw e
  }
}

export async function runAgentTurn(
  session: AgentSession,
  projectRoot: string,
  ctx: AgentTurnContext,
  userText?: string,
  sink?: AgentStreamSink,
  signal?: AbortSignal
): Promise<AgentSession> {
  if (userText?.trim()) {
    session.messages.push({
      id: newId('msg'),
      role: 'user',
      content: userText.trim(),
      timestamp: new Date().toISOString(),
      skillId: ctx.skillId
    })
    if (session.title === 'Requirement Analysis' && session.messages.filter((m) => m.role === 'user').length === 1) {
      session.title = userText.trim().slice(0, 42)
    }
    saveSession(projectRoot, session)
    emit(sink, { kind: 'session', session })
  }
  session.context.skillId = ctx.skillId || session.context.skillId || 'requirement-discovery'
  session.context.selectedNodeId = ctx.selectedNodeId
  const permissions = permissionsOf(session, ctx)
  session.context.permissions = permissions
  if (ctx.promptExtras) session.context.promptExtras = ctx.promptExtras
  else ctx.promptExtras = session.context.promptExtras
  ctx.permissions = permissions
  const continuation = !userText?.trim()
  let needsContinuationNudge = continuation

  const stopIfAborted = (): boolean => {
    if (!signal?.aborted) return false
    const live = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.streaming)
    if (live) {
      live.streaming = false
      markRemainingToolCalls(live, 'error', sink)
      if (!live.content.trim()) live.content = '已停止 / Stopped.'
    } else {
      session.messages.push({
        id: newId('msg'),
        role: 'assistant',
        content: '已停止 / Stopped.',
        timestamp: new Date().toISOString(),
        skillId: ctx.skillId
      })
    }
    saveSession(projectRoot, session)
    emit(sink, { kind: 'session', session })
    return true
  }

  for (let step = 0; step < 14; step++) {
    if (stopIfAborted()) return session
    const assistantId = newId('msg')
    const live: AgentMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      thinking: '',
      streaming: true,
      timestamp: new Date().toISOString(),
      skillId: ctx.skillId
    }
    session.messages.push(live)
    emit(sink, { kind: 'session', session })

    const history = { ...session, messages: session.messages.filter((m) => m.id !== assistantId) }
    const request = {
      messages: toApiMessages(history, ctx, permissions, { continuation: needsContinuationNudge }),
      tools: toolsFor(permissions),
      temperature: 0.35
    }

    const streamDeltas = attachStreamDeltas(live, sink)
    let completion
    try {
      completion = await loggedStream(projectRoot, session.id, {
        ...request,
        thinking: AGENT_THINKING,
        signal,
        onDelta: streamDeltas.onDelta
      })
    } catch (first) {
      streamDeltas.flush()
      if (isChatAborted(first) || signal?.aborted) {
        live.streaming = false
        markRemainingToolCalls(live, 'error', sink)
        if (!live.content.trim()) live.content = '已停止 / Stopped.'
        saveSession(projectRoot, session)
        emit(sink, { kind: 'session', session })
        return session
      }
      try {
        completion = await loggedStream(projectRoot, session.id, {
          ...request,
          thinking: false,
          signal,
          onDelta: streamDeltas.onDelta
        }, { attempt: 2, retryReason: retryReasonOf(first) })
      } catch (err) {
        streamDeltas.flush()
        live.streaming = false
        markRemainingToolCalls(live, 'error', sink)
        if (isChatAborted(err) || signal?.aborted) {
          if (!live.content.trim()) live.content = '已停止 / Stopped.'
          saveSession(projectRoot, session)
          emit(sink, { kind: 'session', session })
          return session
        }
        live.content = err instanceof Error ? err.message : String(err)
        saveSession(projectRoot, session)
        emit(sink, { kind: 'session', session })
        if (continuation) {
          session.messages = session.messages.filter((m) => m.id !== assistantId)
          continue
        }
        throw err
      }
    }

    streamDeltas.flush()
    await yieldToUi()
    live.streaming = false
    live.content = completion.content.trim()
    live.thinking = completion.reasoning.trim() || live.thinking
    if (completion.toolCalls.length) {
      live.toolCalls = completion.toolCalls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
        status: 'running' as const
      }))
      live.toolCalls.forEach((call, index) => {
        emit(sink, {
          kind: 'tool_call',
          messageId: assistantId,
          index,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running'
        })
      })
    } else {
      live.toolCalls = undefined
    }

    if (completion.toolCalls.length) {
      for (const call of completion.toolCalls) {
        await yieldToUi()
        const parsedArgs = parseToolArguments(call.function.arguments || '{}', { finishReason: completion.finishReason })
        if (!parsedArgs.ok) {
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              error: parsedArgs.error,
              next: 'Do not resend that payload. Split it into smaller tool calls and continue.'
            }),
            timestamp: new Date().toISOString()
          })
          live.content = live.content || parsedArgs.error
          markCallStatus(live, call.id, 'error', sink)
          continue
        }
        const args = parsedArgs.value
        if (parsedArgs.droppedPartialOperation) {
          const note =
            'Recovered a truncated tool call. The incomplete last operation was dropped. Continue the remaining work in a new, smaller call.'
          args.explanation =
            typeof args.explanation === 'string' && args.explanation.trim()
              ? `${args.explanation}\n\n${note}`
              : note
        }
        if (call.function.name === 'ask_clarification') {
          const options = Array.isArray(args.options)
            ? (args.options as Array<{ id?: string; label?: string }>)
                .filter((o) => o.label)
                .map((o, i) => ({ id: o.id || `opt-${i}`, label: String(o.label) }))
            : undefined
          live.content = String(args.question || live.content || '')
          live.clarification = {
            id: newId('q'),
            question: String(args.question || 'Please clarify.'),
            options,
            allowCustom: args.allowCustom !== false,
            multiSelect: Boolean(args.multiSelect),
            pendingToolCallId: call.id
          }
          live.pending = true
          session.context.pendingToolCallId = call.id
          completeSiblingToolCalls(session, completion.toolCalls, call.id)
          markCallStatus(live, call.id, 'done', sink)
          markRemainingToolCalls(live, 'done', sink)
          saveSession(projectRoot, session)
          emit(sink, { kind: 'session', session })
          return session
        }
        if (
          call.function.name === 'propose_changes' ||
          call.function.name === 'propose_hybrid_changes' ||
          call.function.name === 'propose_refinement_step' ||
          call.function.name === 'propose_gui_changes' ||
          call.function.name === 'propose_source_edit'
        ) {
          const mode: 'crud' | 'source' =
            call.function.name === 'propose_source_edit' ? 'source' : 'crud'
          let target: 'informal' | 'hybrid' | 'gui'
          if (call.function.name === 'propose_hybrid_changes' || call.function.name === 'propose_refinement_step')
            target = 'hybrid'
          else if (call.function.name === 'propose_changes') target = 'informal'
          else if (call.function.name === 'propose_gui_changes') target = 'gui'
          else {
            const raw = typeof args.target === 'string' ? args.target : ''
            if (raw === 'hybrid' || raw === 'informal' || raw === 'gui') {
              target = raw
            } else if (permissions.hybrid.write && !permissions.informal.write) {
              target = 'hybrid'
            } else if (permissions.informal.write && !permissions.hybrid.write) {
              target = 'informal'
            } else {
              session.messages.push({
                id: call.id,
                role: 'tool',
                content: JSON.stringify({
                  ok: false,
                  error: 'propose_source_edit requires target: "informal", "hybrid", or "gui".',
                  next: 'Re-call propose_source_edit with an explicit target after read_* view=source. For GUI, target is "gui" and each call should touch one screen.'
                }),
                timestamp: new Date().toISOString()
              })
              live.content = live.content || 'Source edit needs an explicit target.'
              markCallStatus(live, call.id, 'error', sink)
              continue
            }
          }
          let patch: InformalPatchPayload =
            call.function.name === 'propose_refinement_step'
              ? {
                  target: 'hybrid',
                  mode: 'crud',
                  explanation: typeof args.explanation === 'string' ? args.explanation : undefined,
                  operations: [
                    {
                      op: 'refine-step',
                      kind: args.kind,
                      moduleName: args.moduleName,
                      processName: args.processName,
                      typeName: args.typeName,
                      clause: args.clause,
                      fromText: args.fromText,
                      toText: args.toText,
                      childModuleName: args.childModuleName,
                      representationType: args.representationType,
                      retrieveFunction: args.retrieveFunction,
                      retrieveBody: args.retrieveBody,
                      note: args.note,
                      grainClass: args.grainClass,
                      variationId: args.variationId,
                      disposition: args.disposition
                    }
                  ]
                }
              : {
                  target,
                  mode,
                  explanation: typeof args.explanation === 'string' ? args.explanation : undefined,
                  operations: Array.isArray(args.operations)
                    ? (args.operations as Array<Record<string, unknown>>)
                    : []
                }
          const allowed =
            target === 'informal'
              ? permissions.informal.write
              : target === 'hybrid'
                ? permissions.hybrid.write
                : permissions.hybrid.write || permissions.informal.write
          if (!allowed) {
            session.messages.push({
              id: call.id,
              role: 'tool',
              content: JSON.stringify({
                ok: false,
                error: `No ${target} write permission.`,
                next: 'Do not call write tools for a specification you cannot write.'
              }),
              timestamp: new Date().toISOString()
            })
            live.content = live.content || `No ${target} write permission.`
            markCallStatus(live, call.id, 'error', sink)
            continue
          }
          if (target === 'hybrid') {
            const normalized = normalizeHybridPatch(patch)
            patch = normalized.patch
            if (normalized.unresolved) {
              const error = `Could not auto-repair illegal ASFL (${normalized.unresolved}).`
              session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
                fingerprint: patchFingerprint(patch),
                error,
                mode
              })
              session.messages.push({
                id: call.id,
                role: 'tool',
                content: JSON.stringify({
                  ok: false,
                  error,
                  next: 'Rewrite ^ as conc(seq, elem) and drop VDM primes. Re-propose a different patch. Do not stop.'
                }),
                timestamp: new Date().toISOString()
              })
              live.content = live.content || error
              markCallStatus(live, call.id, 'error', sink)
              continue
            }
          }
          const blocked = crudBlockedByFailures(session.context.lastFailedWrite, {
            fingerprint: patchFingerprint(patch),
            mode
          })
          if (blocked) {
            session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
              fingerprint: patchFingerprint(patch),
              error: blocked,
              mode
            })
            session.messages.push({
              id: call.id,
              role: 'tool',
              content: JSON.stringify({
                ok: false,
                error: blocked,
                next: 'Do not retry the same CRUD. Call read_* with view=source, then propose_source_edit.'
              }),
              timestamp: new Date().toISOString()
            })
            live.content = live.content || `Patch rejected: ${blocked}`
            markCallStatus(live, call.id, 'error', sink)
            continue
          }
          const validity = validateAgentPatch(target, patch, { mode })
          if (!validity.ok) {
            const emptyPatch = !Array.isArray(patch.operations) || patch.operations.length === 0
            if (!emptyPatch) {
              session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
                fingerprint: patchFingerprint(patch),
                error: validity.message,
                mode
              })
            }
            session.messages.push({
              id: call.id,
              role: 'tool',
              content: JSON.stringify({
                ok: false,
                error: validity.message,
                next:
                  mode === 'source'
                    ? 'Fix the source-edit operations (unique oldText, or append / replace-document). Do not stop.'
                    : 'Tool rejected that patch. Read the inventory, or view=source then propose_source_edit. Do not stop.'
              }),
              timestamp: new Date().toISOString()
            })
            live.content = live.content || `Patch rejected: ${validity.message}`
            markCallStatus(live, call.id, 'error', sink)
            continue
          }
          live.content =
            patch.explanation ||
            live.content ||
            (mode === 'source'
              ? `Proposed ${target} source edit.`
              : `Proposed ${target} specification changes.`)
          live.proposedChanges = patch
          live.pending = true
          session.context.pendingToolCallId = call.id
          completeSiblingToolCalls(session, completion.toolCalls, call.id)
          markCallStatus(live, call.id, 'done', sink)
          markRemainingToolCalls(live, 'done', sink)
          saveSession(projectRoot, session)
          emit(sink, { kind: 'session', session })
          return session
        }
        if (call.function.name === 'read_specification') {
          const view = args.view === 'source' ? 'source' : 'inventory'
          const body = !permissions.informal.read
            ? '(Informal read permission off)'
            : view === 'source'
              ? numberedSource(ctx.informalMarkdown)
              : informalInventoryFromMarkdown(ctx.informalMarkdown)
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({
              ok: permissions.informal.read,
              view,
              inventory: view === 'inventory' ? body : undefined,
              source: view === 'source' ? body : undefined
            }),
            timestamp: new Date().toISOString()
          })
          live.content =
            live.content ||
            (view === 'source'
              ? 'Read the current Informal Specification source.'
              : 'Read the current Informal Specification inventory.')
          markCallStatus(live, call.id, 'done', sink)
          continue
        }
        if (call.function.name === 'read_hybrid_specification') {
          const view = args.view === 'source' ? 'source' : 'inventory'
          const body = !permissions.hybrid.read
            ? '(Hybrid read permission off)'
            : view === 'source'
              ? numberedHybridSource(ctx.hybridAsfl)
              : compactHybrid(ctx.hybridAsfl)
          // Parser diagnostics are always fed back (also in condition B2). L1/L2 semantic FSF
          // diagnostics are added only when the experiment condition enables them (not in B2).
          const diagnostics = permissions.hybrid.read
            ? await hybridDiagnosticsWithSemantic(ctx.hybridAsfl, getExperimentConfig(projectRoot))
            : { count: 0, errors: 0, items: [] }
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({
              ok: permissions.hybrid.read,
              view,
              inventory: view === 'inventory' ? body : undefined,
              source: view === 'source' ? body : undefined,
              diagnostics
            }),
            timestamp: new Date().toISOString()
          })
          live.content =
            live.content ||
            (view === 'source'
              ? diagnostics.errors
                ? `Read the current Hybrid Specification source (${diagnostics.errors} syntax error(s)).`
                : 'Read the current Hybrid Specification source.'
              : diagnostics.errors
                ? `Read the current Hybrid Specification inventory (${diagnostics.errors} syntax error(s)).`
                : 'Read the current Hybrid Specification inventory.')
          markCallStatus(live, call.id, 'done', sink)
          continue
        }
        if (call.function.name === 'read_refinement_state') {
          const view = args.view === 'tree' || args.view === 'log' ? args.view : 'summary'
          const allowed = permissions.hybrid.read
          const digest = !allowed
            ? '(Hybrid read permission off)'
            : compactRefinementView(ctx, view)
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({
              ok: allowed,
              view,
              digest
            }),
            timestamp: new Date().toISOString()
          })
          live.content = live.content || 'Read the current dual-line refinement state.'
          markCallStatus(live, call.id, 'done', sink)
          continue
        }
        if (call.function.name === 'read_gui_specification') {
          const view = args.view === 'source' ? 'source' : 'inventory'
          const allowed = permissions.hybrid.read || permissions.informal.read
          const body = !allowed
            ? '(GUI read permission off)'
            : view === 'source'
              ? numberedGuiSource(ctx.guiHtml ?? '')
              : formatGuiInventory(ctx.guiHtml ?? '', 20000)
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({
              ok: allowed,
              view,
              inventory: view === 'inventory' ? body : undefined,
              source: view === 'source' ? body : undefined
            }),
            timestamp: new Date().toISOString()
          })
          live.content =
            live.content ||
            (view === 'source' ? 'Read the current GUI HTML source.' : 'Read the current GUI inventory.')
          markCallStatus(live, call.id, 'done', sink)
          continue
        }
        if (call.function.name === 'review_specification' || call.function.name === 'review_hybrid') {
          const typedIssues = Array.isArray(args.issues)
            ? (args.issues as Array<{ dimension?: string; message?: string; nodeId?: string }>).map((i) => ({
                dimension: String(i.dimension || 'completeness'),
                message: String(i.message || ''),
                nodeId: i.nodeId
              }))
            : []
          live.content = live.content || 'Specification review'
          live.review = { issues: typedIssues }
          session.messages.push({
            id: call.id,
            role: 'tool',
            content: JSON.stringify({ ok: true, issues: typedIssues }),
            timestamp: new Date().toISOString()
          })
          markCallStatus(live, call.id, 'done', sink)
          continue
        }
        session.messages.push({
          id: call.id,
          role: 'tool',
          content: JSON.stringify({ ok: false, error: `Unknown tool ${call.function.name}` }),
          timestamp: new Date().toISOString()
        })
        markCallStatus(live, call.id, 'error', sink)
      }
      markRemainingToolCalls(live, 'done', sink)
      saveSession(projectRoot, session)
      emit(sink, { kind: 'session', session })
      needsContinuationNudge = false
      continue
    }

    if (assistantTurnIsComplete(live.content, 0)) {
      break
    }

    session.messages = session.messages.filter((m) => m.id !== assistantId)
  }

  saveSession(projectRoot, session)
  emit(sink, { kind: 'session', session })
  return session
}

function completeSiblingToolCalls(
  session: AgentSession,
  calls: Array<{ id: string; function?: { name?: string } }>,
  keepId: string
): void {
  for (const call of calls) {
    if (call.id === keepId) continue
    if (session.messages.some((m) => m.role === 'tool' && m.id === call.id)) continue
    session.messages.push({
      id: call.id,
      role: 'tool',
      content: JSON.stringify({
        skipped: true,
        tool: call.function?.name,
        reason:
          'Not executed. Another tool in this turn is waiting for Apply or Reject. After that tool result, call this tool again if the work is still needed. Do not treat this skip as a user rejection.'
      }),
      timestamp: new Date().toISOString()
    })
  }
}

function parseResumePayload(result: string): {
  action?: string
  error?: string
  userNote?: string
  repair?: string
  type?: string
  text?: string
} {
  try {
    const parsed = JSON.parse(result) as {
      action?: string
      error?: string
      userNote?: string
      repair?: string
      type?: string
      text?: string
    }
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* plain text from older clients */
  }
  return {}
}

export async function resumeWithToolResult(
  session: AgentSession,
  projectRoot: string,
  ctx: AgentTurnContext,
  toolCallId: string,
  result: string,
  sink?: AgentStreamSink,
  continueTurn = true,
  signal?: AbortSignal
): Promise<AgentSession> {
  const payload = parseResumePayload(result)
  const pending = session.messages.find(
    (m) =>
      m.pending &&
      (m.clarification?.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId)
  )
  const patch = pending?.proposedChanges
  if (patch) {
    const cfg = getExperimentConfig(projectRoot)
    const op0 = patch.operations?.[0] as { op?: string; kind?: string } | undefined
    const isRefine = op0?.op === 'refine-step'
    if (payload.action === 'applied' || payload.action === 'rejected' || payload.action === 'error') {
      logTelemetry(projectRoot, cfg, session.id, {
        event: 'proposal_decision',
        tool: isRefine ? 'propose_refinement_step' : patch.mode === 'source' ? 'propose_source_edit' : `propose_${patch.target ?? 'informal'}_changes`,
        stepType: isRefine ? String(op0?.kind ?? '') : undefined,
        decision: payload.action === 'applied' && !payload.error ? 'approved' : payload.action === 'rejected' ? 'rejected' : 'error',
        toolCallId
      })
    }
    if (payload.action === 'applied' && !payload.error && patch.target === 'hybrid' && ctx.hybridAsfl !== undefined) {
      try {
        logTelemetry(projectRoot, cfg, session.id, {
          event: 'post_write_diagnostics',
          toolCallId,
          diagnostics: await diagnosticCounts(ctx.hybridAsfl, cfg)
        })
      } catch { /* best-effort */ }
    }
    if (payload.action === 'applied' && !payload.error) {
      session.context.lastFailedWrite = undefined
    } else if (payload.action === 'error' || (payload.action === 'applied' && payload.error)) {
      session.context.lastFailedWrite = nextFailedWrite(session.context.lastFailedWrite, {
        fingerprint: patchFingerprint(patch),
        error: payload.error || 'Tool failed',
        mode: patch.mode ?? 'crud'
      })
    }
  }
  const clarificationMsg = session.messages.find(
    (m) =>
      m.pending &&
      m.clarification &&
      (m.clarification.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId)
  )
  const pendingWrite = session.messages.find(
    (m) => m.pending && m.proposedChanges && !m.clarification && session.context.pendingToolCallId === toolCallId
  )
  let toolContent = result
  let clarificationDisplay: string | undefined
  if (payload.type === 'user_instruction') toolContent = userInstructionToolResult(payload.text || result)
  else if (payload.action === 'applied')
    toolContent = appliedToolResult({ error: payload.error, userNote: payload.userNote, repair: payload.repair })
  else if (payload.action === 'error') toolContent = failedToolResult(payload.error || 'Tool failed', payload.userNote)
  else if (payload.action === 'rejected') toolContent = rejectedToolResult()
  else if (clarificationMsg?.clarification) {
    const formatted = formatClarificationToolContent(result, {
      labels: clarificationMsg.clarification.options?.map((option) => option.label),
      multiSelect: clarificationMsg.clarification.multiSelect
    })
    toolContent = formatted.toolContent
    clarificationDisplay = formatted.display
  } else if (pendingWrite) {
    toolContent = failedToolResult(
      'The pending change was not applied. A chat reply does not reject it.',
      result
    )
  } else {
    toolContent = JSON.stringify({
      type: 'clarification_answer',
      answer: result,
      custom: result,
      next: 'custom is text the user typed. You MUST use it even when the question was single-choice. Then continue the task.'
    })
  }
  for (const m of session.messages) {
    if (!m.pending) continue
    if (m.clarification?.pendingToolCallId === toolCallId || session.context.pendingToolCallId === toolCallId) {
      m.pending = false
      if (m.clarification) {
        m.clarification.answer = clarificationDisplay ?? result
        m.resolution = 'answered'
      }
      if (m.proposedChanges) {
        if (payload.type === 'user_instruction') {
          m.resolution = 'answered'
        } else {
          const unansweredWrite = !payload.action && pendingWrite
          m.resolution =
            payload.action === 'applied' ? 'applied' : payload.action === 'error' || unansweredWrite ? 'error' : 'rejected'
          if (payload.error) m.toolError = payload.error
          else if (unansweredWrite) m.toolError = 'Pending change was not applied.'
        }
      }
    }
  }
  session.messages.push({
    id: toolCallId,
    role: 'tool',
    content: toolContent,
    timestamp: new Date().toISOString()
  })
  session.context.pendingToolCallId = undefined
  saveSession(projectRoot, session)
  emit(sink, { kind: 'session', session })
  if (!continueTurn) return session
  return runAgentTurn(session, projectRoot, ctx, undefined, sink, signal)
}
