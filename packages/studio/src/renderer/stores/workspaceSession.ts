import { createDocumentTab, createHomeTab, HOME_TAB_ID, type EditorTab } from './tabUtils'

const SESSION_KEY = 'studio-workspace-session'

export type WorkspaceSnapshot = {
  activeTabId: string
  documentTabs: Array<{
    id: string
    filePath: string | null
    uri: string
    title: string
    isDirty: boolean
    content: string
    documentKind?: 'asfl' | 'aspec'
    linkedDocumentId?: string
  }>
}

export function persistWorkspace(activeTabId: string, tabs: EditorTab[]): void {
  try {
    const documentTabs = tabs
      .filter((t) => t.kind === 'document')
      .map((t) => ({
        id: t.id,
        filePath: t.filePath,
        uri: t.uri,
        title: t.title,
        isDirty: t.isDirty,
        content: t.content,
        documentKind: t.documentKind,
        linkedDocumentId: t.linkedDocumentId
      }))
    if (!documentTabs.length) {
      sessionStorage.removeItem(SESSION_KEY)
      return
    }
    const snapshot: WorkspaceSnapshot = { activeTabId, documentTabs }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot))
  } catch (err) {
    console.warn('[studio] workspace session persist failed', err)
  }
}

export function restoreWorkspace(): { tabs: EditorTab[]; activeTabId: string } | null {
  const raw = sessionStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const snapshot = JSON.parse(raw) as WorkspaceSnapshot
    if (!snapshot.documentTabs?.length) return null
    const tabs: EditorTab[] = [createHomeTab()]
    for (const d of snapshot.documentTabs) {
      tabs.push(
        createDocumentTab({
          id: d.id,
          filePath: d.filePath,
          uri: d.uri,
          title: d.title,
          isDirty: d.isDirty,
          content: d.content,
          documentKind: d.documentKind,
          linkedDocumentId: d.linkedDocumentId
        })
      )
    }
    const activeTabId = tabs.some((t) => t.id === snapshot.activeTabId)
      ? snapshot.activeTabId
      : snapshot.documentTabs[0].id
    return { tabs, activeTabId }
  } catch {
    return null
  }
}

export function clearWorkspaceSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}
