/**
 * Headless driver for the studio agent loop (runAgentTurn / resumeWithToolResult) with the real LLM.
 * Mirrors what AgentPanel.vue does in auto-write mode: every proposal is auto-approved and applied
 * exactly as applyHybridDocumentPatch would (source edit / refinement step / CRUD patch), then the loop
 * is resumed with {action:'applied'} so post_write_diagnostics are logged by the production code.
 *
 * Seed of the automated-pilot batch runner: one call = one run in one condition, written to a run
 * directory named by a random id; the condition<->id key is returned to the caller (kept out of the
 * run directory, for blind coding). Runs are strictly serial (no concurrency).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyHybridPatch } from '@agile-sofl/editor-api'
import { runAgentTurn, resumeWithToolResult, type AgentTurnContext } from '../../src/main/services/llm/agentLoop'
import { generationAgentPermissions, newId, type AgentSession, type InformalPatchPayload } from '../../src/main/services/llm/agentTypes'
import { skillById } from '../../src/main/services/llm/skills'
import { applySourceEdits, isSourcePatch } from '../../src/shared/sourceEdit'
import { applyProjectRefinementStep } from '../../src/main/services/refinementLog'
import { readInformal } from './informal'

export const PILOT_TEMPERATURE = 0.35 // fixed inside agentLoop.ts; recorded here for the manifest

export type ClarificationAsk = {
  question: string
  options?: Array<{ id: string; label: string }>
  multiSelect?: boolean
  allowCustom?: boolean
}

export type ClarificationResolution = {
  text: string
  matchedSlotIds?: string[]
  unmatched?: boolean
}

export interface RunOptions {
  condition: 'T' | 'B2'
  informalPath: string
  /** Existing specification for maintenance tasks; omitted for construction. */
  initialHybridAsfl?: string
  outDir: string
  skillId?: string
  userText?: string
  /** max auto-approved proposals before the turn is stopped (bounds LLM calls) */
  maxApprovals?: number
  clarificationAnswer?: string
  /**
   * Clarification experiments: map ask_clarification to a stakeholder/oracle answer.
   * When set, the harness never falls back to DEFAULT_CLARIFICATION (best-judgement).
   */
  resolveClarification?: (ask: ClarificationAsk) => ClarificationResolution | Promise<ClarificationResolution>
  /** Study/pilot telemetry (e.g. clarification_asked, oracle_reply). */
  onStudyEvent?: (event: Record<string, unknown>) => void
  participantId?: string
  /** externally assigned (blinded) run id; random when omitted */
  runId?: string
  /** extra fields written into manifest.json (e.g. commit provenance from the batch runner) */
  manifestExtra?: Record<string, unknown>
  /** called after every approved step with the spec as it stands after applying it (before the agent resumes) */
  onStep?: (step: StepInfo) => Promise<void> | void
}

export interface StepInfo {
  runId: string
  runDir: string
  /** 1-based index of the approved step */
  step: number
  hybrid: string
  /** the tool whose proposal was approved, e.g. propose_hybrid_changes */
  tool: string
  applied: boolean
  applyError?: string
}

export interface RunResult {
  runId: string
  runDir: string
  condition: string
  promptHash: string
  approvals: number
  stopReason: string
  hybridChars: number
}

export const DEFAULT_USER_TEXT =
  'Generate the Hybrid Specification from the Informal Specification. Strategy: rebuild (no existing Hybrid). Work incrementally with the tools.'
/** Must NOT authorize inventing business rules when no oracle/answer is supplied. */
export const UNMATCHED_CLARIFICATION_REPLY =
  'No additional stakeholder decision is available from this automated reply. Do not invent concrete business defaults, thresholds, role scopes, permission policies, or capacity limits. If a stakeholder choice is still required, call ask_clarification again; otherwise continue only with requirements already stated in the task.'
/** @deprecated Prefer resolveClarification / UNMATCHED_CLARIFICATION_REPLY. */
export const DEFAULT_CLARIFICATION = UNMATCHED_CLARIFICATION_REPLY

/** Hash of everything that must be identical across conditions (input, skill prompt, user text, answers, temperature). */
export function promptHash(o: { informal: string; skillPrompt: string; userText: string; clarification: string; initialHybridSha256?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...o, temperature: PILOT_TEMPERATURE }))
    .digest('hex')
}

