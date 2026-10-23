export type HybridWriteDiagnostic = {
  severity: string
  code: string
  message: string
}

let hybridWriteDiagnosticCollector: ((source: string) => HybridWriteDiagnostic[]) | null = null

/** Main/renderer register real diagnostics; shared code must not import @agile-sofl/editor-api (renderer alias). */
export function setHybridWriteDiagnosticCollector(
  fn: (source: string) => HybridWriteDiagnostic[]
): void {
  hybridWriteDiagnosticCollector = fn
}

function collectHybridWriteDiagnostics(source: string): HybridWriteDiagnostic[] {
  return hybridWriteDiagnosticCollector?.(source) ?? []
}

export type AsflRepair = {
  text: string
  notes: string[]
  /** Caret (or similar) left in place because the operands could not be split. */
  unresolved: string | null
}

const WRITE_FIELDS = ['toText', 'fsf', 'pre', 'post', 'newText', 'text'] as const

/**
 * Rewrite VDM-isms the lexer rejects into legal ASFL.
 * `Name'` (post-state prime) becomes the bare final name. `a ^ b` becomes `conc(a, b)`.
 * String literals, char literals, and comments are left untouched.
 */
export function repairAsflSurface(input: string): AsflRepair {
  const parts = splitProtected(input)
  const notes: string[] = []
  let unresolved: string | null = null
  const text = parts
    .map((part) => {
      if (!part.code) return part.text
      const repaired = repairCode(part.text)
      notes.push(...repaired.notes)
      if (repaired.unresolved) unresolved = repaired.unresolved
      return repaired.text
    })
    .join('')
  return { text, notes: [...new Set(notes)], unresolved }
}

export function normalizeHybridPatch<T extends { explanation?: string; operations?: Array<Record<string, unknown>> }>(
  patch: T
): { patch: T; notes: string[]; unresolved: string | null } {
  const notes: string[] = []
  const unresolved: string[] = []
  const operations = (patch.operations ?? []).map((op) => {
    const next: Record<string, unknown> = { ...op }
    for (const field of WRITE_FIELDS) {
      const value = next[field]
      if (typeof value !== 'string' || !value) continue
      const repaired = repairAsflSurface(value)
      next[field] = repaired.text
      notes.push(...repaired.notes)
      if (repaired.unresolved) unresolved.push(`${field}: ${repaired.unresolved}`)
    }
    return next
  })
  const unique = [...new Set(notes)]
  const explanation = unique.length
    ? [patch.explanation, `Auto-repaired illegal ASFL: ${unique.join('; ')}.`]
        .filter((part) => part && String(part).trim())
        .join('\n')
    : patch.explanation
  return {
    patch: { ...patch, operations, explanation },
    notes: unique,
    unresolved: unresolved.length ? unresolved.join('; ') : null
  }
}

export function acceptHybridWrite(
  before: string,
  after: string
): { ok: boolean; content: string; error?: string; repairNotes?: string[] } {
  const repaired = repairAsflSurface(after)
  const introduced = introducedErrors(before, repaired.text)
  if (introduced.length) {
    const sample = introduced
      .slice(0, 6)
      .map((d) => `${d.code} ${d.message}`)
      .join(' | ')
    return {
      ok: false,
      content: before,
      error: `Write not kept: it introduced ${introduced.length} syntax error(s). ${sample}. Rewrite with legal ASFL (no VDM prime ', no ^ — use conc(seq, elem); != is <>) and re-propose a different patch. Do not stop.`
    }
  }
  const changed = repaired.text !== after
  return {
    ok: true,
    content: repaired.text,
    repairNotes: changed && repaired.notes.length ? repaired.notes : undefined
  }
}

