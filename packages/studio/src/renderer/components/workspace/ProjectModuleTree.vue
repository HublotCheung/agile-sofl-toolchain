<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../../stores/workspace'
import type { IndexedProject, ProjectModuleInfo, ProjectModuleMember } from '../../../preload/index'
import { VISUAL_MODEL_KEY } from '../../composables/visualModelContext'
import { useGitStatus } from '../../composables/useGitStatus'
import { initWorkspaceTreeMenuProviders } from '../../workspaceTree/init'
import { buildWorkspaceTreeMenu } from '../../workspaceTree/registry'
import { executeWorkspaceTreeAction, promptNewProject } from '../../workspaceTree/actions'
import type { WorkspaceTreeContext } from '../../workspaceTree/types'
import WorkspaceTreeContextMenu from './WorkspaceTreeContextMenu.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import SearchView from './SearchView.vue'
import StudioIcon from '../ui/StudioIcon.vue'
import { useSidebarViewStore } from '../../stores/sidebarView'
import { contextMenuPoint } from '../../lib/contextMenuPoint'

initWorkspaceTreeMenuProviders()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const sidebar = useSidebarViewStore()
const visual = inject(VISUAL_MODEL_KEY, null)
const git = useGitStatus()

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuCtx = ref<WorkspaceTreeContext>({ kind: 'blank' })
const expandedModuleKeys = ref<string[]>([])
const menuItems = computed(() => {
  void git.gitState.byRoot
  return buildWorkspaceTreeMenu(menuCtx.value)
})

function sortedModules(projectId: string): ProjectModuleInfo[] {
  return [...workspace.modulesFor(projectId)]
    .filter((m) => m.name.trim() && m.displayName.trim())
    .sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1
      return a.displayName.localeCompare(b.displayName)
    })
}

function moduleKey(projectId: string, mod: ProjectModuleInfo): string {
  return `${projectId}:${mod.filePath}:${mod.name}`
}

function isModuleExpanded(projectId: string, mod: ProjectModuleInfo): boolean {
  return expandedModuleKeys.value.includes(moduleKey(projectId, mod))
}

function toggleModuleExpanded(projectId: string, mod: ProjectModuleInfo, e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  const key = moduleKey(projectId, mod)
  if (expandedModuleKeys.value.includes(key)) {
    expandedModuleKeys.value = expandedModuleKeys.value.filter((k) => k !== key)
  } else {
    expandedModuleKeys.value = [...expandedModuleKeys.value, key]
  }
}

function memberLabel(kind: ProjectModuleMember['kind']): string {
  if (kind === 'type') return t('visual.section.type')
  if (kind === 'var') return t('visual.section.var')
  if (kind === 'const') return t('visual.section.const')
  if (kind === 'inv') return t('visual.section.inv')
  if (kind === 'process') return t('visual.section.processes')
  if (kind === 'function') return t('visual.section.functions')
  return t('visual.section.gui')
}

function namedMembers(mod: ProjectModuleInfo): ProjectModuleMember[] {
  return (mod.members ?? []).filter((m) => m.name.trim())
}

function depthOf(projectId: string, name: string, seen = new Set<string>()): number {
  const mod = workspace.modulesFor(projectId).find((m) => m.name === name)
  if (!mod?.parentName || seen.has(name)) return 0
  seen.add(name)
  return 1 + depthOf(projectId, mod.parentName, seen)
}

function showMenu(e: MouseEvent, ctx: WorkspaceTreeContext): void {
  e.preventDefault()
  e.stopPropagation()
  menuCtx.value = ctx
  const pt = contextMenuPoint(e)
  menuX.value = pt.x
  menuY.value = pt.y
  menuOpen.value = true
}

async function onPick(action: Parameters<typeof executeWorkspaceTreeAction>[0]): Promise<void> {
  menuOpen.value = false
  await executeWorkspaceTreeAction(action, menuCtx.value, visual, t)
}

async function onSelectModule(project: IndexedProject, name: string): Promise<void> {
  if (project.id !== workspace.activeProjectId) {
    const ok = await workspace.requestActivateProject(project)
    if (!ok) return
  }
  workspace.selectModule(name)
}

async function onSelectMember(
  project: IndexedProject,
  mod: ProjectModuleInfo,
  member: ProjectModuleMember
): Promise<void> {
  if (project.id !== workspace.activeProjectId) {
    const ok = await workspace.requestActivateProject(project)
    if (!ok) return
  }
  if (member.kind === 'process') {
    workspace.selectModule(mod.name, { kind: 'process', moduleName: mod.name, processName: member.name })
  } else if (member.kind === 'function') {
    workspace.selectModule(mod.name, { kind: 'function', moduleName: mod.name, functionName: member.name })
  } else {
    workspace.selectModule(mod.name, { kind: 'module', moduleName: mod.name })
  }
  workspace.setFocusedPanel('hybrid')
}

