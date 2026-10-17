import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { announceCondition, conditionNotice, getExperimentConfig, semanticDiagnostics, diagnosticCounts, logTelemetry, telemetryPath } from '../src/main/services/llm/experiment'
// @ts-expect-error plain ESM script without types
import { analyze, readJsonl } from '../scripts/analyze-llm-calls.mjs'

const spec = `module SYSTEM_T;\nprocess P (x: int) r: int\nFSF :\n r > 0 && r = 1 ||\n x > 0 && x = 1\nend_process\nend_module.`
const parseBroken = `module SYSTEM_T;\nprocess P (x: int) r: int\nFSF :\n x > && r = 1\nend_process\nend_module.`

describe('experiment condition switch', () => {
  it('defaults to T with semantic checks on; B2 disables them', () => {
    expect(getExperimentConfig(undefined, {})).toMatchObject({ condition: 'T', semanticChecks: true, participantId: 'anonymous', telemetry: true, logPrompts: false })
    expect(getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'B2', AGILE_SOFL_PARTICIPANT: 'P07' })).toMatchObject({ condition: 'B2', semanticChecks: false, participantId: 'P07' })
  })

  it('reads .agile-sofl/experiment.json, env overrides it', () => {
    const root = mkdtempSync(join(tmpdir(), 'exp-'))
    mkdirSync(join(root, '.agile-sofl'))
    writeFileSync(join(root, '.agile-sofl', 'experiment.json'), JSON.stringify({ condition: 'B2', participantId: 'P03' }))
    expect(getExperimentConfig(root, {})).toMatchObject({ condition: 'B2', participantId: 'P03', semanticChecks: false })
    expect(getExperimentConfig(root, { AGILE_SOFL_CONDITION: 'T' }).semanticChecks).toBe(true)
  })

  it('B2: L1/L2 not run and not fed back; parser diagnostics still counted', async () => {
    const b1 = getExperimentConfig(undefined, {})
    const b2 = getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'B2' })
    const sem = await semanticDiagnostics(spec, b1)
    expect(sem.map((d) => d.code)).toContain('ASFL_FSF_101')
    expect(await semanticDiagnostics(spec, b2)).toEqual([])
    const c1 = await diagnosticCounts(spec, b1)
    expect(c1.l1.error).toBeGreaterThan(0)
    expect(c1.l1.enabled).toBe(true)
    expect(c1.l1.ran).toBe(true)
    expect(c1.l2.ran).toBe(true)
    const c2 = await diagnosticCounts(spec, b2)
    expect(c2.l1).toEqual({ error: 0, warning: 0, enabled: false, ran: false })
    expect(c2.l2).toEqual({ error: 0, warning: 0, enabled: false, ran: false })
    const broken = await diagnosticCounts(parseBroken, b2)
    expect(broken.parser.error).toBeGreaterThan(0)
  }, 60000)
})

describe('LLM telemetry JSONL + analysis', () => {
  it('logs events without API keys or prompts by default and the script computes rates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tel-'))
    const cfg = getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'B2', AGILE_SOFL_PARTICIPANT: 'P01' })
    logTelemetry(root, cfg, 's1', { event: 'llm_call', model: 'm-1', promptTokens: 100, completionTokens: 20, latencyMs: 1500, ok: true, promptChars: 900, prompt: [{ role: 'user', content: 'secret prompt sk-abcdefghijkl' }], error: 'Bearer sk-zzzzzzzzzzzz' } as any)
    logTelemetry(root, cfg, 's1', { event: 'proposal_decision', tool: 'propose_refinement_step', stepType: 'FormalizePredicate', decision: 'approved', toolCallId: 'a' })
    logTelemetry(root, cfg, 's1', { event: 'proposal_decision', tool: 'propose_refinement_step', stepType: 'DecomposeProcess', decision: 'rejected', toolCallId: 'b' })
    logTelemetry(root, cfg, 's1', { event: 'post_write_diagnostics', toolCallId: 'a', diagnostics: await diagnosticCounts(spec, cfg) })
    const raw = readFileSync(telemetryPath(root), 'utf-8')
    expect(raw).not.toContain('secret prompt')
    expect(raw).not.toMatch(/sk-[a-z]{8}/)
    const recs = readJsonl([telemetryPath(root)])
    expect(recs).toHaveLength(4)
    expect(recs[0]).toMatchObject({ sessionId: 's1', participantId: 'P01', condition: 'B2', model: 'm-1', promptTokens: 100, completionTokens: 20, latencyMs: 1500 })
    const [res] = analyze(recs, 'condition')
    expect(res.group).toBe('B2')
    expect(res.llmCalls).toBe(1)
    expect(res.refinementSteps.approvalRate).toBe(0.5)
    expect(res.refinementByStepType.FormalizePredicate.approvalRate).toBe(1)
    expect(res.postWrite.writes).toBe(1)
    expect(res.postWrite.mean.l1_error).toBe(0)
  }, 60000)

  it('telemetry can be disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'tel-'))
    const cfg = getExperimentConfig(undefined, { AGILE_SOFL_TELEMETRY: '0' })
    logTelemetry(root, cfg, 's', { event: 'proposal_decision', tool: 't', decision: 'approved', toolCallId: 'x' })
    expect(() => readFileSync(telemetryPath(root))).toThrow()
  })
})

