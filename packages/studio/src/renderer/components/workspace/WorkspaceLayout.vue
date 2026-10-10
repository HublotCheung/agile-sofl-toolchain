<script setup lang="ts">
import { computed, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import ColumnResizeSplit from '../ui/ColumnResizeSplit.vue'
import ProjectModuleTree from './ProjectModuleTree.vue'
import StructureColumn from './StructureColumn.vue'
import WorkspaceDockLayout from './dock/WorkspaceDockLayout.vue'
import StudioIcon from '../ui/StudioIcon.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useVisualModel } from '../../composables/useVisualModel'
import { useGuiModel } from '../../composables/useGuiModel'
import { VISUAL_MODEL_KEY } from '../../composables/visualModelContext'
import { GUI_MODEL_KEY } from '../../composables/guiModelContext'

const { t } = useI18n()
const workspace = useWorkspaceStore()
const hybridTabId = computed(() => workspace.hybridTab?.id)
const visual = useVisualModel(hybridTabId)
provide(VISUAL_MODEL_KEY, visual)
const gui = useGuiModel(
  computed(() => workspace.guiTab?.id),
  { informalTabId: computed(() => workspace.informalTab?.id) }
)
provide(GUI_MODEL_KEY, gui)

/** [tree, center dock, structure] */
const collapsed = computed(() => [
  workspace.informalCollapsed,
  false,
  workspace.structureCollapsed
])

const collapseBtnClass =
  'relative z-10 flex h-16 w-5 select-none items-center justify-center rounded-md border border-border-subtle bg-surface-raised text-content-secondary opacity-0 shadow-sm transition-all duration-150 group-hover/resize:opacity-100 hover:bg-surface-overlay hover:text-content-primary'

const edgeExpandBtnClass =
  'flex h-16 w-5 items-center justify-center border border-border-subtle bg-surface-raised text-content-secondary opacity-0 shadow-sm transition-all duration-150 group-hover/edge:opacity-100 hover:bg-surface-overlay hover:text-content-primary'
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 w-full flex-1">
    <div
      v-if="workspace.informalCollapsed"
      class="group/edge absolute left-0 top-0 z-30 flex h-full w-6 items-center justify-start"
    >
      <button
        type="button"
        :class="[edgeExpandBtnClass, 'rounded-r-md border-l-0']"
        :title="t('workspace.expandInformal')"
        :aria-label="t('workspace.expandInformal')"
        @click="workspace.setInformalCollapsed(false)"
      >
        <StudioIcon icon="lucide:chevron-right" :size="14" />
      </button>
    </div>
    <div
      v-if="workspace.structureCollapsed"
      class="group/edge absolute right-0 top-0 z-30 flex h-full w-6 items-center justify-end"
    >
      <button
        type="button"
        :class="[edgeExpandBtnClass, 'rounded-l-md border-r-0']"
        :title="t('workspace.expandStructure')"
        :aria-label="t('workspace.expandStructure')"
        @click="workspace.setStructureCollapsed(false)"
      >
        <StudioIcon icon="lucide:chevron-left" :size="14" />
      </button>
    </div>
    <ColumnResizeSplit
      class="min-h-0 min-w-0 w-full flex-1"
      :widths="workspace.columnWidths"
      :collapsed="collapsed"
      @update:widths="workspace.setColumnWidths($event)"
    >
      <template #col-0>
        <div class="h-full min-h-0 select-none">
          <ProjectModuleTree />
        </div>
      </template>
      <template #bar-0>
        <button
          type="button"
          :class="collapseBtnClass"
          :title="
            workspace.informalCollapsed ? t('workspace.expandInformal') : t('workspace.collapseInformal')
          "
          @pointerdown.stop
          @click="workspace.setInformalCollapsed(!workspace.informalCollapsed)"
        >
          <StudioIcon
            :icon="workspace.informalCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-left'"
            :size="14"
          />
        </button>
      </template>
      <template #col-1>
        <WorkspaceDockLayout />
      </template>
      <template #bar-1>
        <button
          type="button"
          :class="collapseBtnClass"
          :title="
            workspace.structureCollapsed ? t('workspace.expandStructure') : t('workspace.collapseStructure')
          "
          @pointerdown.stop
          @click="workspace.setStructureCollapsed(!workspace.structureCollapsed)"
        >
          <StudioIcon
            :icon="workspace.structureCollapsed ? 'lucide:chevron-left' : 'lucide:chevron-right'"
            :size="14"
          />
        </button>
      </template>
      <template #col-2>
        <div class="h-full min-h-0 select-none">
          <StructureColumn />
        </div>
      </template>
    </ColumnResizeSplit>
  </div>
</template>
