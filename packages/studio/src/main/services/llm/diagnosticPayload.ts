/** Model-facing diagnostics; complete diagnostics remain available to local telemetry. */
export function compactDiagnosticPayload(payload: {count: number; errors: number; items: Array<{severity?: string; code?: string; source?: string; module?: string; line?: number; column?: number; message?: string}>; semanticChecks?: boolean}) {
  const items: Array<Record<string, unknown>> = []
  let used = 0
  let shortened = false
  for (const d of payload.items.slice(0, 12)) {
    const item = {severity: d.severity, code: d.code?.slice(0, 80), source: d.source?.slice(0, 80),
      module: d.module?.slice(0, 80), line: d.line, column: d.column,
      message: (d.message ?? '').slice(0, 800)}
    if ((d.message?.length ?? 0) > 800) shortened = true
    const size = JSON.stringify(item).length
    if (used + size > 12000) break
    used += size
    items.push(item)
  }
  return {...payload, items, omittedItems: payload.items.length - items.length,
    truncated: shortened || items.length !== payload.items.length,
    diagnosticView: 'At most 12 items, 800 message characters per item, 12000 item characters; full counts retained.'}
}
