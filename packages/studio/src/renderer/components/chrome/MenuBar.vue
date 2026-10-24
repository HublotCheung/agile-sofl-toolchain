<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DropdownMenu, { type MenuItem } from '../ui/DropdownMenu.vue'
import { useFileActions } from '../../composables/useFileActions'
import { useNewProjectTemplateDialog } from '../../composables/useNewProjectTemplateDialog'
import { useWorkspaceStore } from '../../stores/workspace'
import { useModalStore } from '../../stores/modal'
import { useHistoryStore } from '../../stores/history'
import { useSettingsStore } from '../../stores/settings'
import { useSidebarViewStore } from '../../stores/sidebarView'
import { useAppStore } from '../../stores/app'
import { historyCommandTitle } from '../../history/kinds'

const emit = defineEmits<{ edit: [cmd: string]; devTools: []; format: []; refine: [] }>()

const { t } = useI18n()
const files = useFileActions()
const newProjectTemplateDialog = useNewProjectTemplateDialog()
const modal = useModalStore()
const workspace = useWorkspaceStore()
const history = useHistoryStore()
const settings = useSettingsStore()
const sidebar = useSidebarViewStore()
const app = useAppStore()

const accessKeys: Record<string, string> = {
  file: 'f',
  edit: 'e',
  view: 'v',
  settings: 's',
  help: 'h'
}

async function onNewProject(): Promise<void> {
  const { index, value } = await modal.show({
    title: t('workspace.newProjectTitle'),
    message: t('workspace.newProjectMessage'),
    buttons: [t('workspace.create'), t('workspace.cancel')],
    input: true,
    inputValue: 'NewSystem',
    inputPlaceholder: t('workspace.projectName')
  })
  if (index !== 0 || !value?.trim()) return
  await workspace.createProject(value.trim())
}

const fileItems = computed<MenuItem[]>(() => [
  { id: 'newProject', label: t('menu.file.newProject'), action: () => void onNewProject() },
  {
    id: 'newFromTemplate',
    label: t('menu.file.newFromTemplate'),
    shortcut: 'Ctrl+N',
    action: () => newProjectTemplateDialog.show()
  },
  { id: 'openFolder', label: t('menu.file.openFolder'), action: () => void workspace.openProjectFolder() },
  { id: 'open', label: t('menu.file.open'), shortcut: 'Ctrl+O', action: () => files.openFile() },
  { id: 'sep1', label: '', separator: true },
  { id: 'refine', label: t('menu.tools.refine'), action: () => emit('refine') },
  { id: 'sep1b', label: '', separator: true },
  { id: 'save', label: t('menu.file.save'), shortcut: 'Ctrl+S', action: () => files.saveWorkspace() },
  { id: 'saveAs', label: t('menu.file.saveAs'), shortcut: 'Ctrl+Shift+S', action: () => files.saveAsTab() },
  { id: 'sep2', label: '', separator: true },
  { id: 'close', label: t('menu.file.closeTab'), shortcut: 'Ctrl+W', action: () => files.closeActiveTab() },
  { id: 'exit', label: t('menu.file.exit'), action: () => files.tryCloseWindow() }
])

const editItems = computed<MenuItem[]>(() => {
  const undoName = history.undoCommand ? historyCommandTitle(history.undoCommand, t) : null
  const redoName = history.redoCommand ? historyCommandTitle(history.redoCommand, t) : null
  return [
  {
    id: 'undo',
    label: undoName ? t('menu.edit.undoNamed', { name: undoName }) : t('menu.edit.undo'),
    shortcut: 'Ctrl+Z',
    disabled: !history.canUndo,
    action: () => emit('edit', 'undo')
  },
  {
    id: 'redo',
    label: redoName ? t('menu.edit.redoNamed', { name: redoName }) : t('menu.edit.redo'),
    shortcut: 'Ctrl+Y',
    disabled: !history.canRedo,
    action: () => emit('edit', 'redo')
  },
  { id: 'sep1', label: '', separator: true },
  { id: 'cut', label: t('menu.edit.cut'), shortcut: 'Ctrl+X', action: () => emit('edit', 'cut') },
  { id: 'copy', label: t('menu.edit.copy'), shortcut: 'Ctrl+C', action: () => emit('edit', 'copy') },
  { id: 'paste', label: t('menu.edit.paste'), shortcut: 'Ctrl+V', action: () => emit('edit', 'paste') },
  { id: 'selectAll', label: t('menu.edit.selectAll'), shortcut: 'Ctrl+A', action: () => emit('edit', 'selectAll') },
  { id: 'sep2', label: '', separator: true },
  {
    id: 'findInFiles',
    label: t('menu.edit.findInFiles'),
    shortcut: 'Ctrl+Shift+F',
    action: () => {
      workspace.setInformalCollapsed(false)
      void sidebar.openFindInFiles(false)
    }
  },
  {
    id: 'replaceInFiles',
    label: t('menu.edit.replaceInFiles'),
    shortcut: 'Ctrl+Shift+H',
    action: () => {
      workspace.setInformalCollapsed(false)
      void sidebar.openFindInFiles(true)
    }
  },
  { id: 'sep3', label: '', separator: true },
  { id: 'format', label: t('menu.edit.format'), shortcut: 'Shift+Alt+F', action: () => emit('format') }
  ]
})

