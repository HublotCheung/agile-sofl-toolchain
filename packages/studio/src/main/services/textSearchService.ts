import { ipcMain } from 'electron'
import { searchProjectFiles } from './textSearchFs.js'
import type { TextSearchRequest } from '../../shared/textSearch.js'

export function registerTextSearchHandlers(): void {
  ipcMain.handle('studio:search-project-text', (_event, payload: TextSearchRequest) => {
    if (!payload || typeof payload.root !== 'string') {
      return { files: [], truncated: false, error: null }
    }
    return searchProjectFiles({
      root: payload.root,
      query: String(payload.query ?? ''),
      matchCase: Boolean(payload.matchCase),
      wholeWord: Boolean(payload.wholeWord),
      useRegex: Boolean(payload.useRegex),
      include: String(payload.include ?? ''),
      exclude: String(payload.exclude ?? ''),
      skipPaths: Array.isArray(payload.skipPaths) ? payload.skipPaths.map((path) => String(path)) : []
    })
  })
}
