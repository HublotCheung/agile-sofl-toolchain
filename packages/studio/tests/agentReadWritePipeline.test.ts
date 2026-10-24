import { collectHybridAgentDiagnostics, formatHybridInventory } from '@agile-sofl/editor-api'
import { beforeAll, describe, expect, it } from 'vitest'
import { acceptHybridWrite, setHybridWriteDiagnosticCollector } from '../src/shared/asflRepair'
import { applySourceEdits, numberedSource } from '../src/shared/sourceEdit'

/**
 * The agent loop is: read inventory or numbered source → propose a patch →
 * apply → read again. These tests lock that contract without an LLM.
 * A fragment shown in the inventory must be usable as source-edit oldText,
 * and a kept write must be what the next read sees.
 */
const SOURCE = `module Lead / SCRM;
process CaptureLead (phone: string) ok: bool
  pre phone <> ""
  post ok = true
  FSF : phone <> "" && ok = true || others && ok = false
end_process
end_module
`

function field(inventory: string, label: string): string {
  const line = inventory.split('\n').find((row) => row.trimStart().startsWith(`${label}:`))
  if (!line) throw new Error(`missing ${label}`)
  return line.replace(new RegExp(`^\\s*${label}:\\s*`), '').trim()
}

describe('agent read/write pipeline', () => {
  beforeAll(() => {
    setHybridWriteDiagnosticCollector(collectHybridAgentDiagnostics)
  })

  it('source-edits the FSF using the exact inventory line', () => {
    const fsf = field(formatHybridInventory(SOURCE), 'fsf')
    const edited = applySourceEdits(SOURCE, [
      { op: 'replace', oldText: fsf, newText: fsf.replace('phone <> ""', 'phone <> "x"') }
    ])
    expect(edited.error).toBeUndefined()
    expect(edited.content).toContain('phone <> "x"')
    expect(formatHybridInventory(edited.content)).toContain('phone <> "x"')
    expect(formatHybridInventory(edited.content)).not.toContain('phone <> true')
  })

  it('rejects a derived predicate that is not in the file', () => {
    const edited = applySourceEdits(SOURCE, [
      { op: 'replace', oldText: 'FSF : phone <> true && ok = true', newText: 'FSF : true' }
    ])
    expect(edited.applied).toBe(false)
    expect(edited.content).toBe(SOURCE)
  })

  it('keeps an illegal token and the next inventory shows that same token', () => {
    const after = SOURCE.replace('ok = true', 'ok = true @')
    const gated = acceptHybridWrite(SOURCE, after)
    expect(gated.committed).toBe(true)
    expect(gated.content).toContain('@')
    expect(formatHybridInventory(gated.content)).toContain('@')
  })

  it('numbered source lines match the buffer the inventory was built from', () => {
    const numbered = numberedSource(SOURCE)
    const body = numbered
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\|\s?/, ''))
      .join('\n')
    expect(body.trimEnd()).toBe(SOURCE.trimEnd())
  })
})