const viewItems = computed<MenuItem[]>(() => [
  { id: 'themeLight', label: t('menu.view.themeLight'), action: () => app.setTheme('light') },
  { id: 'themeDark', label: t('menu.view.themeDark'), action: () => app.setTheme('dark') },
  { id: 'themeContrast', label: t('menu.view.themeContrast'), action: () => app.setTheme('contrast') },
  { id: 'themeSystem', label: t('menu.view.themeSystem'), action: () => app.setTheme('system') }
])

const helpItems = computed<MenuItem[]>(() => [
  {
    id: 'devTools',
    label: t('menu.help.devTools'),
    shortcut: 'Ctrl+Shift+I',
    action: () => emit('devTools')
  },
  { id: 'sep0', label: '', separator: true },
  {
    id: 'about',
    label: t('menu.help.about'),
    action: () => {
      void modal.show({
        title: t('menu.help.about'),
        message: t('about.message'),
        buttons: [t('dialog.ok')]
      })
    }
  },
  {
    id: 'docs',
    label: t('menu.help.docs'),
    action: () => {
      void modal.show({
        title: t('menu.help.docs'),
        message: 'https://github.com/agile-sofl/agile-sofl-parser/tree/main/docs',
        buttons: [t('dialog.ok')]
      })
    }
  }
])

const menus = computed(() => [
  { key: 'file', label: t('menu.file'), items: fileItems.value },
  { key: 'edit', label: t('menu.edit'), items: editItems.value },
  { key: 'view', label: t('menu.view'), items: viewItems.value }
])

const helpMenu = computed(() => ({ key: 'help', label: t('menu.help'), items: helpItems.value }))
</script>

<template>
  <nav class="titlebar-no-drag flex items-center gap-0.5" role="menubar">
    <DropdownMenu v-for="menu in menus" :key="menu.key" :items="menu.items">
      <template #trigger="{ toggle }">
        <button
          type="button"
          role="menuitem"
          :accesskey="accessKeys[menu.key]"
          class="rounded-md px-2.5 py-0.5 text-[13px] text-titlebar-fg transition-colors duration-150 hover:bg-titlebar-hover hover:text-titlebar-strong active:scale-[0.98]"
          @click="toggle"
        >
          <span class="underline decoration-content-muted underline-offset-2">{{ menu.label[0] }}</span
          >{{ menu.label.slice(1) }}
        </button>
      </template>
    </DropdownMenu>
    <button
      type="button"
      role="menuitem"
      :accesskey="accessKeys.settings"
      class="rounded-md px-2.5 py-0.5 text-[13px] text-titlebar-fg transition-colors duration-150 hover:bg-titlebar-hover hover:text-titlebar-strong active:scale-[0.98]"
      @click="settings.show()"
    >
      <span class="underline decoration-content-muted underline-offset-2">{{ t('menu.settings')[0] }}</span
      >{{ t('menu.settings').slice(1) }}
    </button>
    <DropdownMenu :items="helpMenu.items">
      <template #trigger="{ toggle }">
        <button
          type="button"
          role="menuitem"
          :accesskey="accessKeys.help"
          class="rounded-md px-2.5 py-0.5 text-[13px] text-titlebar-fg transition-colors duration-150 hover:bg-titlebar-hover hover:text-titlebar-strong active:scale-[0.98]"
          @click="toggle"
        >
          <span class="underline decoration-content-muted underline-offset-2">{{ helpMenu.label[0] }}</span
          >{{ helpMenu.label.slice(1) }}
        </button>
      </template>
    </DropdownMenu>
  </nav>
</template>
