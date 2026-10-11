import { useDocumentStore } from '../stores/document'
import { fileBelongsToRoot, filePathsEqual } from '../stores/tabUtils'
import {
  compileSearch,
  isEditorDocumentPath,
  normalizePathKey,
  searchInText,
  toRelativePath,
  MAX_TEXT_SEARCH_MATCHES,
  type TextSearchFileHit,
  type TextSearchQuery,
  type TextSearchResponse
} from '../../shared/textSearch'

export function searchOpenEditors(
  root: string,
  query: TextSearchQuery,
  limit: number
): { files: TextSearchFileHit[]; truncated: boolean; error: string | null; skipPaths: string[] } {
  const compiled = compileSearch(query)
  if ('error' in compiled) {
    return {
      files: [],
      truncated: false,
      error: compiled.error === 'empty' ? null : compiled.error,
      skipPaths: []
    }
  }
  const doc = useDocumentStore()
  const tabs = doc.documentTabs.filter((tab) => tab.filePath && fileBelongsToRoot(tab.filePath, root))
  const files: TextSearchFileHit[] = []
  let remaining = limit
  let truncated = false
  for (const tab of tabs) {
    const path = tab.filePath
    if (!path || remaining <= 0) {
      if (remaining <= 0) truncated = true
      continue
    }
    const found = searchInText(tab.content, compiled.re, remaining)
    remaining -= found.matches.length
    if (found.truncated) truncated = true
    if (!found.matches.length) continue
    files.push({
      path,
      replaceable: isEditorDocumentPath(path),
      matches: found.matches
    })
  }
  return {
    files,
    truncated,
    error: null,
    skipPaths: tabs.map((tab) => tab.filePath!).filter(Boolean)
  }
}

export async function runProjectTextSearch(
  root: string | null | undefined,
  query: TextSearchQuery
): Promise<TextSearchResponse> {
  if (!query.query) return { files: [], truncated: false, error: null }
  const compiled = compileSearch(query)
  if ('error' in compiled) {
    return { files: [], truncated: false, error: compiled.error === 'empty' ? null : compiled.error }
  }
  if (!root) return { files: [], truncated: false, error: null }

  const open = searchOpenEditors(root, query, MAX_TEXT_SEARCH_MATCHES)
  if (open.error) return { files: [], truncated: false, error: open.error }

  let disk: TextSearchResponse = { files: [], truncated: false, error: null }
  if (window.studio?.searchProjectText) {
    disk = await window.studio.searchProjectText({
      ...query,
      root,
      skipPaths: open.skipPaths
    })
  }

  const seen = new Set(open.files.map((file) => normalizePathKey(file.path)))
  const files = [...open.files]
  for (const file of disk.files) {
    if (seen.has(normalizePathKey(file.path))) continue
    if (open.skipPaths.some((path) => filePathsEqual(path, file.path))) continue
    files.push(file)
  }
  files.sort((a, b) => toRelativePath(root, a.path).localeCompare(toRelativePath(root, b.path)))

  let truncated = open.truncated || disk.truncated
  let matches = 0
  const capped: TextSearchFileHit[] = []
  for (const file of files) {
    if (matches >= MAX_TEXT_SEARCH_MATCHES) {
      truncated = true
      break
    }
    const room = MAX_TEXT_SEARCH_MATCHES - matches
    if (file.matches.length > room) {
      capped.push({ ...file, matches: file.matches.slice(0, room) })
      matches += room
      truncated = true
      break
    }
    capped.push(file)
    matches += file.matches.length
  }
  return { files: capped, truncated, error: disk.error }
}