function onProjectClick(project: IndexedProject): void {
  if (project.id !== workspace.activeProjectId) return
  workspace.toggleProjectExpanded(project.id)
}

async function onOpenProject(project: IndexedProject): Promise<void> {
  await workspace.requestActivateProject(project)
}

function isDirty(projectId: string, name: string): boolean {
  return projectId === workspace.activeProjectId && workspace.isModuleDirty(name)
}

function moduleContext(project: IndexedProject, mod: ProjectModuleInfo): WorkspaceTreeContext {
  if (mod.isSystem) return { kind: 'systemModule', project, module: mod }
  return { kind: 'module', project, module: mod }
}

function gitClassForProject(project: IndexedProject): string {
  return git.classForProject(project.rootPath)
}

function gitClassForModule(project: IndexedProject, mod: ProjectModuleInfo): string {
  return git.classForModule(project.rootPath, mod.filePath)
}

watch(
  () => workspace.projects.map((p) => p.rootPath).join('\0'),
  () => {
    for (const project of workspace.projects) {
      void git.refreshGitFor(project.rootPath)
    }
  },
  { immediate: true }
)
</script>

<template>
  <WorkspacePanel panel="tree" class="flex flex-col overflow-hidden bg-surface-raised">
    <div class="flex h-8 shrink-0 items-end border-b border-border-subtle px-1">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center border-b-2"
        :class="
          sidebar.view === 'explorer'
            ? 'border-accent text-content-primary'
            : 'border-transparent text-content-muted hover:text-content-primary'
        "
        :title="`${t('workspace.view.explorer')} (Ctrl+Shift+E)`"
        :aria-label="t('workspace.view.explorer')"
        :aria-pressed="sidebar.view === 'explorer'"
        @click="sidebar.showExplorer()"
      >
        <StudioIcon icon="hugeicons:hierarchy-square-01" :size="16" />
      </button>
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center border-b-2"
        :class="
          sidebar.view === 'search'
            ? 'border-accent text-content-primary'
            : 'border-transparent text-content-muted hover:text-content-primary'
        "
        :title="`${t('workspace.view.search')} (Ctrl+Shift+F)`"
        :aria-label="t('workspace.view.search')"
        :aria-pressed="sidebar.view === 'search'"
        @click="sidebar.showSearch()"
      >
        <StudioIcon icon="lucide:search" :size="16" />
      </button>
    </div>
    <SearchView v-if="sidebar.view === 'search'" />
    <template v-else>
    <div class="flex h-7 shrink-0 items-center gap-0.5 border-b border-border-subtle px-1.5">
      <div
        class="flex min-w-0 flex-1 items-center truncate px-1 text-[11px] font-semibold uppercase tracking-wide text-content-primary"
        :title="t('workspace.fileHierarchy')"
      >
        {{ t('workspace.view.explorer') }}
      </div>
      <button
        type="button"
        class="rounded p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
        :title="t('workspace.newProject')"
        :aria-label="t('workspace.newProject')"
        @click="promptNewProject(t)"
      >
        <StudioIcon icon="lucide:folder-plus" :size="14" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
        :title="t('workspace.openProject')"
        :aria-label="t('workspace.openProject')"
        @click="workspace.openProjectFolder()"
      >
        <StudioIcon icon="lucide:folder-open" :size="14" />
      </button>
    </div>
    <div
      class="min-h-0 flex-1 overflow-y-auto studio-scroll p-1"
      @contextmenu="showMenu($event, { kind: 'blank' })"
    >
      <p v-if="!workspace.projects.length" class="px-2 py-3 text-xs text-content-muted">
        {{ t('workspace.emptyProjects') }}
      </p>
      <div v-for="project in workspace.projects" :key="project.id" class="mb-0.5">
        <div
          class="group/project flex h-6 w-full items-center gap-1 rounded px-1.5 text-left"
          :class="
            project.id === workspace.activeProjectId
              ? 'bg-accent/20 text-content-primary ring-1 ring-inset ring-accent/35'
              : 'bg-surface-overlay/80 text-content-secondary hover:bg-surface-overlay hover:text-content-primary'
          "
          :title="
            project.id === workspace.activeProjectId
              ? project.name
              : t('workspace.doubleClickToOpen')
          "
          @click="onProjectClick(project)"
          @dblclick="void onOpenProject(project)"
          @contextmenu="showMenu($event, { kind: 'project', project })"
        >
          <span class="flex w-3 shrink-0 items-center justify-center text-[9px] text-content-muted">
            <template v-if="project.id === workspace.activeProjectId">
              {{ workspace.expandedProjectIds.includes(project.id) ? '▾' : '▸' }}
            </template>
          </span>
          <span
            class="shrink-0"
            :class="project.id === workspace.activeProjectId ? 'text-accent' : 'text-content-muted'"
          >
            <StudioIcon
              :icon="project.id === workspace.activeProjectId ? 'lucide:folder-open' : 'lucide:folder'"
              :size="13"
            />
          </span>
          <span
            class="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight"
            :class="gitClassForProject(project)"
          >{{ project.name }}</span>
          <button
            v-if="project.id !== workspace.activeProjectId"
            type="button"
            class="shrink-0 rounded px-1.5 py-px text-[10px] font-medium text-accent opacity-0 transition-opacity group-hover/project:opacity-100 hover:bg-accent/15 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            :title="t('workspace.treeMenu.switchToProject')"
            :aria-label="t('workspace.treeMenu.switchToProject')"
            @click.stop="void onOpenProject(project)"
          >
            {{ t('workspace.treeMenu.switchToProject') }}
          </button>
        </div>
        <div
          v-if="
            project.id === workspace.activeProjectId &&
            workspace.expandedProjectIds.includes(project.id)
          "
          class="mt-px border-l border-border-subtle ml-2"
        >
          <div
            v-for="mod in sortedModules(project.id)"
            :key="moduleKey(project.id, mod)"
          >
            <button
              type="button"
              class="flex h-5 w-full items-center pr-1.5 text-left text-[11px] font-normal hover:bg-surface-overlay/70"
              :class="[
                project.id === workspace.activeProjectId && workspace.selectedModuleName === mod.name
                  ? 'bg-accent/10 text-content-primary'
                  : 'text-content-secondary',
                mod.isSystem ? 'text-content-primary' : ''
              ]"
              :style="{ paddingLeft: `${6 + depthOf(project.id, mod.name) * 10}px` }"
              @click="void onSelectModule(project, mod.name)"
              @contextmenu="showMenu($event, moduleContext(project, mod))"
            >
              <span
                class="flex w-3 shrink-0 items-center justify-center text-[9px] text-content-muted"
                @click="namedMembers(mod).length ? toggleModuleExpanded(project.id, mod, $event) : undefined"
              >
                <template v-if="namedMembers(mod).length">
                  {{ isModuleExpanded(project.id, mod) ? '▾' : '▸' }}
                </template>
              </span>
              <span class="min-w-0 flex-1 truncate" :class="gitClassForModule(project, mod)">{{
                mod.displayName
              }}</span>
              <span
                v-if="mod.isSystem"
                class="ml-1 rounded px-0.5 text-[8px] uppercase tracking-wide text-content-muted"
              >SYS</span>
              <span
                v-if="mod.isGui"
                class="ml-1 rounded px-0.5 text-[8px] uppercase tracking-wide text-accent"
              >GUI</span>
              <span v-if="isDirty(project.id, mod.name)" class="ml-1 text-[9px] text-accent">●</span>
            </button>
            <div v-if="isModuleExpanded(project.id, mod)">
              <button
                v-for="(member, idx) in namedMembers(mod)"
                :key="`${moduleKey(project.id, mod)}:${member.kind}:${member.name}:${idx}`"
                type="button"
                class="flex h-[18px] w-full items-center gap-1 pr-1.5 text-left text-[10px] text-content-muted hover:bg-surface-overlay/70 hover:text-content-secondary"
                :class="
                  project.id === workspace.activeProjectId &&
                  workspace.selectedModuleName === mod.name &&
                  ((member.kind === 'process' &&
                    workspace.selection?.kind === 'process' &&
                    workspace.selection.processName === member.name) ||
                    (member.kind === 'function' &&
                      workspace.selection?.kind === 'function' &&
                      workspace.selection.functionName === member.name))
                    ? 'bg-accent/10 text-content-primary'
                    : ''
                "
                :style="{ paddingLeft: `${22 + depthOf(project.id, mod.name) * 10}px` }"
                :title="`${memberLabel(member.kind)} ${member.name}`"
                @click="void onSelectMember(project, mod, member)"
              >
                <span class="shrink-0 text-[8px] uppercase tracking-wide text-content-muted/80">{{
                  member.kind === 'gui-screen' ? 'gui' : member.kind === 'process' ? 'proc' : member.kind
                }}</span>
                <span class="min-w-0 flex-1 truncate">{{ member.name }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </template>
    <WorkspaceTreeContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @pick="onPick"
      @close="menuOpen = false"
    />
  </WorkspacePanel>
</template>