function introducedErrors(
  before: string,
  after: string
): Array<{ code: string; message: string }> {
  const prior = errorMultiset(before)
  const seen = new Map<string, number>()
  const out: Array<{ code: string; message: string }> = []
  for (const d of collectHybridWriteDiagnostics(after)) {
    if (d.severity !== 'error') continue
    const key = `${d.code}:${d.message}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n > (prior.get(key) ?? 0)) out.push({ code: d.code, message: d.message })
  }
  return out
}

function errorMultiset(source: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const d of collectHybridWriteDiagnostics(source)) {
    if (d.severity !== 'error') continue
    const key = `${d.code}:${d.message}`
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

function repairQuantifierAndIff(text: string): { text: string; notes: string[] } {
  const notes: string[] = []
  let out = text
  const forall = out.replace(
    /\bforall\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*:\s*([^,\|\n;]+)\s*,\s*/g,
    'forall[$1: $2] | '
  )
  if (forall !== out) {
    out = forall
    notes.push('rewrote forall u: T, to forall[u: T] |')
  }
  const iff = out.replace(/([^;\n]+?)\s+iff\s+([^;\n]+)/g, '($1 implies $2) and ($2 implies $1)')
  if (iff !== out) {
    out = iff
    notes.push('rewrote iff to (A implies B) and (B implies A)')
  }
  return { text: out, notes }
}

function repairCode(code: string): AsflRepair {
  const notes: string[] = []
  let text = code
  const quant = repairQuantifierAndIff(text)
  text = quant.text
  notes.push(...quant.notes)
  if (text.includes('!=')) {
    text = text.replace(/!=/g, '<>')
    notes.push('rewrote != to <>')
  }
  if (text.includes("'")) {
    const stripped = text.replace(/'/g, '')
    if (stripped !== text) {
      text = stripped
      notes.push("dropped VDM post-state prime (')")
    }
  }
  let guard = 0
  let carets = 0
  while (text.includes('^') && guard++ < 40) {
    const hat = text.indexOf('^')
    const left = readPrimaryBackward(text, hat - 1)
    const right = readPrimaryForward(text, hat + 1)
    if (!left || !right) {
      return {
        text,
        notes,
        unresolved: 'could not rewrite ^; use conc(seq, elem)'
      }
    }
    const ltxt = text.slice(left.start, left.end).trim()
    const rtxt = text.slice(right.start, right.end).trim()
    text = `${text.slice(0, left.start)}conc(${ltxt}, ${rtxt})${text.slice(right.end)}`
    carets += 1
  }
  if (text.includes('^')) {
    return { text, notes, unresolved: 'could not rewrite ^; use conc(seq, elem)' }
  }
  if (carets) notes.push('rewrote ^ to conc(seq, elem)')
  return { text, notes, unresolved: null }
}

type Span = { text: string; code: boolean }

function splitProtected(input: string): Span[] {
  const parts: Span[] = []
  let i = 0
  let buf = ''
  const flush = (code: boolean, text: string) => {
    if (buf) {
      parts.push({ text: buf, code: true })
      buf = ''
    }
    if (!code && text) parts.push({ text, code: false })
  }
  while (i < input.length) {
    if (input.startsWith('//', i) || input.startsWith('--', i)) {
      const nl = input.indexOf('\n', i)
      const end = nl < 0 ? input.length : nl
      flush(false, input.slice(i, end))
      i = end
      continue
    }
    if (input.startsWith('/*', i)) {
      const end = input.indexOf('*/', i + 2)
      const to = end < 0 ? input.length : end + 2
      flush(false, input.slice(i, to))
      i = to
      continue
    }
    if (input[i] === '"') {
      let j = i + 1
      while (j < input.length) {
        if (input[j] === '\\') {
          j += 2
          continue
        }
        if (input[j] === '"') {
          j += 1
          break
        }
        j += 1
      }
      flush(false, input.slice(i, j))
      i = j
      continue
    }
    if (input[i] === "'" && charLiteralLength(input, i) > 0) {
      const len = charLiteralLength(input, i)
      flush(false, input.slice(i, i + len))
      i += len
      continue
    }
    buf += input[i]
    i += 1
  }
  if (buf) parts.push({ text: buf, code: true })
  return parts
}

function charLiteralLength(input: string, i: number): number {
  if (input[i] !== "'") return 0
  if (input[i + 1] === '\\' && input[i + 2] && input[i + 3] === "'") return 4
  if (input[i + 1] && input[i + 1] !== "'" && input[i + 1] !== '\\' && input[i + 2] === "'") return 3
  return 0
}

function matchForward(s: string, open: number): number {
  const closer = s[open] === '(' ? ')' : s[open] === '[' ? ']' : s[open] === '{' ? '}' : ''
  if (!closer) return -1
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === s[open]) depth += 1
    else if (s[i] === closer) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function matchBack(s: string, close: number): number {
  const opener = s[close] === ')' ? '(' : s[close] === ']' ? '[' : s[close] === '}' ? '{' : ''
  if (!opener) return -1
  let depth = 0
  for (let i = close; i >= 0; i--) {
    if (s[i] === s[close]) depth += 1
    else if (s[i] === opener) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function readPrimaryBackward(s: string, from: number): { start: number; end: number } | null {
  let i = from
  while (i >= 0 && /\s/.test(s[i]!)) i -= 1
  if (i < 0) return null
  const end = i + 1
  const c = s[i]!
  if (c === ')' || c === ']' || c === '}') {
    const open = matchBack(s, i)
    if (open < 0) return null
    let start = open
    if (c === ')') {
      let j = open - 1
      while (j >= 0 && /\s/.test(s[j]!)) j -= 1
      const idEnd = j
      while (j >= 0 && /[A-Za-z0-9_\u0080-\uFFFF]/.test(s[j]!)) j -= 1
      if (idEnd >= 0 && j < idEnd && /[A-Za-z_\u0080-\uFFFF]/.test(s[j + 1]!)) start = j + 1
    }
    return { start, end }
  }
  if (/[A-Za-z0-9_\u0080-\uFFFF.]/.test(c)) {
    while (i >= 0 && /[A-Za-z0-9_\u0080-\uFFFF.]/.test(s[i]!)) i -= 1
    return { start: i + 1, end }
  }
  return null
}

function readPrimaryForward(s: string, from: number): { start: number; end: number } | null {
  let i = from
  while (i < s.length && /\s/.test(s[i]!)) i += 1
  if (i >= s.length) return null
  const start = i
  const c = s[i]!
  if (c === '(' || c === '[' || c === '{') {
    const close = matchForward(s, i)
    if (close < 0) return null
    return { start, end: close + 1 }
  }
  if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
    i += 1
    while (i < s.length && /[A-Za-z0-9_\u0080-\uFFFF]/.test(s[i]!)) i += 1
    let j = i
    while (j < s.length && /\s/.test(s[j]!)) j += 1
    if (s[j] === '(') {
      const close = matchForward(s, j)
      if (close >= 0) return { start, end: close + 1 }
    }
    return { start, end: i }
  }
  if (/[0-9]/.test(c)) {
    i += 1
    while (i < s.length && /[0-9.]/.test(s[i]!)) i += 1
    return { start, end: i }
  }
  return null
}
