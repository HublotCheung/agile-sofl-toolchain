import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'harness-ud-'))
writeFileSync(join(userData, 'llm-profiles.json'), JSON.stringify({ activeId: null, profiles: [] }))
vi.mock('electron', () => ({ app: { getPath: () => userData, getAppPath: () => userData }, ipcMain: { handle: () => undefined } }))

import { promptHash, runOnce, UNMATCHED_CLARIFICATION_REPLY } from '../scripts/agent-harness/core'
import { toApiMessages } from '../src/main/services/llm/agentLoop'
import { generationAgentPermissions } from '../src/main/services/llm/agentTypes'

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const toolCall = (name: string, args: unknown) => sse([
  { model: 'mock-model', choices: [{ delta: { tool_calls: [{ index: 0, id: `c-${name}-${Math.random()}`, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { model: 'mock-model', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { model: 'mock-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }
])

afterEach(() => vi.unstubAllGlobals())

describe('headless agent harness', () => {
  it('retains the task and latest steering after a long sequence of tool results', () => {
    const messages: any[] = [{ id: 'u1', role: 'user', content: 'Original maintenance task' },
      { id: 'u2', role: 'user', content: 'Keep the existing permissions' }]
    for (let i = 0; i < 15; i++) {
      messages.push({ id: `a${i}`, role: 'assistant', content: '', toolCalls: [
        { id: `t${i}`, name: 'read_hybrid_specification', arguments: '{}' }
      ] })
      messages.push({ id: `t${i}`, role: 'tool', content: 'specification inventory' })
    }
    const result = toApiMessages({ messages, context: {} } as never,
      { informalMarkdown: '', hybridAsfl: '' }, generationAgentPermissions())
    expect(result.filter(m => m.role === 'user').map(m => m.content))
      .toEqual(['Original maintenance task', 'Keep the existing permissions'])
    const ids = result.flatMap(m => m.tool_calls?.map(c => c.id) ?? [])
    expect(result.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(ids)
  })
  it('preserves and supplies an existing specification for a maintenance task', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const source = 'module SYSTEM_Existing;\nprocess Keep (x: nat) y: nat\nFSF : others && y = x\nend_process\nend_module'
    const fetchMock = vi.fn(async () => sse([
      { model: 'mock-model', choices: [{ delta: { content: 'No change needed.' }, finish_reason: 'stop' }] }
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const inf = join(mkdtempSync(join(tmpdir(), 'maintenance-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Keep\n\nPreserve the existing process.\n')
    const out = mkdtempSync(join(tmpdir(), 'maintenance-out-'))
    const r = await runOnce({ condition: 'T', informalPath: inf, initialHybridAsfl: source,
      outDir: out, userText: 'Inspect the existing Keep process without modifying it.' })
    expect(readFileSync(join(r.runDir, 'hybrid.asfl'), 'utf8')).toBe(source)
    expect(r.approvals).toBe(0)
    // Inventory identifiers omit the SYSTEM_ syntax prefix.
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('proc:Existing.Keep')
  }, 60000)

  it('promptHash is identical for identical inputs and changes with the prompt', () => {
    const base = { informal: 'x', skillPrompt: 'p', userText: 'u', clarification: 'c' }
    expect(promptHash(base)).toBe(promptHash({ ...base }))
    expect(promptHash(base)).not.toBe(promptHash({ ...base, userText: 'v' }))
  })

  it.each(['T', 'B2'] as const)('auto-approves a proposal and logs llm_call / proposal_decision / post_write_diagnostics (%s)', async (condition) => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('propose_hybrid_changes', { explanation: 'add system module', operations: [{ op: 'add', kind: 'module', name: 'SYSTEM_X' }] }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, { model: 'mock-model', choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }])
    ]
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? replies[0]))
    const inf = join(mkdtempSync(join(tmpdir(), 'inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## A\n\nDo A.\n')
    const out = mkdtempSync(join(tmpdir(), 'harness-out-'))
    const events: Array<Record<string, unknown>> = []
    const r = await runOnce({ condition, informalPath: inf, outDir: out, maxApprovals: 1, onStudyEvent: e => events.push(e) })
    expect(events.find(e => e.type === 'proposal')).toMatchObject({ applied: true, tool: 'propose_hybrid_changes' })
    expect(String(events.find(e => e.type === 'proposal')?.text)).toContain('SYSTEM_X')
    expect(r.approvals).toBe(1)
    const lines = readFileSync(join(r.runDir, '.agile-sofl', 'llm-calls.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const call = lines.find((l) => l.event === 'llm_call')
    expect(call).toMatchObject({ model: 'mock-model', promptTokens: 11, completionTokens: 3, ok: true, condition })
    expect(lines.find((l) => l.event === 'proposal_decision')).toMatchObject({ decision: 'approved', tool: 'propose_hybrid_changes' })
    const pw = lines.find((l) => l.event === 'post_write_diagnostics')
    expect(pw.diagnostics.l1.enabled).toBe(condition === 'T')
    expect(pw.diagnostics.l2.enabled).toBe(condition === 'T')
    expect(readFileSync(join(r.runDir, 'hybrid.asfl'), 'utf-8')).toContain('SYSTEM_X')
    expect(JSON.stringify(lines)).not.toContain('sk-testtesttesttest')
  }, 60000)

  it('resolveClarification maps ask_clarification and emits study events (no best-judgement default)', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('ask_clarification', {
        question: 'Who may export grades?',
        options: [{ id: 'teacher', label: 'Teachers only' }, { id: 'admin', label: 'Admins only' }],
        multiSelect: false,
        allowCustom: true
      }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'Noted teacher scope.' }, finish_reason: 'stop' }] }])
    ]
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? replies[0]))
    const inf = join(mkdtempSync(join(tmpdir(), 'clar-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Export\n\nExport grades.\n')
    const out = mkdtempSync(join(tmpdir(), 'clar-out-'))
    const events: Array<Record<string, unknown>> = []
    const resolveClarification = vi.fn(async (ask: { question: string }) => {
      expect(ask.question).toMatch(/export/i)
      return { text: 'Teachers only may export grades.', matchedSlotIds: ['export-scope'], unmatched: false }
    })
    const r = await runOnce({
      condition: 'T',
      informalPath: inf,
      outDir: out,
      maxApprovals: 2,
      userText: 'Implement export permission. Ask when the role scope is unspecified.',
      resolveClarification,
      onStudyEvent: (e) => events.push(e)
    })
    expect(resolveClarification).toHaveBeenCalled()
    expect(events.some((e) => e.type === 'clarification_asked')).toBe(true)
    expect(events.some((e) => e.type === 'oracle_reply' && e.matched === true)).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/best judgement/i)
    expect(UNMATCHED_CLARIFICATION_REPLY).not.toMatch(/best judgement/i)
    expect(r.stopReason).toBe('clarify_without_write')
  }, 60000)

  it('without resolveClarification uses unmatched reply instead of best judgement', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('ask_clarification', { question: 'What login failure threshold?', options: [{ id: 'a', label: '3' }], multiSelect: false }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'Stopped without inventing.' }, finish_reason: 'stop' }] }])
    ]
    const fetchMock = vi.fn(async () => replies.shift() ?? replies[0])
    vi.stubGlobal('fetch', fetchMock)
    const inf = join(mkdtempSync(join(tmpdir(), 'unm-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Login\n\nLogin.\n')
    const out = mkdtempSync(join(tmpdir(), 'unm-out-'))
    await runOnce({ condition: 'T', informalPath: inf, outDir: out, maxApprovals: 2, userText: 'Implement login threshold.' })
    const bodies = fetchMock.mock.calls.map((c) => String(c[1]?.body ?? ''))
    expect(JSON.stringify(bodies)).toContain('Do not invent concrete business defaults')
    expect(JSON.stringify(bodies)).not.toMatch(/best judgement/i)
  }, 60000)

  it('labels clarify-then-no-propose as clarify_without_write (not agent finished)', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('ask_clarification', {
        question: 'Who may export grades?',
        options: [{ id: 'teacher', label: 'Teachers only' }],
        multiSelect: false
      }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] }])
    ]
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? replies[0]))
    const inf = join(mkdtempSync(join(tmpdir(), 'cww-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Export\n\nExport grades.\n')
    const out = mkdtempSync(join(tmpdir(), 'cww-out-'))
    const r = await runOnce({
      condition: 'T', informalPath: inf, outDir: out, maxApprovals: 2,
      userText: 'Implement export permission. Ask when role scope is unspecified.',
      resolveClarification: async () => ({ text: 'Teachers only.', matchedSlotIds: ['export-scope'], unmatched: false })
    })
    expect(r.approvals).toBe(0)
    expect(r.stopReason).toBe('clarify_without_write')
    const manifest = JSON.parse(readFileSync(join(r.runDir, 'manifest.json'), 'utf8'))
    expect(manifest.stopReason).toBe('clarify_without_write')
    expect(manifest.clarificationsAnswered).toBe(1)
  }, 60000)

  it('breaks post-clarify consecutive spec-read spin with fair budget (no force-propose)', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('ask_clarification', { question: 'Threshold?', options: [{ id: 'a', label: '3' }], multiSelect: false }),
      // After answer: 4 consecutive read_hybrid (cap=3) → 4th denied, turn ends; no propose nudge
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'should not reach' }, finish_reason: 'stop' }] }])
    ]
    const fetchMock = vi.fn(async () => replies.shift() ?? replies[replies.length - 1])
    vi.stubGlobal('fetch', fetchMock)
    const inf = join(mkdtempSync(join(tmpdir(), 'spin-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Login\n\nLogin.\n')
    const out = mkdtempSync(join(tmpdir(), 'spin-out-'))
    const r = await runOnce({
      condition: 'T', informalPath: inf, outDir: out, maxApprovals: 3,
      userText: 'Implement login. Clarify threshold then continue.',
      resolveClarification: async () => ({ text: 'Use 3.', matchedSlotIds: ['login-threshold'], unmatched: false })
    })
    expect(r.approvals).toBe(0)
    expect(r.stopReason).toBe('clarify_without_write')
    // ask + 3 allowed reads + 4th denied ends turn — no further completion / no force-propose nudge
    expect(fetchMock.mock.calls.length).toBe(5)
    const sessDir = join(r.runDir, '.agile-sofl', 'agent', 'sessions')
    const sessFile = readdirSync(sessDir).find((f) => f.startsWith('sess-') && f.endsWith('.json'))
    expect(sessFile).toBeTruthy()
    const session = JSON.parse(readFileSync(join(sessDir, sessFile!), 'utf8'))
    const toolBodies = session.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content)
    expect(JSON.stringify(toolBodies)).toContain('post_clarify_read_budget_exhausted')
    const bodies = fetchMock.mock.calls.map((c) => String(c[1]?.body ?? ''))
    expect(JSON.stringify(bodies)).not.toMatch(/you must propose|force propose|nudge.*propose/i)
  }, 60000)

  it('does not cap pre-clarify multi-module spec reads', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      toolCall('read_hybrid_specification', { view: 'inventory' }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'Inspected five times.' }, finish_reason: 'stop' }] }])
    ]
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? replies[0]))
    const inf = join(mkdtempSync(join(tmpdir(), 'preread-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Keep\n\nPreserve.\n')
    const out = mkdtempSync(join(tmpdir(), 'preread-out-'))
    const source = 'module SYSTEM_Existing;\nprocess Keep (x: nat) y: nat\nFSF : others && y = x\nend_process\nend_module'
    const r = await runOnce({
      condition: 'T', informalPath: inf, outDir: out, maxApprovals: 1,
      initialHybridAsfl: source,
      userText: 'Inspect the existing Keep process without modifying it.'
    })
    expect(r.approvals).toBe(0)
    expect(r.stopReason).toBe('agent finished')
  }, 60000)

  it('clarify then propose is not labeled clarify_without_write', async () => {
    process.env.ECNU_API_KEY = 'sk-testtesttesttest'
    const replies = [
      toolCall('ask_clarification', { question: 'Who exports?', options: [{ id: 't', label: 'Teachers' }], multiSelect: false }),
      toolCall('propose_hybrid_changes', { explanation: 'add module', operations: [{ op: 'add', kind: 'module', name: 'SYSTEM_X' }] }),
      sse([{ model: 'mock-model', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }])
    ]
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? replies[0]))
    const inf = join(mkdtempSync(join(tmpdir(), 'cprop-inf-')), 'x.aspec')
    writeFileSync(inf, '# Functions\n\n## Export\n\nExport.\n')
    const out = mkdtempSync(join(tmpdir(), 'cprop-out-'))
    const r = await runOnce({
      condition: 'T', informalPath: inf, outDir: out, maxApprovals: 2,
      userText: 'Clarify then write.',
      resolveClarification: async () => ({ text: 'Teachers.', matchedSlotIds: ['export-scope'], unmatched: false })
    })
    expect(r.approvals).toBeGreaterThanOrEqual(1)
    expect(r.stopReason).not.toBe('clarify_without_write')
  }, 60000)
})
