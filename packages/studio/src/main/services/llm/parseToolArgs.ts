export type ParsedToolArgs =
  | {
      ok: true
      value: Record<string, unknown>
      repaired: boolean
      droppedPartialOperation: boolean
    }
  | { ok: false; error: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function sliceFirstJsonValue(raw: string): string | null {
  const obj = raw.indexOf('{')
  const arr = raw.indexOf('[')
  let start = -1
  if (obj < 0) start = arr
  else if (arr < 0) start = obj
  else start = Math.min(obj, arr)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}

function closeTruncatedJson(raw: string): { text: string; closedString: boolean } | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  const source = raw.slice(start)
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if ((c === '}' || c === ']') && stack[stack.length - 1] === c) stack.pop()
  }
  let text = source
  if (inStr) {
    if (text.endsWith('\\')) text += '\\'
    text += '"'
  }
  text = text.replace(/,\s*$/, '')
  while (stack.length) text += stack.pop()
  return { text, closedString: inStr }
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

function inflateOperations(value: Record<string, unknown>): void {
  if (typeof value.operations !== 'string') return
  const raw = value.operations.trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      value.operations = parsed
      return
    }
    const record = asRecord(parsed)
    if (record && Array.isArray(record.operations)) value.operations = record.operations
  } catch {
    const closed = closeTruncatedJson(raw.startsWith('{') ? raw : `{"operations":${raw}`)
    if (!closed) return
    const parsed = tryParse(closed.text)
    if (parsed && Array.isArray(parsed.operations)) value.operations = parsed.operations
  }
}

function dropPartialOperation(value: Record<string, unknown>): boolean {
  const ops = value.operations
  if (!Array.isArray(ops) || ops.length < 2) return false
  ops.pop()
  return true
}

function truncatedWholeDocument(value: Record<string, unknown>): boolean {
  const ops = value.operations
  if (!Array.isArray(ops) || ops.length !== 1) return false
  const op = asRecord(ops[0])
  if (!op) return false
  const kind = String(op.op || op.action || '')
  return kind === 'replace-document' || kind === 'replace-html'
}

/** True when the provider stopped because the completion hit max_tokens / length. */
export function isLengthFinishReason(finishReason: string | undefined | null): boolean {
  if (!finishReason) return false
  const normalized = finishReason.trim().toLowerCase()
  return normalized === 'length' || normalized === 'max_tokens'
}

export type ParseToolArgsOptions = {
  /** When the stream ended due to length/max_tokens, refuse repair and hard-fail. */
  finishReason?: string
}

/**
 * Parse model tool-call arguments.
 * Accepts trailing junk after a complete JSON value, and a payload cut off
 * mid-string (typical when a long GUI patch hits the output limit).
 *
 * When finishReason is length/max_tokens, never silently repair truncated JSON
 * into a successful tool call -- return a clear error instead.
 */
export function parseToolArguments(raw: string, options?: ParseToolArgsOptions): ParsedToolArgs {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Tool arguments were empty.' }
  if (isLengthFinishReason(options?.finishReason)) {
    return {
      ok: false,
      error:
        'Model output was truncated (finish_reason=' +
        String(options?.finishReason) +
        ', ' +
        String(trimmed.length) +
        ' characters). Do not treat partial tool JSON as success. Split into smaller tool calls or increase max_tokens.'
    }
  }
  const direct = tryParse(trimmed)
  if (direct) {
    inflateOperations(direct)
    return { ok: true, value: direct, repaired: false, droppedPartialOperation: false }
  }
  const first = sliceFirstJsonValue(trimmed)
  if (first && first.length < trimmed.length) {
    const parsed = tryParse(first)
    if (parsed) {
      inflateOperations(parsed)
      return { ok: true, value: parsed, repaired: true, droppedPartialOperation: false }
    }
  }
  const closed = closeTruncatedJson(trimmed)
  if (closed) {
    const parsed = tryParse(closed.text)
    if (parsed) {
      inflateOperations(parsed)
      if (closed.closedString && truncatedWholeDocument(parsed)) {
        return {
          ok: false,
          error: `Tool arguments were truncated (${trimmed.length} characters) inside a whole-document replace. Do not resend that payload. Send one screen per propose_gui_changes call (add-screen or replace-screen-html).`
        }
      }
      const dropped = closed.closedString ? dropPartialOperation(parsed) : false
      return { ok: true, value: parsed, repaired: true, droppedPartialOperation: dropped }
    }
  }
  return {
    ok: false,
    error: `Tool arguments were malformed or truncated (${trimmed.length} characters). Do not resend the same payload. Split it into smaller calls — for GUI, one screen per propose_gui_changes.`
  }
}
