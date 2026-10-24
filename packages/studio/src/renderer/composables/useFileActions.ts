import { useI18n } from 'vue-i18n'
import { refreshGitFor } from './useGitStatus'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { useModalStore } from '../stores/modal'
import { useWorkspaceStore } from '../stores/workspace'
import { HOME_TAB_ID } from '../stores/tabUtils'

export function useFileActions() {
  const { t } = useI18n()
  const doc = useDocumentStore()
  const modal = useModalStore()

  async function saveTab(tabId?: string): Promise<boolean> {
    await useHistoryStore().flushRegistered()
    const tab = tabId ? doc.tabs.find((x) => x.id === tabId) : doc.activeTab
    if (!tab || tab.kind !== 'document') return false

    let path = tab.filePath
    const ext =
      tab.documentKind === 'aspec' ? 'aspec' : tab.documentKind === 'guispec' ? 'guispec' : 'asfl'
    if (!path) {
      path = await window.studio!.fileSaveDialog(`${tab.title}.${ext}`, tab.documentKind)
      if (!path) return false
    }

    await window.studio!.fileWrite(path, tab.content)
    doc.markSaved(tab.id, path, path.split(/[/\\]/).pop() ?? tab.title)
    const workspace = useWorkspaceStore()
    if (tab.documentKind === 'asfl' && path) {
      if (workspace.hasWorkspace) await workspace.markHybridSaved(path)
    }
    const root = workspace.activeProject?.rootPath
    if (root) void refreshGitFor(root)
    return true
  }

  async function saveAllDirtyDocumentTabs(): Promise<boolean> {
    await useHistoryStore().flushRegistered()
    for (const tab of doc.documentTabs.filter((t) => t.kind === 'document' && t.isDirty)) {
      const ok = await saveTab(tab.id)
      if (!ok) return false
    }
    return true
  }

  async function saveWorkspace(): Promise<boolean> {
    const workspace = useWorkspaceStore()
    if (workspace.hasWorkspace) return workspace.persistDirtyDocuments()
    const dirty = doc.documentTabs.filter((t) => t.kind === 'document' && t.isDirty)
    if (dirty.length) return saveAllDirtyDocumentTabs()
    return saveTab()
  }

  async function saveAsTab(): Promise<boolean> {
    await useHistoryStore().flushRegistered()
    const tab = doc.activeTab
    if (!tab || tab.kind !== 'document') return false
    const ext =
      tab.documentKind === 'aspec' ? 'aspec' : tab.documentKind === 'guispec' ? 'guispec' : 'asfl'
    const path = await window.studio!.fileSaveDialog(`${tab.title}.${ext}`, tab.documentKind)
    if (!path) return false
    await window.studio!.fileWrite(path, tab.content)
    doc.markSaved(tab.id, path, path.split(/[/\\]/).pop() ?? tab.title)
    return true
  }

  async function openFile(): Promise<void> {
    const result = await window.studio!.fileOpenDialog()
    if (result) doc.openFromFile(result.filePath, result.content, result.title)
  }

  async function confirmCloseTab(tabId: string): Promise<'save' | 'discard' | 'cancel'> {
    if (tabId === HOME_TAB_ID) return 'cancel'
    const tab = doc.tabs.find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'document') return 'discard'
    if (!tab.isDirty) return 'discard'

    const { index: response } = await modal.show({
      title: t('dialog.unsaved.title'),
      message: t('dialog.unsaved.message', { name: tab.title }),
      buttons: [t('dialog.unsaved.save'), t('dialog.unsaved.dontSave'), t('dialog.unsaved.cancel')]
    })

    if (response === 0) {
      const saved = await saveTab(tabId)
      return saved ? 'save' : 'cancel'
    }
    if (response === 1) return 'discard'
    return 'cancel'
  }

  async function closeActiveTab(): Promise<void> {
    const tab = doc.activeTab
    if (!tab || tab.kind !== 'document') return
    const action = await confirmCloseTab(tab.id)
    if (action === 'cancel') return
    doc.removeTab(tab.id)
  }

  async function tryCloseWindow(): Promise<void> {
    const workspace = useWorkspaceStore()
    if (workspace.hasWorkspace) {
      if (!(await workspace.confirmLeaveActiveProject('dialog.unsaved.projectQuitMessage'))) return
      window.studio!.confirmClose()
      return
    }

    const dirtyTabs = doc.documentTabs.filter((t) => t.kind === 'document' && t.isDirty)
    if (!dirtyTabs.length) {
      window.studio!.confirmClose()
      return
    }

    const { index: response } = await modal.show({
      title: t('dialog.unsaved.title'),
      message: t('dialog.unsaved.standaloneMessage'),
      buttons: [t('dialog.unsaved.save'), t('dialog.unsaved.dontSave'), t('dialog.unsaved.cancel')]
    })
    if (response === 0) {
      if (!(await saveAllDirtyDocumentTabs())) return
    } else if (response === 2) {
      return
    }
    window.studio!.confirmClose()
  }

  return {
    saveTab,
    saveWorkspace,
    saveAsTab,
    openFile,
    closeActiveTab,
    tryCloseWindow,
    confirmCloseTab
  }
}
