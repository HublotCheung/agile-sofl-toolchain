/**
 * Experiment switch + per-call LLM telemetry (evaluation of LLM-assisted hybrid spec construction).
 *
 * Configuration (env overrides <projectRoot>/.agile-sofl/experiment.json):
 *   AGILE_SOFL_CONDITION   paper condition: "T" (full tool: agent + parser + L1 + L2; DEFAULT, so an
 *                          unset config never runs a control group) or "B2" (agent + parser feedback
 *                          only, L1/L2 off). "B0"/"B1" are baselines run OUTSIDE this tool (B1 = generic
 *                          chat LLM); the studio has no B0/B1 mode: if set, behaviour is identical to T
 *                          and only the label is recorded, with a warning. Unknown labels likewise.
 *   AGILE_SOFL_PARTICIPANT participant id (default "anonymous")
 *   AGILE_SOFL_TELEMETRY   "0" disables the JSONL log (default on)
 *   AGILE_SOFL_LOG_PROMPTS "1" also logs full prompt messages (default off)
 *   experiment.json: { "condition": "B2", "participantId": "P07", "telemetry": true, "logPrompts": false }
 *
 * Exact behaviour of condition B2 ("agent on, no checks"):
 *   - parser syntax / scope / type diagnostics are STILL fed back to the agent, and the forced
 *     post-write re-read (read_hybrid_specification after every applied write) still happens;
 *   - only the L1 (ASFL_FSF_101-104) and L2 (ASFL_FSF_201-209) semantic FSF checks are disabled:
 *     they are not run and not fed back to the agent;
 *   - telemetry still records them, as 0 counts with enabled=false.
 * In every other condition L1 and L2 diagnostics are added to the agent's diagnostics payload.
 *
 * Telemetry: one JSON object per line in <projectRoot>/.agile-sofl/llm-calls.jsonl.
 * API keys are never logged; prompts only when logPrompts is on (otherwise only their size).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, checkFsfL1, checkFsfL2, type Diagnostic } from '@agile-sofl/parser'

export interface ExperimentConfig {
  condition: string
  participantId: string
  /** L1 + L2 semantic checks run and are fed back to the agent */
  semanticChecks: boolean
  telemetry: boolean
  logPrompts: boolean
}

export function getExperimentConfig(projectRoot?: string, env: NodeJS.ProcessEnv = process.env): ExperimentConfig {
  let file: Partial<{ condition: string; participantId: string; telemetry: boolean; logPrompts: boolean }> = {}
  if (projectRoot) {
    const p = join(projectRoot, '.agile-sofl', 'experiment.json')
    try {
      if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf-8'))
    } catch { /* ignore malformed file */ }
  }
  const condition = String(env.AGILE_SOFL_CONDITION || file.condition || 'T').trim().toUpperCase() || 'T'
  const participantId = String(env.AGILE_SOFL_PARTICIPANT || file.participantId || 'anonymous').trim()
  const telemetry = env.AGILE_SOFL_TELEMETRY !== undefined ? env.AGILE_SOFL_TELEMETRY !== '0' : file.telemetry !== false
  const logPrompts = env.AGILE_SOFL_LOG_PROMPTS !== undefined ? env.AGILE_SOFL_LOG_PROMPTS === '1' : file.logPrompts === true
  return { condition, participantId, semanticChecks: condition.toUpperCase() !== 'B2', telemetry, logPrompts }
}

export const isL1Code = (code: string) => /^ASFL_FSF_1\d\d$/.test(code)
export const isL2Code = (code: string) => /^ASFL_FSF_2\d\d$/.test(code)

export interface SeverityCount { error: number; warning: number }
export interface DiagnosticCounts {
  parser: SeverityCount
  /** enabled = condition turns the layer on; ran = it actually ran (false when disabled or the spec has no AST) */
  l1: SeverityCount & { enabled: boolean; ran: boolean }
  l2: SeverityCount & { enabled: boolean; ran: boolean }
}

const count = (ds: Diagnostic[]): SeverityCount => ({
  error: ds.filter((d) => d.severity === 'error').length,
  warning: ds.filter((d) => d.severity === 'warning').length
})

