import type { BuiltinCommand } from '../types'
import { useHistoryStore } from '../../stores/history'

export const builtinCommands: BuiltinCommand[] = [
  {
    id: 'file.new',
    titleKey: 'commandCenter.cmd.newFromTemplate',
    run: (ctx) => ctx.openNewFile()
  },
  {
    id: 'file.open',
    titleKey: 'commandCenter.cmd.openFile',
    run: (ctx) => ctx.openFile()
  },
  {
    id: 'file.save',
    titleKey: 'commandCenter.cmd.save',
    when: (ctx) => ctx.activeTab?.kind === 'document',
    run: (ctx) => ctx.saveTab()
  },
  {
    id: 'file.saveAs',
    titleKey: 'commandCenter.cmd.saveAs',
    when: (ctx) => ctx.activeTab?.kind === 'document',
    run: (ctx) => ctx.saveAsTab()
  },
  {
    id: 'file.closeTab',
    titleKey: 'commandCenter.cmd.closeTab',
    when: (ctx) => ctx.activeTab?.kind === 'document',
    run: (ctx) => ctx.closeActiveTab()
  },
  {
    id: 'edit.format',
    titleKey: 'commandCenter.cmd.format',
    when: (ctx) => ctx.activeTab?.kind === 'document',
    run: async (ctx) => {
      await ctx.formatDocument()
    }
  },
  {
    id: 'edit.undo',
    titleKey: 'commandCenter.cmd.undo',
    when: () => useHistoryStore().canUndo,
    run: (ctx) => {
      void ctx.undoRedo('undo')
    }
  },
  {
    id: 'edit.redo',
    titleKey: 'commandCenter.cmd.redo',
    when: () => useHistoryStore().canRedo,
    run: (ctx) => {
      void ctx.undoRedo('redo')
    }
  },
  {
    id: 'view.split',
    titleKey: 'commandCenter.cmd.viewSplit',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().setViewMode('split')
    }
  },
  {
    id: 'view.code',
    titleKey: 'commandCenter.cmd.viewCode',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().setViewMode('code')
    }
  },
  {
    id: 'view.visual',
    titleKey: 'commandCenter.cmd.viewVisual',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().setViewMode('visual')
    }
  },
  {
    id: 'view.toggleProjectSidebar',
    titleKey: 'commandCenter.cmd.toggleSidebar',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().toggleProjectSidebar()
    }
  },
  {
    id: 'edit.findInFiles',
    titleKey: 'commandCenter.cmd.findInFiles',
    run: async () => {
      const { useSidebarViewStore } = await import('../../stores/sidebarView')
      await useSidebarViewStore().openFindInFiles(false)
    }
  },
  {
    id: 'edit.replaceInFiles',
    titleKey: 'commandCenter.cmd.replaceInFiles',
    run: async () => {
      const { useSidebarViewStore } = await import('../../stores/sidebarView')
      await useSidebarViewStore().openFindInFiles(true)
    }
  },
  {
    id: 'view.settings',
    titleKey: 'commandCenter.cmd.openSettings',
    run: async () => {
      const { useSettingsStore } = await import('../../stores/settings')
      useSettingsStore().show()
    }
  },
  {
    id: 'view.minimap',
    titleKey: 'commandCenter.cmd.toggleMinimap',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      const ui = useEditorUiStore()
      ui.setShowMinimap(!ui.showMinimap)
    }
  },
  {
    id: 'view.lineNumbers',
    titleKey: 'commandCenter.cmd.toggleLineNumbers',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      const ui = useEditorUiStore()
      ui.setShowLineNumbers(!ui.showLineNumbers)
    }
  },
  {
    id: 'view.tree',
    titleKey: 'commandCenter.cmd.viewTree',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().setSideView('tree')
    }
  },
  {
    id: 'view.graph',
    titleKey: 'commandCenter.cmd.viewGraph',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      useEditorUiStore().setSideView('graph')
    }
  },
  {
    id: 'nav.goHome',
    titleKey: 'commandCenter.cmd.goHome',
    run: async () => {
      const { useDocumentStore } = await import('../../stores/document')
      useDocumentStore().goHome()
    }
  },
  {
    id: 'dev.tools',
    titleKey: 'commandCenter.cmd.devTools',
    run: (ctx) => ctx.openDevTools()
  },
  {
    id: 'tools.refine',
    titleKey: 'commandCenter.cmd.refine',
    when: (ctx) => ctx.documentTabs.some((t) => t.documentKind === 'aspec'),
    run: (ctx) => ctx.openRefine()
  },
  {
    id: 'tools.coverage',
    titleKey: 'commandCenter.cmd.coverage',
    when: (ctx) => ctx.activeTab?.documentKind === 'aspec',
    run: (ctx) => ctx.openCoverage()
  },
  {
    id: 'tools.fsfStrict',
    titleKey: 'commandCenter.cmd.fsfStrict',
    when: (ctx) => ctx.activeTab?.documentKind === 'asfl',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      const ui = useEditorUiStore()
      ui.setFsfStrictMode(!ui.fsfStrictMode)
    }
  },
  {
    id: 'tools.bookAlignStrict',
    titleKey: 'commandCenter.cmd.bookAlignStrict',
    when: (ctx) => ctx.activeTab?.documentKind === 'aspec',
    run: async () => {
      const { useEditorUiStore } = await import('../../stores/editorUi')
      const ui = useEditorUiStore()
      ui.setBookAlignStrict(!ui.bookAlignStrict)
    }
  },
  {
    id: 'file.openFolder',
    titleKey: 'commandCenter.cmd.openFolder',
    run: async () => {
      const { useProjectStore } = await import('../../stores/projectStore')
      await useProjectStore().openFolder()
    }
  },
  {
    id: 'workspace.newProject',
    titleKey: 'workspace.treeMenu.newProject',
    run: async (ctx) => {
      const { promptNewProject } = await import('../../workspaceTree/actions')
      await promptNewProject(ctx.t)
    }
  },
  {
    id: 'workspace.openProject',
    titleKey: 'workspace.treeMenu.openProject',
    run: async () => {
      const { useWorkspaceStore } = await import('../../stores/workspace')
      await useWorkspaceStore().openProjectFolder()
    }
  },
  {
    id: 'workspace.collapseAll',
    titleKey: 'workspace.treeMenu.collapseAll',
    run: async () => {
      const { useWorkspaceStore } = await import('../../stores/workspace')
      useWorkspaceStore().collapseAllProjects()
    }
  }
]