export function applyHybridProposal(source: string, patch: InformalPatchPayload, projectRoot: string): { content: string; error?: string; applied: boolean } {
  if (isSourcePatch(patch)) {
    const r = applySourceEdits(source, patch.operations as never)
    return { content: r.content, error: r.error, applied: r.content !== source }
  }
  const stepOp = patch.operations.find((op) => op.op === 'refine-step')
  if (stepOp && patch.operations.length === 1) {
    const r = applyProjectRefinementStep(projectRoot, source, stepOp as never) as { source: string; error?: string }
    if (r.error) return { content: source, error: r.error, applied: false }
    return { content: r.source, applied: r.source !== source }
  }
  const r = applyHybridPatch(source, patch as never)
  return { content: r.content, error: r.error, applied: r.content !== source }
}

export async function runOnce(o: RunOptions): Promise<RunResult> {
  const runId = o.runId ?? randomBytes(4).toString('hex')
  const runDir = join(o.outDir, 'runs', runId)
  mkdirSync(join(runDir, '.agile-sofl'), { recursive: true })
  writeFileSync(join(runDir, '.agile-sofl', 'experiment.json'),
    JSON.stringify({ condition: o.condition, participantId: o.participantId ?? `auto-${runId}`, telemetry: true, logPrompts: false }, null, 2))
  const { text: informal, sha256: informalSha256 } = readInformal(o.informalPath)
  const skillId = o.skillId ?? 'hybrid-generation'
  const userText = o.userText ?? DEFAULT_USER_TEXT
  const clarificationForHash =
    o.clarificationAnswer ??
    (o.resolveClarification ? 'dynamic-oracle' : UNMATCHED_CLARIFICATION_REPLY)
  const hash = promptHash({
    informal,
    skillPrompt: skillById(skillId).prompt,
    userText,
    clarification: clarificationForHash,
    ...(o.initialHybridAsfl !== undefined ? { initialHybridSha256: createHash('sha256').update(o.initialHybridAsfl).digest('hex') } : {})
  })
  const maxApprovals = o.maxApprovals ?? 3

  const ctx: AgentTurnContext = {
    projectName: 'pilot', projectRoot: runDir, moduleId: 'project',
    informalMarkdown: informal, hybridAsfl: o.initialHybridAsfl ?? '', skillId, permissions: generationAgentPermissions()
  }
  if (o.initialHybridAsfl !== undefined) writeFileSync(join(runDir, 'hybrid.asfl'), o.initialHybridAsfl)
  const now = new Date().toISOString()
  let session: AgentSession = { id: newId('sess'), moduleId: 'project', title: 'Requirement Analysis', createdAt: now, updatedAt: now, messages: [], context: {} }
  session = await runAgentTurn(session, runDir, ctx, userText)

  let approvals = 0
  let stopReason = 'agent finished'
  for (let guard = 0; guard < 20; guard++) {
    const pending = session.messages.find((m) => m.pending)
    const toolId = session.context.pendingToolCallId
    if (!pending || !toolId) break
    const last = approvals + 1 >= maxApprovals
    if (pending.clarification) {
      const ask: ClarificationAsk = {
        question: String(pending.clarification.question || 'Please clarify.'),
        options: pending.clarification.options,
        multiSelect: pending.clarification.multiSelect,
        allowCustom: pending.clarification.allowCustom
      }
      o.onStudyEvent?.({
        type: 'clarification_asked',
        question: ask.question,
        options: ask.options?.map((x) => x.label),
        multiSelect: ask.multiSelect
      })
      let answerText: string
      if (o.resolveClarification) {
        const resolved = await o.resolveClarification(ask)
        const reply = String(resolved?.text ?? '').trim()
        o.onStudyEvent?.({
          type: 'oracle_reply',
          question: ask.question,
          matched: !resolved?.unmatched && (resolved?.matchedSlotIds?.length ?? 0) > 0,
          unmatched: !!resolved?.unmatched || !reply,
          matchedSlotIds: resolved?.matchedSlotIds ?? [],
          answerPreview: reply.slice(0, 240)
        })
        answerText = reply || UNMATCHED_CLARIFICATION_REPLY
      } else if (o.clarificationAnswer !== undefined) {
        answerText = o.clarificationAnswer
      } else {
        answerText = UNMATCHED_CLARIFICATION_REPLY
      }
      session = await resumeWithToolResult(session, runDir, ctx, toolId, answerText, undefined, !last)
      if (last) { stopReason = 'call budget reached'; break }
      continue
    }
    const patch = pending.proposedChanges!
    let payload: Record<string, unknown>
    let applied = false, applyError: string | undefined
    if (patch.target === 'hybrid') {
      const r = applyHybridProposal(ctx.hybridAsfl ?? '', patch, runDir)
      ctx.hybridAsfl = r.content
      writeFileSync(join(runDir, 'hybrid.asfl'), r.content)
      payload = r.error ? { action: r.applied ? 'applied' : 'error', error: r.error } : { action: 'applied' }
      applied = r.applied; applyError = r.error
    } else {
      payload = { action: 'error', error: `harness only applies hybrid proposals (got ${patch.target})` }
      applyError = String(payload.error)
    }
    approvals++
    const tool = pending.toolCalls?.find((t) => t.id === toolId)?.name ?? (patch.target === 'hybrid' ? 'propose_hybrid_changes' : 'unknown')
    o.onStudyEvent?.({ type: 'proposal', tool, applied, applyError,
      text: JSON.stringify({ explanation: patch.explanation ?? '', operations: patch.operations }) })
    await o.onStep?.({ runId, runDir, step: approvals, hybrid: ctx.hybridAsfl ?? '', tool, applied, applyError })
    session = await resumeWithToolResult(session, runDir, ctx, toolId, JSON.stringify(payload), undefined, approvals < maxApprovals)
    if (approvals >= maxApprovals) { stopReason = 'approval budget reached'; break }
  }
  writeFileSync(join(runDir, 'hybrid.asfl'), ctx.hybridAsfl ?? '')
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, promptHash: hash, informalSha256, skillId, approvals, maxApprovals, stopReason, temperature: PILOT_TEMPERATURE, ...o.manifestExtra }, null, 2))
  return { runId, runDir, condition: o.condition, promptHash: hash, approvals, stopReason, hybridChars: (ctx.hybridAsfl ?? '').length }
}

