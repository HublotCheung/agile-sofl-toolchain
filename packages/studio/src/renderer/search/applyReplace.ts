import { HistoryKinds } from '../history/kinds'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { filePathsEqual } from '../stores/tabUtils'
import { replaceAllInText, replaceMatchesInText, type TextMatch, type TextSearchQuery } from '../../shared/textSearch'

async function readEditorContent(filePath: string): Promise<string | null> {
  const doc = useDocumentStore()
  const open = doc.documentTabs.find((tab) => tab.filePath && filePathsEqual(tab.filePath, filePath))
  if (open) return open.content
  if (!window.studio?.fileRead) return null
  const file = await window.studio.fileRead(filePath)
  return file.content
}

function commitEdits(edits: Array<{ path: string; before: string; after: string }>): void {
  if (!edits.length) return
  const doc = useDocumentStore()
  const history = useHistoryStore()
  const previous = doc.activeTabId
  const mutations = []
  for (const edit of edits) {
    if (edit.before === edit.after) continue
    let tab = doc.documentTabs.find((item) => item.filePath && filePathsEqual(item.filePath, edit.path))
    if (!tab) {
      const title = edit.path.replace(/\\/g, '/').split('/').pop() ?? edit.path
      tab = doc.openFromFile(edit.path, edit.before, title)
    }
    if (tab.content !== edit.before) continue
    doc.setContent(tab.id, edit.after)
    mutations.push({
      tabId: tab.id,
      filePath: tab.filePath ?? edit.path,
      before: edit.before,
      after: edit.after
    })
  }
  if (previous) doc.setActive(previous)
  if (!mutations.length) return
  history.commit({
    kind: HistoryKinds.searchReplace,
    immediate: true,
    mutations
  })
}

export async function replaceEditorMatches(options: {
  paths: string[]
  query: TextSearchQuery
  replacement: string
  preserveCase: boolean
  only?: TextMatch
}): Promise<boolean> {
  const edits: Array<{ path: string; before: string; after: string }> = []
  let changed = false
  for (const path of options.paths) {
    const before = await readEditorContent(path)
    if (before == null) continue
    const after = options.only
      ? replaceMatchesInText(before, [options.only], options.replacement, {
          useRegex: options.query.useRegex,
          preserveCase: options.preserveCase
        })
      : replaceAllInText(before, options.query, options.replacement, options.preserveCase)
    if (after == null || after === before) continue
    edits.push({ path, before, after })
    changed = true
  }
  commitEdits(edits)
  return changed
}
