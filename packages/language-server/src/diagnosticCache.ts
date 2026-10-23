/**
 * Cached diagnostics keyed by document version + content hash.
 */

import { createHash } from 'node:crypto'
import { checkIncremental } from '@agile-sofl/parser'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Diagnostic } from 'vscode-languageserver/node.js'
import { parserDiagnosticsToLsp } from './lsp-utils.js'
import type { IncrementalCheckState } from '@agile-sofl/parser'

interface DiagnosticCacheEntry {
  version: number
  contentHash: string
  diagnostics: Diagnostic[]
  incrementalState?: IncrementalCheckState
}

const diagnosticCache = new Map<string, DiagnosticCacheEntry>()
const incrementalStates = new Map<string, IncrementalCheckState>()

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Cached check pipeline keyed by document version + content hash. */
export function diagnosticsForDocument(document: TextDocument): Diagnostic[] {
  const uri = document.uri
  const text = document.getText()
  const hash = contentHash(text)
  const cached = diagnosticCache.get(uri)
  if (cached && cached.version === document.version && cached.contentHash === hash) {
    return cached.diagnostics
  }
  const prev = incrementalStates.get(uri)
  const { diagnostics, state } = checkIncremental(text, prev)
  incrementalStates.set(uri, state)
  const lspDiagnostics = parserDiagnosticsToLsp(diagnostics, text, uri)
  diagnosticCache.set(uri, { version: document.version, contentHash: hash, diagnostics: lspDiagnostics, incrementalState: state })
  return lspDiagnostics
}

/** @internal test helper */
export function clearDiagnosticCache(): void {
  diagnosticCache.clear()
  incrementalStates.clear()
}
