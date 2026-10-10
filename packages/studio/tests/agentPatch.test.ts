import { describe, expect, it } from 'vitest'
import {
  assistantTurnIsComplete,
  continuationUserText,
  crudBlockedByFailures,
  failedToolResult,
  nextFailedWrite,
  userInstructionToolResult,
  validateAgentPatch
} from '../src/main/services/llm/agentPatch'
import {
  persistAgentWriteMode,
  readAgentWriteMode,
  AGENT_WRITE_MODE_KEY
} from '../src/renderer/lib/agentWriteMode'

describe('validateAgentPatch', () => {
  it('rejects replace-document dumps', () => {
    const r = validateAgentPatch('hybrid', {
      target: 'hybrid',
      operations: [{ op: 'replace-document', asflText: 'module Foo;\nend_module' }]
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/CRUD/)
  })

  it('rejects end_module inside pre/post fields', () => {
    const r = validateAgentPatch('hybrid', {
      target: 'hybrid',
      operations: [
        {
          op: 'replace-process-body',
          id: 'proc:Demo.P1',
          pre: 'true;\nend_module',
          post: 'ok = 1'
        }
      ]
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/end_module/)
  })

  it('rejects whole-module text on add', () => {
    const r = validateAgentPatch('hybrid', {
      target: 'hybrid',
      operations: [
        {
          op: 'add',
          kind: 'module',
          name: 'Dump',
          text: 'module Dump;\ntype T = nat;\nend_module'
        }
      ]
    })
    expect(r.ok).toBe(false)
  })

  it('accepts modular CRUD adds', () => {
    const r = validateAgentPatch('hybrid', {
      target: 'hybrid',
      operations: [
        { op: 'add', kind: 'module', name: 'OrderMgmt' },
        {
          op: 'add',
          kind: 'type',
          parentId: 'mod:OrderMgmt',
          name: 'TradeRecord',
          text: 'composed of tradeId: string orderId: string end'
        },
        { op: 'add', kind: 'inv', parentId: 'mod:OrderMgmt', name: 'positive', text: 'true' }
      ]
    })
    expect(r.ok).toBe(true)
  })

  it('allows replace-document in source mode', () => {
    const r = validateAgentPatch(
      'hybrid',
      {
        target: 'hybrid',
        mode: 'source',
        operations: [{ op: 'replace-document', text: 'module Foo;\nend_module' }]
      },
      { mode: 'source' }
    )
    expect(r.ok).toBe(true)
  })

  it('accepts unique replace in source mode', () => {
    const r = validateAgentPatch(
      'informal',
      {
        target: 'informal',
        mode: 'source',
        operations: [{ op: 'replace', oldText: '# Login', newText: '# Sign in' }]
      },
      { mode: 'source' }
    )
    expect(r.ok).toBe(true)
  })
})

describe('continuationUserText', () => {
  it('tells the model to read and continue after apply', () => {
    const text = continuationUserText(JSON.stringify({ action: 'applied' }))
    expect(text).toMatch(/read_specification/)
    expect(text).toMatch(/summary/)
    expect(text).toMatch(/Do not wait/)
  })

  it('returns a tool error as a continuation, not a stop', () => {
    const text = continuationUserText(failedToolResult('Unknown hybrid id: proc:用户与权限'))
    expect(text).toMatch(/proc:用户与权限/)
    expect(text).toMatch(/not a stopped session/)
    expect(text).toMatch(/Do not stop/)
    expect(text).toMatch(/propose_source_edit/)
  })

  it('asks the model to interpret a message left on an open change card', () => {
    const raw = userInstructionToolResult('继续，把 Login 标成 operation')
    const text = continuationUserText(raw)
    expect(text).toMatch(/继续，把 Login 标成 operation/)
    expect(text).toMatch(/neither applied nor rejected/)
    expect(text).toMatch(/Do not stop/)
    expect(JSON.parse(raw).type).toBe('user_instruction')
  })

  it('forces source edit after repeated failures', () => {
    const text = continuationUserText(JSON.stringify({ action: 'error', error: 'skip' }), 2)
    expect(text).toMatch(/propose_source_edit/)
    expect(text).toMatch(/view=source/)
  })
})

describe('assistantTurnIsComplete', () => {
  it('treats a text reply with no tools as a finished summary', () => {
    expect(assistantTurnIsComplete('已完成 Informal 规格。', 0)).toBe(true)
  })

  it('keeps the turn open on empty, thinking-only, or tool calls', () => {
    expect(assistantTurnIsComplete('', 0)).toBe(false)
    expect(assistantTurnIsComplete('   ', 0)).toBe(false)
    expect(assistantTurnIsComplete('looking at the error', 1)).toBe(false)
  })
})

describe('crudBlockedByFailures', () => {
  it('blocks the same CRUD fingerprint after a failure', () => {
    const msg = crudBlockedByFailures(
      { fingerprint: 'same', error: 'x', count: 1, mode: 'crud' },
      { fingerprint: 'same', mode: 'crud' }
    )
    expect(msg).toMatch(/already failed/)
    expect(msg).toMatch(/propose_source_edit/)
  })

  it('allows a different patch so refinement can continue after earlier failures', () => {
    const msg = crudBlockedByFailures(
      { fingerprint: 'old', error: 'x', count: 2, mode: 'crud' },
      { fingerprint: 'new', mode: 'crud' }
    )
    expect(msg).toBeNull()
  })

  it('never blocks source edits', () => {
    expect(
      crudBlockedByFailures(
        { fingerprint: 'x', error: 'x', count: 4, mode: 'crud' },
        { fingerprint: 'x', mode: 'source' }
      )
    ).toBeNull()
  })
})

describe('nextFailedWrite', () => {
  it('counts consecutive failures across different fingerprints', () => {
    const first = nextFailedWrite(undefined, { fingerprint: 'a', error: 'e1', mode: 'crud' })
    const second = nextFailedWrite(first, { fingerprint: 'b', error: 'e2', mode: 'crud' })
    expect(first.count).toBe(1)
    expect(second.count).toBe(2)
    expect(crudBlockedByFailures(second, { fingerprint: 'c', mode: 'crud' })).toBeNull()
    expect(crudBlockedByFailures(second, { fingerprint: 'b', mode: 'crud' })).toMatch(/already failed/)
  })
})

describe('agent write mode', () => {
  it('defaults to ask and persists auto', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      }
    }
    expect(readAgentWriteMode(storage)).toBe('ask')
    persistAgentWriteMode(storage, 'auto')
    expect(store.get(AGENT_WRITE_MODE_KEY)).toBe('auto')
    expect(readAgentWriteMode(storage)).toBe('auto')
  })
})