describe('condition default + startup notice', () => {
  it('unset config runs full tool T; B0/B1/unknown warn and run as T', () => {
    expect(getExperimentConfig(undefined, {}).condition).toBe('T')
    expect(conditionNotice(getExperimentConfig(undefined, {}))).toMatch(/condition=T \(full tool/)
    for (const c of ['B0', 'b1', 'X9']) {
      const cfg = getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: c })
      expect(cfg.semanticChecks).toBe(true)
      expect(conditionNotice(cfg)).toMatch(/WARNING/)
    }
    expect(conditionNotice(getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'B2' }))).toMatch(/L1\/L2 disabled/)
  })
  it('announceCondition warns once and logs session_start', () => {
    const root = mkdtempSync(join(tmpdir(), 'ann-'))
    const cfg = getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'B2' })
    announceCondition(root, 'sx', cfg)
    announceCondition(root, 'sx', cfg)
    const recs = readJsonl([telemetryPath(root)])
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ event: 'session_start', condition: 'B2', semanticChecks: false })
  })
})

describe('reasoning / retry telemetry', () => {
  it('reasoningEffortFor matches the request body and analysis reports off-share + retry rate', async () => {
    const { reasoningEffortFor } = await import('../src/main/services/llm/chatEcnu')
    expect(reasoningEffortFor(true)).toBe('low')
    expect(reasoningEffortFor(undefined)).toBe('low')
    expect(reasoningEffortFor(false)).toBe('off')
    const { retryReasonOf } = await import('../src/main/services/llm/agentLoop')
    expect(retryReasonOf(new Error('HTTP 400 Bearer sk-abcdefghijkl bad thinking'))).toMatch(/^HTTP 400: .*\[redacted\]/)
    const root = mkdtempSync(join(tmpdir(), 'rsn-'))
    const cfg = getExperimentConfig(undefined, { AGILE_SOFL_CONDITION: 'T' })
    const call = (o: object) => logTelemetry(root, cfg, 's', { event: 'llm_call', model: 'm', promptTokens: 1, completionTokens: 1, latencyMs: 1, ok: true, ...o } as any)
    call({ reasoning: 'low', attempt: 1, ok: false })
    call({ reasoning: 'off', attempt: 2, retryReason: 'HTTP 400: x' })
    call({ reasoning: 'low', attempt: 1 })
    call({ reasoning: 'low', attempt: 1 })
    const recs = readJsonl([telemetryPath(root)])
    expect(recs[1]).toMatchObject({ reasoning: 'off', attempt: 2, retryReason: 'HTTP 400: x' })
    const [res] = analyze(recs, 'condition')
    expect(res.reasoningOffShare).toBe(0.25)
    expect(res.retryRate).toBeCloseTo(1 / 3, 3)
  })
})

describe('freeze v1.2: reasoning off', () => {
  it('agent first attempt sends thinking disabled (reasoning off)', async () => {
    const { AGENT_THINKING } = await import('../src/main/services/llm/agentLoop')
    const { reasoningEffortFor } = await import('../src/main/services/llm/chatEcnu')
    expect(AGENT_THINKING).toBe(false)
    expect(reasoningEffortFor(AGENT_THINKING)).toBe('off')
  })
  it('stream request body omits reasoning_effort and disables thinking', async () => {
    const { buildStreamBody } = await import('../src/main/services/llm/chatEcnu')
    const off = buildStreamBody({ messages: [{ role: 'user', content: 'x' }], thinking: false })
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
    const on = buildStreamBody({ messages: [{ role: 'user', content: 'x' }], thinking: true })
    expect(on).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low', stream: true, temperature: 0.35 })
  })

  it('stream request body always sets max_tokens (default or explicit)', async () => {
    const prev = process.env.ECNU_MAX_TOKENS
    delete process.env.ECNU_MAX_TOKENS
    try {
      const { buildStreamBody, DEFAULT_STREAM_MAX_TOKENS, resolveStreamMaxTokens } = await import(
        '../src/main/services/llm/chatEcnu'
      )
      expect(resolveStreamMaxTokens()).toBe(DEFAULT_STREAM_MAX_TOKENS)
      const body = buildStreamBody({ messages: [{ role: 'user', content: 'x' }], thinking: false })
      expect(body.max_tokens).toBe(DEFAULT_STREAM_MAX_TOKENS)
      expect(body.max_tokens).toBe(8192)
      const custom = buildStreamBody({
        messages: [{ role: 'user', content: 'x' }],
        thinking: false,
        maxTokens: 2048
      })
      expect(custom.max_tokens).toBe(2048)
      process.env.ECNU_MAX_TOKENS = '4096'
      expect(resolveStreamMaxTokens()).toBe(4096)
      const fromEnv = buildStreamBody({ messages: [{ role: 'user', content: 'x' }], thinking: false })
      expect(fromEnv.max_tokens).toBe(4096)
    } finally {
      if (prev === undefined) delete process.env.ECNU_MAX_TOKENS
      else process.env.ECNU_MAX_TOKENS = prev
    }
  })
})