/** L1 + L2 diagnostics for the agent (empty when semantic checks are disabled, i.e. B2). */
export async function semanticDiagnostics(asfl: string, cfg: ExperimentConfig): Promise<Diagnostic[]> {
  if (!cfg.semanticChecks || !asfl.trim()) return []
  const r = check(asfl, { fsfL1: false })
  if (!r.ast) return []
  return [...checkFsfL1(r.ast).diagnostics, ...(await checkFsfL2(r.ast)).diagnostics]
}

/** Post-write diagnostic counts split by layer (parser = parse/scope/type/FSF-classify/CDFD/data). */
export async function diagnosticCounts(asfl: string, cfg: ExperimentConfig): Promise<DiagnosticCounts> {
  const r = check(asfl, { fsfL1: false })
  const parser = count(r.diagnostics.filter((d) => !isL1Code(d.code) && !isL2Code(d.code)))
  if (!cfg.semanticChecks || !r.ast) {
    return { parser, l1: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false }, l2: { error: 0, warning: 0, enabled: cfg.semanticChecks, ran: false } }
  }
  const l1 = count(checkFsfL1(r.ast).diagnostics)
  const l2 = count((await checkFsfL2(r.ast)).diagnostics)
  return { parser, l1: { ...l1, enabled: true, ran: true }, l2: { ...l2, enabled: true, ran: true } }
}

export type TelemetryEvent =
  | { event: 'llm_call'; model: string; promptTokens: number | null; completionTokens: number | null; latencyMs: number; ok: boolean; reasoning?: 'low' | 'off' | string; attempt?: number; retryReason?: string; finishReason?: string; toolCalls?: string[]; promptChars?: number; prompt?: unknown; error?: string }
  | { event: 'proposal_decision'; tool: string; stepType?: string; decision: 'approved' | 'rejected' | 'error'; toolCallId: string }
  | { event: 'session_start'; semanticChecks: boolean; warning?: string }
  | { event: 'full_read_diagnostics'; toolCallId: string; diagnostics: unknown }
  | { event: 'post_write_diagnostics'; toolCallId: string; diagnostics: DiagnosticCounts }

export function telemetryPath(projectRoot: string): string {
  return join(projectRoot, '.agile-sofl', 'llm-calls.jsonl')
}

const SECRET_KEYS = /^(api[-_]?key|authorization|token|secret|password)$/i
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(x)
    return o
  }
  if (typeof v === 'string') return v.replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g, '[redacted]')
  return v
}

export function logTelemetry(
  projectRoot: string | undefined,
  cfg: ExperimentConfig,
  sessionId: string,
  ev: TelemetryEvent
): void {
  if (!projectRoot || !cfg.telemetry) return
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    sessionId,
    participantId: cfg.participantId,
    condition: cfg.condition,
    ...ev
  }
  if (!cfg.logPrompts) delete rec.prompt
  try {
    mkdirSync(join(projectRoot, '.agile-sofl'), { recursive: true })
    appendFileSync(telemetryPath(projectRoot), JSON.stringify(scrub(rec)) + '\n', 'utf-8')
  } catch { /* telemetry must never break the agent */ }
}

export const KNOWN_CONDITIONS = ['T', 'B2'] as const

/** Human-readable startup notice of the active condition (always a warning so it is visible in logs). */
export function conditionNotice(cfg: ExperimentConfig): string {
  const mode = cfg.semanticChecks ? 'full tool: agent + parser + L1 + L2' : 'agent + parser feedback only; L1/L2 disabled'
  let msg = `[agile-sofl experiment] active condition=${cfg.condition} (${mode}), participant=${cfg.participantId}`
  if (cfg.condition === 'B0' || cfg.condition === 'B1') msg += ` — WARNING: ${cfg.condition} is an external baseline not implemented in the studio; running as T`
  else if (!(KNOWN_CONDITIONS as readonly string[]).includes(cfg.condition)) msg += ` — WARNING: unknown condition label; running as T`
  return msg
}

const announced = new Set<string>()
/** console.warn the active condition and log a session_start telemetry event (once per project+session). */
export function announceCondition(projectRoot: string | undefined, sessionId: string, cfg = getExperimentConfig(projectRoot)): string {
  const msg = conditionNotice(cfg)
  const key = `${projectRoot ?? ''}\0${sessionId}`
  if (announced.has(key)) return msg
  announced.add(key)
  console.warn(msg)
  logTelemetry(projectRoot, cfg, sessionId, { event: 'session_start', semanticChecks: cfg.semanticChecks, warning: msg })
  return msg
}
