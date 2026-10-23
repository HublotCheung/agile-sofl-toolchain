import { describe, it, expect } from 'vitest'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { collectDiagnostics } from '../src/diagnostics.js'
import { diagnosticsForDocument, clearDiagnosticCache } from '../src/diagnosticCache.js'

function doc(source: string, version = 1, uri = 'file:///test.asfl'): TextDocument {
  return TextDocument.create(uri, 'agile-sofl', version, source)
}

describe('Diagnostics', () => {
  it('reports ASFL_SCOPE_001 for undefined symbol in FSF', () => {
    const source = `module SYSTEM_U;
process P ()
FSF :
others && ghost > 0
end_process
end_module`
    const diagnostics = collectDiagnostics(doc(source))
    const scopeErrors = diagnostics.filter((d) => d.code === 'ASFL_SCOPE_001')
    expect(scopeErrors.length).toBeGreaterThanOrEqual(1)
    expect(scopeErrors[0].message).toContain('Undefined')
  })

  it('does not report ASFL_SCOPE_001 for valid banking-style reference', () => {
    const source = `module SYSTEM_E;
process Worker ()
ext
rd total: int
FSF :
others && total > 0
end_process
end_module`
    const diagnostics = collectDiagnostics(doc(source))
    expect(diagnostics.filter((d) => d.code === 'ASFL_SCOPE_001')).toHaveLength(0)
  })

  it('maps ASFL_SCOPE_001 to LSP error severity', () => {
    const source = `module SYSTEM_U;
var x: MissingType;
end_module`
    const diagnostics = collectDiagnostics(doc(source))
    const scopeError = diagnostics.find((d) => d.code === 'ASFL_SCOPE_001')
    expect(scopeError?.severity).toBe(1)
  })
})

describe('Diagnostic cache', () => {
  it('reuses results for same version and content', () => {
    clearDiagnosticCache()
    const source = 'module SYSTEM_T; var x: nat; end_module'
    const document = doc(source, 2, 'file:///cache-test.asfl')
    const first = diagnosticsForDocument(document)
    const second = diagnosticsForDocument(document)
    expect(second).toBe(first)
  })

  it('builds LSP ranges for documents that have diagnostics', () => {
    clearDiagnosticCache()
    const source = `module SYSTEM_U;
var x: MissingType;
end_module`
    const diagnostics = diagnosticsForDocument(doc(source, 1, 'file:///diag-pos.asfl'))
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics[0].range.start.line).toBeGreaterThanOrEqual(0)
    expect(diagnostics[0].range.end.character).toBeGreaterThan(0)
  })

  it('recomputes when document version changes', () => {
    clearDiagnosticCache()
    const uri = 'file:///cache-version.asfl'
    const v1 = doc('module SYSTEM_T; var x: nat; end_module', 1, uri)
    const v2 = doc('module SYSTEM_T; var y: nat; end_module', 2, uri)
    const first = diagnosticsForDocument(v1)
    const second = diagnosticsForDocument(v2)
    expect(second).not.toBe(first)
  })
})