/** Serial 429-aware fetch: retries HTTP 429/503 with exponential backoff; every retry is appended to retries.log. */
/** Context written into every retries.log line (run id + schedule order; never the condition). */
let retryCtx: () => Record<string, string | number | undefined> = () => ({})
export function setRetryContext(f: () => Record<string, string | number | undefined>): void { retryCtx = f }

/** Local time with UTC offset, e.g. 2026-10-08T01:23:45.678+08:00 */
export function localIso(d = new Date()): string {
  const p = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`
}

const RETRY_STATE = Symbol.for('agile-sofl.harness.retry')
type RetryState = { logFile: string; maxRetries: number; baseMs: number; orig: typeof fetch }
/**
 * Retry HTTP 429/503 with exponential backoff (base 2 s, max 60 s, + jitter). Every retry and every give-up is
 * appended to `logFile` with local timestamp, run id, run order, attempt, status and wait (no condition).
 * Idempotent: a second call only updates the log file / limits.
 */
export function install429Retry(logFile: string, maxRetries = 5, baseMs = 2000): void {
  const g = globalThis as unknown as { [RETRY_STATE]?: RetryState; fetch: typeof fetch }
  const cur = g.fetch as typeof fetch & { [RETRY_STATE]?: RetryState }
  if (cur[RETRY_STATE]) { Object.assign(cur[RETRY_STATE]!, { logFile, maxRetries, baseMs }); return }
  const st: RetryState = { logFile, maxRetries, baseMs, orig: cur }
  const log = (line: string) => {
    const c = retryCtx()
    const ctx = Object.entries(c).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ')
    try { writeFileSync(st.logFile, `${localIso()} ${ctx} ${line}\n`, { flag: 'a' }) } catch { /* ignore */ }
  }
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 1; ; attempt++) {
      const res = await st.orig(input, init)
      if (res.status !== 429 && res.status !== 503) {
        if (attempt > 1) log(`attempt=${attempt} status=${res.status} recovered`)
        return res
      }
      if (attempt > st.maxRetries) { log(`attempt=${attempt} status=${res.status} giving-up after ${st.maxRetries} retries`); return res }
      const wait = Math.min(60_000, st.baseMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * Math.min(500, st.baseMs))
      log(`attempt=${attempt} status=${res.status} retry=${attempt}/${st.maxRetries} wait=${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }) as typeof fetch & { [RETRY_STATE]?: RetryState }
  wrapped[RETRY_STATE] = st
  g.fetch = wrapped
}

/** The prompt hash runOnce will compute for this informal input (default skill/user text/clarification). */
export function expectedPromptHash(informalPath: string, o: { skillId?: string; userText?: string; clarificationAnswer?: string } = {}): string {
  return promptHash({
    informal: readInformal(informalPath).text, skillPrompt: skillById(o.skillId ?? 'hybrid-generation').prompt,
    userText: o.userText ?? DEFAULT_USER_TEXT, clarification: o.clarificationAnswer ?? DEFAULT_CLARIFICATION
  })
}

export function appendKey(outDir: string, r: RunResult & { system: string }): void {
  const f = join(outDir, 'blinding-key.json')
  const all = existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : []
  all.push({ runId: r.runId, condition: r.condition, system: r.system, promptHash: r.promptHash })
  writeFileSync(f, JSON.stringify(all, null, 2))
}
