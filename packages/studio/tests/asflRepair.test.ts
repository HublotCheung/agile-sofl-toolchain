import { collectHybridAgentDiagnostics } from '@agile-sofl/editor-api'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  acceptHybridWrite,
  normalizeHybridPatch,
  repairAsflSurface,
  setHybridWriteDiagnosticCollector
} from '../src/shared/asflRepair'

const loginPost =
  "if credentials_valid = true then CurrentUser = account_of(user_id) and SessionToken > 0 and AuditLog' = AuditLog ^ [login(user_id)] and ok = true else ok = false"

describe('repairAsflSurface', () => {
  it('rewrites the VDM prime and caret from the refinement session', () => {
    const repaired = repairAsflSurface(loginPost)
    expect(repaired.unresolved).toBeNull()
    expect(repaired.text).not.toContain("'")
    expect(repaired.text).not.toContain('^')
    expect(repaired.text).toContain('conc(AuditLog, [login(user_id)])')
    expect(repaired.notes.join(' ')).toMatch(/prime/)
    expect(repaired.notes.join(' ')).toMatch(/conc/)
  })

  it('keeps string literals, char literals, and comments', () => {
    const repaired = repairAsflSurface(`password <> "" and flag = 'a' -- don't use ^ here\nname' = 1`)
    expect(repaired.text).toContain('password <> ""')
    expect(repaired.text).toContain("flag = 'a'")
    expect(repaired.text).toContain("don't")
    expect(repaired.text).toContain('name = 1')
    expect(repaired.text).not.toMatch(/name'/)
  })

  it('is idempotent', () => {
    const once = repairAsflSurface(loginPost)
    const twice = repairAsflSurface(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.notes).toEqual([])
  })

  it('reports a caret it cannot split', () => {
    const repaired = repairAsflSurface('^ orphan')
    expect(repaired.unresolved).toMatch(/\^/)
  })

  it('rewrites iff and VDM-style forall in invariants', () => {
    const repaired = repairAsflSurface(
      'forall u: UserId, deleted_flags(u) = true iff users(u) = deleted'
    )
    expect(repaired.text).toContain('forall[u: UserId] |')
    expect(repaired.text).toContain('implies')
    expect(repaired.text).not.toMatch(/\biff\b/)
  })
})

describe('acceptHybridWrite', () => {
  beforeAll(() => {
    setHybridWriteDiagnosticCollector(collectHybridAgentDiagnostics)
  })

  const before = `module Auth;
process Login (user_id: nat) ok: bool
pre true
post ok = true
end_process
end_module
`

  it('keeps a repaired predicate and does not add lexer errors', () => {
    const after = before.replace('post ok = true', `post ${loginPost}`)
    const gated = acceptHybridWrite(before, after)
    expect(gated.ok).toBe(true)
    expect(gated.content).toContain('conc(AuditLog, [login(user_id)])')
    expect(gated.content).not.toContain('^')
    expect(gated.repairNotes?.length).toBeGreaterThan(0)
  })

  it('refuses a write that still adds a syntax error', () => {
    const after = before.replace('post ok = true', 'post ok = true @')
    const gated = acceptHybridWrite(before, after)
    expect(gated.ok).toBe(false)
    expect(gated.content).toBe(before)
    expect(gated.error).toMatch(/not kept/)
    expect(gated.error).toMatch(/@/)
  })
})

describe('normalizeHybridPatch', () => {
  it('repairs toText and leaves fromText unchanged', () => {
    const normalized = normalizeHybridPatch({
      explanation: 'formalize',
      operations: [{ op: 'refine-step', fromText: "AuditLog'", toText: "AuditLog' = AuditLog ^ [x]" }]
    })
    expect(normalized.unresolved).toBeNull()
    expect(normalized.patch.operations[0]?.fromText).toBe("AuditLog'")
    expect(String(normalized.patch.operations[0]?.toText)).toContain('conc(AuditLog, [x])')
    expect(normalized.patch.explanation).toMatch(/Auto-repaired/)
  })
})
