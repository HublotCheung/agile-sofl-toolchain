export const MAX_TEXT_SEARCH_MATCHES = 5000

export type TextSearchQuery = {
  query: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
  include: string
  exclude: string
}

export type TextSearchRequest = TextSearchQuery & {
  root: string
  skipPaths?: string[]
}

export type TextMatch = {
  line: number
  column: number
  start: number
  end: number
  text: string
  groups: string[]
  preview: string
  previewStart: number
  previewEnd: number
}

export type TextSearchFileHit = {
  path: string
  replaceable: boolean
  matches: TextMatch[]
}

export type TextSearchResponse = {
  files: TextSearchFileHit[]
  truncated: boolean
  error: string | null
}

export type EditorDocumentKind = 'aspec' | 'asfl' | 'guispec'

export function normalizePathKey(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized[0]!.toLowerCase() + normalized.slice(1)
  else if (normalized.startsWith('/')) normalized = normalized.toLowerCase()
  return normalized
}

export function toRelativePath(root: string, filePath: string): string {
  const rootKey = normalizePathKey(root).replace(/\/$/, '')
  const fileSlash = filePath.replace(/\\/g, '/')
  const fileKey = normalizePathKey(filePath)
  if (fileKey === rootKey) return ''
  if (fileKey.startsWith(`${rootKey}/`)) {
    return fileSlash.slice(fileSlash.length - (fileKey.length - rootKey.length - 1))
  }
  return fileSlash
}

export function editorDocumentKind(filePath: string): EditorDocumentKind | null {
  const path = filePath.replace(/\\/g, '/').toLowerCase()
  if (path.endsWith('.aspec')) return 'aspec'
  if (path.endsWith('.asfl')) return 'asfl'
  if (path.endsWith('.guispec') || path.endsWith('.gui.html') || path.endsWith('/gui.html')) {
    return 'guispec'
  }
  return null
}

export function isEditorDocumentPath(filePath: string): boolean {
  return editorDocumentKind(filePath) != null
}

export function splitGlobList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  const source = pattern.replace(/\\/g, '/')
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '*') {
      if (source[i + 1] === '*') {
        if (source[i + 2] === '/') {
          out += '(?:.*/?)'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^(?:${out})$`, 'i')
}

export function matchGlob(relativePath: string, pattern: string): boolean {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const pat = pattern.trim().replace(/\\/g, '/')
  if (!pat || pat === '**' || pat === '**/*') return true
  if (globToRegExp(pat).test(rel)) return true
  if (!pat.includes('/')) {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (globToRegExp(pat).test(base)) return true
  }
  return false
}

export function pathAllowed(relativePath: string, include: string, exclude: string): boolean {
  const includes = splitGlobList(include)
  const excludes = splitGlobList(exclude)
  if (includes.length > 0 && !includes.some((glob) => matchGlob(relativePath, glob))) return false
  if (excludes.some((glob) => matchGlob(relativePath, glob))) return false
  return true
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
}

export function compileSearch(query: TextSearchQuery): { re: RegExp } | { error: string } {
  const raw = query.query
  if (!raw) return { error: 'empty' }
  let pattern = query.useRegex ? raw : escapeRegExp(raw)
  if (query.wholeWord) {
    pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`
  }
  const flags = `${query.matchCase ? '' : 'i'}gu`
  try {
    return { re: new RegExp(pattern, flags) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid' }
  }
}

function buildPreview(
  lineText: string,
  matchStart: number,
  matchEnd: number
): { preview: string; previewStart: number; previewEnd: number } {
  const max = 180
  if (lineText.length <= max) {
    return { preview: lineText, previewStart: matchStart, previewEnd: matchEnd }
  }
  const radius = 70
  const from = Math.max(0, matchStart - radius)
  const to = Math.min(lineText.length, matchEnd + radius)
  const prefix = from > 0
  const suffix = to < lineText.length
  const preview = `${prefix ? '…' : ''}${lineText.slice(from, to)}${suffix ? '…' : ''}`
  const shift = (prefix ? 1 : 0) - from
  return {
    preview,
    previewStart: matchStart + shift,
    previewEnd: matchEnd + shift
  }
}

export function searchInText(
  content: string,
  re: RegExp,
  limit: number
): { matches: TextMatch[]; truncated: boolean } {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const regex = new RegExp(re.source, flags)
  const matches: TextMatch[] = []
  let truncated = false
  let found: RegExpExecArray | null
  while ((found = regex.exec(content))) {
    if (found[0].length === 0) {
      regex.lastIndex += 1
      continue
    }
    if (matches.length >= limit) {
      truncated = true
      break
    }
    const start = found.index
    const end = start + found[0].length
    const lineStart = content.lastIndexOf('\n', start - 1) + 1
    const lineEndIdx = content.indexOf('\n', end)
    const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx
    const lineText = content.slice(lineStart, lineEnd).replace(/\r$/, '')
    const line = content.slice(0, start).split('\n').length
    const column = start - lineStart + 1
    const inLineStart = start - lineStart
    const inLineEnd = Math.min(lineText.length, end - lineStart)
    const preview = buildPreview(lineText, inLineStart, inLineEnd)
    const groups: string[] = []
    for (let i = 0; i < found.length; i++) groups.push(found[i] ?? '')
    matches.push({
      line,
      column,
      start,
      end,
      text: found[0],
      groups,
      ...preview
    })
  }
  return { matches, truncated }
}

export function applyReplacePattern(groups: string[], replacement: string, useRegex: boolean): string {
  if (!useRegex) return replacement
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (all, token: string) => {
    if (token === '$') return '$'
    if (token === '&' || token === '0') return groups[0] ?? ''
    const index = Number(token)
    return groups[index] ?? ''
  })
}

export function preserveCaseReplace(target: string, replacement: string): string {
  if (target.toUpperCase() === target.toLowerCase()) return replacement
  if (target === target.toUpperCase()) return replacement.toUpperCase()
  if (target === target.toLowerCase()) return replacement.toLowerCase()
  const rest = target.slice(1)
  const first = target[0] ?? ''
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.slice(0, 1).toUpperCase() + replacement.slice(1).toLowerCase()
  }
  return replacement
}

export function replaceMatchesInText(
  content: string,
  matches: TextMatch[],
  replacement: string,
  options: { useRegex: boolean; preserveCase: boolean }
): string | null {
  const sorted = [...matches].sort((a, b) => b.start - a.start)
  let out = content
  for (const match of sorted) {
    if (content.slice(match.start, match.end) !== match.text) return null
    let next = applyReplacePattern(match.groups.length ? match.groups : [match.text], replacement, options.useRegex)
    if (options.preserveCase) next = preserveCaseReplace(match.text, next)
    out = out.slice(0, match.start) + next + out.slice(match.end)
  }
  return out
}

export function replaceAllInText(
  content: string,
  query: TextSearchQuery,
  replacement: string,
  preserveCase: boolean
): string | null {
  const compiled = compileSearch(query)
  if ('error' in compiled) return null
  const { matches } = searchInText(content, compiled.re, 100_000)
  if (!matches.length) return content
  return replaceMatchesInText(content, matches, replacement, {
    useRegex: query.useRegex,
    preserveCase
  })
}
