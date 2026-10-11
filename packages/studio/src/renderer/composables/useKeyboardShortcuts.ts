import { onMounted, onUnmounted } from 'vue'
import { useFileActions } from './useFileActions'
import { shouldUseNativeClipboard, shouldUseNativeUndo } from './editCommands'

export interface CommandCenterShortcutHandlers {
  openCommandCenter: (initialQuery?: string) => void
  isCommandCenterOpen: () => boolean
  closeCommandCenter: () => void
}

export function useKeyboardShortcuts(
  onEdit: (cmd: string) => void,
  onDevTools?: () => void,
  onNewFile?: () => void,
  onFormat?: () => void,
  onUndoRedo?: (cmd: 'undo' | 'redo') => boolean | Promise<boolean>,
  commandCenter?: CommandCenterShortcutHandlers,
  onToggleSidebar?: () => void,
  onOpenSettings?: () => void,
  onSidebarView?: (mode: 'find' | 'replace' | 'explorer') => void
): void {
  const files = useFileActions()

  function handler(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()

    if (commandCenter?.isCommandCenterOpen()) {
      return
    }

    if (mod && key === 'p' && e.shiftKey) {
      e.preventDefault()
      commandCenter?.openCommandCenter('>')
      return
    }

    if (mod && key === 'p' && !e.shiftKey) {
      e.preventDefault()
      commandCenter?.openCommandCenter('')
      return
    }

    if (mod && key === 't') {
      e.preventDefault()
      commandCenter?.openCommandCenter('@')
      return
    }

    if (mod && key === 'g') {
      e.preventDefault()
      commandCenter?.openCommandCenter(':')
      return
    }

    if (mod && e.shiftKey && !e.altKey && (key === 'f' || key === 'h' || key === 'e')) {
      e.preventDefault()
      e.stopPropagation()
      onSidebarView?.(key === 'f' ? 'find' : key === 'h' ? 'replace' : 'explorer')
      return
    }

    if (e.shiftKey && e.altKey && key === 'f') {
      e.preventDefault()
      onFormat?.()
      return
    }

    if (!mod) return

    const clipboardKeys = ['c', 'v', 'x', 'a']
    if (clipboardKeys.includes(key) && shouldUseNativeClipboard()) {
      return
    }

    if (key === 'n') {
      e.preventDefault()
      onNewFile?.()
    } else if (key === 'b') {
      e.preventDefault()
      onToggleSidebar?.()
    } else if (key === ',') {
      e.preventDefault()
      onOpenSettings?.()
    } else if (key === 'o') {
      e.preventDefault()
      files.openFile()
    } else if (key === 's' && e.shiftKey) {
      e.preventDefault()
      files.saveAsTab()
    } else if (key === 's') {
      e.preventDefault()
      files.saveWorkspace()
    } else if (key === 'w') {
      e.preventDefault()
      files.closeActiveTab()
    } else if (key === 'i' && e.shiftKey) {
      e.preventDefault()
      onDevTools?.()
    } else if (key === 'z' && !e.shiftKey) {
      if (shouldUseNativeUndo()) return
      e.preventDefault()
      if (onUndoRedo?.('undo')) return
      onEdit('undo')
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      if (shouldUseNativeUndo()) return
      e.preventDefault()
      if (onUndoRedo?.('redo')) return
      onEdit('redo')
    } else if (key === 'a') {
      e.preventDefault()
      onEdit('selectAll')
    } else if (key === 'x') {
      e.preventDefault()
      onEdit('cut')
    } else if (key === 'c') {
      e.preventDefault()
      onEdit('copy')
    } else if (key === 'v') {
      e.preventDefault()
      onEdit('paste')
    }
  }

  onMounted(() => window.addEventListener('keydown', handler, true))
  onUnmounted(() => window.removeEventListener('keydown', handler, true))
}
