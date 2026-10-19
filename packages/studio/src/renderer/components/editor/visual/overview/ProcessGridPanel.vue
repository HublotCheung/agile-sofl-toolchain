<script setup lang="ts">
import TraceBadge from '../../../workspace/TraceBadge.vue'
import { useI18n } from 'vue-i18n'
import type { VisualModuleProcess } from '../../../../preload/index'
import EmptyState from '../ui/EmptyState.vue'
import SectionCard from '../ui/SectionCard.vue'
import VisualEntityMenu from './VisualEntityMenu.vue'

defineProps<{
  processes: VisualModuleProcess[]
  moduleName?: string
  disabled?: boolean
  editDisabled?: boolean
}>()

const emit = defineEmits<{
  edit: [name: string]
  remove: [name: string]
}>()

const { t } = useI18n()

function portSummary(groups?: Array<{ names: string; type: string }>): string {
  if (!groups?.length) return '—'
  return groups.map((g) => `${g.names}: ${g.type}`).join(', ')
}
</script>

<template>
  <SectionCard>
    <template #title>
      <h3 class="text-sm font-semibold text-content-primary">{{ t('visual.section.processes') }}</h3>
    </template>
    <EmptyState v-if="!processes.length" :message="t('visual.process.empty')" />
    <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <article
        v-for="p in processes"
        :id="`visual-process-${p.name}`"
        :key="p.name"
        class="flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-raised shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
      >
        <header class="flex items-center gap-2 border-b border-border-subtle bg-surface-base px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-content-primary">{{ p.isInit ? 'Init' : p.name }}</p>
            <p v-if="p.isAlias" class="text-[10px] text-content-muted">{{ t('visual.alias.badge') }}</p>
          </div>
          <span
            v-if="p.isInit"
            class="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent"
          >
            {{ t('visual.init.badge') }}
          </span>
          <TraceBadge v-if="moduleName" side="hybrid" :locator="`proc:${moduleName}.${p.name}`" />
          <VisualEntityMenu
            :disabled="disabled"
            :edit-disabled="editDisabled"
            @edit="emit('edit', p.name)"
            @remove="emit('remove', p.name)"
          />
        </header>
        <div class="space-y-2 px-3 py-2 text-[12px]">
          <p>
            <span class="text-content-muted">{{ t('visual.input') }}</span>
            <span class="ml-1 font-mono text-content-primary">{{ portSummary(p.inputs) }}</span>
          </p>
          <p>
            <span class="text-content-muted">{{ t('visual.output') }}</span>
            <span class="ml-1 font-mono text-content-primary">{{ portSummary(p.outputs) }}</span>
          </p>
          <p class="text-content-secondary">
            {{ t('visual.scenarios') }}: {{ p.scenarioCount ?? 0 }}
            <span v-if="p.comment" class="ml-2 truncate text-content-muted">{{ p.comment.replace(/^comment:\s*/i, '') }}</span>
          </p>
        </div>
      </article>
    </div>
  </SectionCard>
</template>
