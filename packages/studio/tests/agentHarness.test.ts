import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'harness-ud-'))
writeFileSync(join(userData, 'llm-profiles.json'), JSON.stringify({ activeId: null, profiles: [] }))
vi.mock('electron', () => ({ app: { getPath: () => userData, getAppPath: () => userData }, ipcMain: { handle: () => undefined } }))

import { promptHash, runOnce } from '../scripts/agent-harness/core'

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
    const r = await runOnce({ condition, informalPath: inf, outDir: out, maxApprovals: 1 })
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
})
