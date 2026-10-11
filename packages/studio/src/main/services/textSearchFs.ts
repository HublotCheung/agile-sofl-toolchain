import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  compileSearch,
  isEditorDocumentPath,
  normalizePathKey,
  pathAllowed,
  searchInText,
  toRelativePath,
  MAX_TEXT_SEARCH_MATCHES,
  type TextSearchFileHit,
  type TextSearchRequest,
  type TextSearchResponse
} from '../../shared/textSearch.js'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'coverage',
  '.vite'
])

const BINARY_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'exe',
  'dll',
  'wasm',
  'pdf',
  'zip',
  'gz',
  '7z',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'bin',
  'obj',
  'class',
  'jar',
  'pyc',
  'sqlite',
  'db'
])

const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 4000

function extensionOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

function readTextFile(filePath: string): string | null {
  const ext = extensionOf(filePath)
  if (ext && BINARY_EXT.has(ext)) return null
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return null
  }
  if (size <= 0 || size > MAX_FILE_BYTES) return null
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  if (content.includes('\u0000')) return null
  return content
}

export function searchProjectFiles(request: TextSearchRequest): TextSearchResponse {
  const root = request.root
  if (!root) return { files: [], truncated: false, error: null }
  const compiled = compileSearch(request)
  if ('error' in compiled) {
    if (compiled.error === 'empty') return { files: [], truncated: false, error: null }
    return { files: [], truncated: false, error: compiled.error }
  }
  const skip = new Set((request.skipPaths ?? []).map((path) => normalizePathKey(path)))
  const files: TextSearchFileHit[] = []
  let truncated = false
  let remaining = MAX_TEXT_SEARCH_MATCHES
  let seenFiles = 0

  const walk = (dir: string): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      seenFiles += 1
      if (seenFiles > MAX_FILES) {
        truncated = true
        return
      }
      if (skip.has(normalizePathKey(full))) continue
      const relative = toRelativePath(root, full)
      if (!pathAllowed(relative, request.include, request.exclude)) continue
      const content = readTextFile(full)
      if (content == null) continue
      const found = searchInText(content, compiled.re, remaining)
      if (!found.matches.length) continue
      remaining -= found.matches.length
      if (found.truncated) truncated = true
      files.push({
        path: full,
        replaceable: isEditorDocumentPath(full),
        matches: found.matches
      })
      if (remaining <= 0) {
        truncated = true
        return
      }
    }
  }

  walk(root)
  files.sort((a, b) => toRelativePath(root, a.path).localeCompare(toRelativePath(root, b.path)))
  return { files, truncated, error: null }
}
