import { describe, expect, it } from 'vitest'
import { applyHybridPatch } from '../src/hybridPatch.js'
import { formatHybridInventory } from '../src/hybridInventory.js'
import { buildVisualModelTolerant } from '../src/visualParse.js'

/**
 * Agent reads the inventory, then copies fragments into propose_source_edit.
 * Every fragment the inventory shows for an existing clause must occur in the
 * source. Derived reprints (phone <> "" shown as phone <> true) fail that contract.
 */
const SOURCE = `module Lead / SCRM;
type Role = {sales, supervisor};
var
  leads: set of Lead;
process CaptureLead (phone: string, company: string) ok: bool
  pre phone <> ""
  post ok = true
  FSF : phone <> "" and company <> "" && ok = true || others && ok = false
end_process
process ClaimLead (role: Role) ok: bool
  pre true
  post ok = true
  FSF : role = sales and leadStatus(leadId) = waiting && ok = true || others && ok = false
end_process
inv
  leads <> {}
end_module
`

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function inventoryField(inventory: string, label: 'pre' | 'post' | 'fsf'): string[] {
  return inventory
    .split('\n')
    .filter((line) => line.trimStart().startsWith(`${label}:`))
    .map((line) => line.replace(new RegExp(`^\\s*${label}:\\s*`), '').trim())
}

describe('hybrid inventory matches source text', () => {
  const inventory = formatHybridInventory(SOURCE)
  const flat = norm(SOURCE)

  it('shows FSF, pre, and post as slices of the file', () => {
    for (const label of ['fsf', 'pre', 'post'] as const) {
      const values = inventoryField(inventory, label)
      expect(values.length).toBeGreaterThan(0)
      for (const value of values) {
        expect(flat, `${label} not in source: ${value}`).toContain(norm(value))
      }
    }
  })

  it('does not rewrite empty-string comparisons into boolean true', () => {
    expect(inventory).toContain('phone <> ""')
    expect(inventory).not.toContain('phone <> true')
  })

  it('scenario guards are source slices, not a derived reprint', () => {
    expect(inventory).toContain('phone <> "" and company <> ""')
    expect(inventory).toContain('role = sales and leadStatus(leadId) = waiting')
  })

  it('invariant text is the source predicate', () => {
    expect(inventory).toContain('leads <> {}')
  })

  it('a source replace copied from the inventory FSF line changes the file', () => {
    const fsf = inventoryField(inventory, 'fsf').find((line) => line.includes('phone <> ""'))
    expect(fsf).toBeTruthy()
    const next = SOURCE.replace(fsf!, fsf!.replace('phone <> ""', 'phone <> "x"'))
    expect(next).not.toBe(SOURCE)
    const again = formatHybridInventory(next)
    expect(again).toContain('phone <> "x"')
    expect(again).not.toContain('phone <> "" and company')
  })

  it('CRUD pre/post round-trips into the next inventory verbatim', () => {
    const patched = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'replace-process-body',
          id: 'proc:Lead.CaptureLead',
          pre: 'company <> ""',
          post: 'ok = false'
        }
      ]
    })
    expect(patched.content).toContain('company <> ""')
    const next = formatHybridInventory(patched.content)
    expect(next).toContain('pre: company <> ""')
    expect(next).toContain('post: ok = false')
    expect(norm(patched.content)).toContain('company <> ""')
  })

  it('keeps a not-yet-legal FSF token visible in the inventory', () => {
    const withJunk = SOURCE.replace(
      'FSF : phone <> "" and company <> "" && ok = true || others && ok = false',
      'FSF : phone <> "" and company <> "" && ok = true @ || others && ok = false'
    )
    const model = buildVisualModelTolerant(withJunk)
    expect(model.parseFailed).toBe(false)
    const listed = formatHybridInventory(withJunk)
    expect(listed).toContain('@')
    expect(norm(withJunk)).toContain('@')
  })
})
