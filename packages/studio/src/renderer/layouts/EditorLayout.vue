<script setup lang="ts">
import { defineAsyncComponent, ref, onMounted, onUnmounted, computed, watch } from 'vue'
import type EditorWorkspaceType from '../components/editor/EditorWorkspace.vue'
import TitleBar from '../components/chrome/TitleBar.vue'
import EditorTabs from '../components/editor/EditorTabs.vue'
import EditorToolbar from '../components/editor/EditorToolbar.vue'
import SidebarResizeSplit from '../components/ui/SidebarResizeSplit.vue'
import ProjectSidebar from '../components/chrome/project/ProjectSidebar.vue'
import HomeView from '../components/home/HomeView.vue'
import WelcomeView from '../components/home/WelcomeView.vue'
import StatusBar from '../components/editor/StatusBar.vue'
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts'
import { useFileActions } from '../composables/useFileActions'
import NewProjectTemplateDialog from '../components/home/NewProjectTemplateDialog.vue'
import { useNewProjectTemplateDialog } from '../composables/useNewProjectTemplateDialog'
import { useDocumentStore } from '../stores/document'
import { useWorkspaceStore } from '../stores/workspace'
import { useModalStore } from '../stores/modal'
import Modal from '../components/ui/Modal.vue'
import SettingsDialog from '../components/chrome/SettingsDialog.vue'
import { useCommandCenterStore } from '../stores/commandCenter'
import { useEditorUiStore } from '../stores/editorUi'
import { useHistoryStore } from '../stores/history'
import { useSettingsStore } from '../stores/settings'
import { useSidebarViewStore } from '../stores/sidebarView'

const EditorWorkspace = defineAsyncComponent(() => import('../components/editor/EditorWorkspace.vue'))
const WorkspaceLayout = defineAsyncComponent(() => import('../components/workspace/WorkspaceLayout.vue'))
const RefinementWizard = defineAsyncComponent(() => import('../components/editor/RefinementWizard.vue'))

const workspaceRef = ref<InstanceType<typeof EditorWorkspaceType> | null>(null)
const files = useFileActions()
const doc = useDocumentStore()
const workspace = useWorkspaceStore()
const modalStore = useModalStore()
const newProjectTemplateDialog = useNewProjectTemplateDialog()
const commandCenter = useCommandCenterStore()
const editorUi = useEditorUiStore()
const history = useHistoryStore()
const settings = useSettingsStore()
const sidebar = useSidebarViewStore()
const refineOpen = ref(false)

async function onUndoRedo(cmd: 'undo' | 'redo'): Promise<boolean> {
  return cmd === 'undo' ? history.undo() : history.redo()
}

const showDocumentEditor = computed(
  () => doc.activeTab?.kind === 'document' && !doc.showWelcomeFallback
)

function onEdit(cmd: string): void {
  if (cmd === 'undo') {
    void history.undo()
    return
  }
  if (cmd === 'redo') {
    void history.redo()
    return
  }
  workspaceRef.value?.runEditCommand(cmd)
}

function onFormat(): void {
  void workspaceRef.value?.formatDocument()
}

function onDevTools(): void {
  window.studio?.openDevTools()
}

function registerCommandCenterHandlers(): void {
  const ws = workspaceRef.value
  commandCenter.registerHandlers({
    revealSpan: (span) => {
      ws?.revealSpan(span)
    },
    formatDocument: async () => {
      if (ws) return ws.formatDocument()
      const { formatActiveDocument } = await import('../composables/useFormatDocument')
      return formatActiveDocument(null)
    },
    undoRedo: (cmd) => {
      void (cmd === 'undo' ? history.undo() : history.redo())
      return true
    },
    runEdit: onEdit,
    openNewFile: () => newProjectTemplateDialog.show(),
    openFile: () => files.openFile(),
    saveTab: () => files.saveWorkspace(),
    saveAsTab: () => files.saveAsTab(),
    closeActiveTab: () => files.closeActiveTab(),
    openDevTools: onDevTools,
    openRefine: () => { refineOpen.value = true },
    openCoverage: () => { workspaceRef.value?.focusCoverage() }
  })
}

watch([workspaceRef, showDocumentEditor], () => registerCommandCenterHandlers(), { immediate: true })

useKeyboardShortcuts(
  (cmd) => onEdit(cmd),
  onDevTools,
  () => newProjectTemplateDialog.show(),
  onFormat,
  onUndoRedo,
  {
    openCommandCenter: (q) => commandCenter.open(q),
    isCommandCenterOpen: () => commandCenter.isOpen,
    closeCommandCenter: () => commandCenter.close()
  },
  () => editorUi.toggleProjectSidebar(),
  () => settings.show(),
  (mode) => {
    workspace.setInformalCollapsed(false)
    if (mode === 'explorer') sidebar.showExplorer()
    else void sidebar.openFindInFiles(mode === 'replace')
  }
)

let unsubClose: (() => void) | undefined

onMounted(() => {
  unsubClose = window.studio?.onRequestClose(() => {
    files.tryCloseWindow()
  })
})

onUnmounted(() => {
  unsubClose?.()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <TitleBar @edit="onEdit" @dev-tools="onDevTools" @format="onFormat" @refine="refineOpen = true" />
    <EditorTabs v-if="!workspace.hasWorkspace" />
    <main class="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-surface-raised">
      <WorkspaceLayout v-if="workspace.hasWorkspace" />
      <HomeView v-else-if="doc.isHomeActive" />
      <WelcomeView v-else-if="doc.showWelcomeFallback" />
      <template v-else-if="showDocumentEditor">
        <EditorToolbar @format="onFormat" />
        <div class="flex min-h-0 min-w-0 w-full flex-1">
          <SidebarResizeSplit class="min-h-0 min-w-0 w-full flex-1">
            <template #sidebar>
              <ProjectSidebar />
            </template>
            <template #main>
              <EditorWorkspace ref="workspaceRef" class="min-h-0 min-w-0 w-full flex-1" />
            </template>
          </SidebarResizeSplit>
        </div>
      </template>
    </main>
    <StatusBar />
    <NewProjectTemplateDialog />
    <RefinementWizard v-if="refineOpen" :open="refineOpen" @close="refineOpen = false" />
    <Modal
      v-if="modalStore.request"
      :open="!!modalStore.request"
      :title="modalStore.request.title"
      :message="modalStore.request.message"
      :buttons="modalStore.request.buttons"
      :button-variants="modalStore.request.buttonVariants"
      :input="modalStore.request.input"
      :input-value="modalStore.request.inputValue"
      :input-placeholder="modalStore.request.inputPlaceholder"
      :checkbox="modalStore.request.checkbox"
      :checkbox-label="modalStore.request.checkboxLabel"
      :checkbox-value="modalStore.request.checkboxValue"
      @action="(i, v, c) => modalStore.respond(i, v, c)"
      @close="modalStore.dismiss"
    />
    <SettingsDialog />
  </div>
</template>
