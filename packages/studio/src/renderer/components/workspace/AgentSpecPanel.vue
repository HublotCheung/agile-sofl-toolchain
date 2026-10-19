<script setup lang="ts">
import { useTraceabilityStore } from '../../stores/traceability'
import { useI18n } from 'vue-i18n'
import AgentPanel from './agent/AgentPanel.vue'
import DockPanelChrome from './dock/DockPanelChrome.vue'
import FullscreenPanel from './FullscreenPanel.vue'
import WorkspacePanel from './WorkspacePanel.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useInformalSpec } from '../../composables/useInformalSpec'
import { applyHybridDocumentPatch } from '../../lib/applyHybridDocumentPatch'
import type { InformalPatchPayload } from '../../../preload/index'
import { computed } from 'vue'

defineProps<{
  title: string
}>()

const { t } = useI18n()
const workspace = useWorkspaceStore()
const tabId = computed(() => workspace.informalTab?.id)
const { tab, applyPatch } = useInformalSpec(tabId)

async function onApplyPatch(
  patch: InformalPatchPayload
): Promise<{ ok: boolean; error?: string; applied?: boolean }> {
  return applyPatch(patch)
}

async function onApplyHybridPatch(
  patch: InformalPatchPayload
): Promise<{ ok: boolean; error?: string; applied?: boolean }> {
  const result = await applyHybridDocumentPatch(patch, {
    noTab: t('agent.noHybridTab'),
    applyFailed: t('agent.applyFailed')
  }, (before,after)=>useTraceabilityStore().applyGeneratedContent(before,after,patch.traceLinks??[]))
  return result
}
</script>

<template>
  <FullscreenPanel panel-id="agent">
  <WorkspacePanel panel="agent" class="relative flex h-full min-h-0 flex-col" data-dock-host="agent">
    <DockPanelChrome panel="agent" :title="title" />
    <AgentPanel
      embed-in-dock
      class="min-h-0 flex-1"
      :informal-markdown="tab?.content ?? ''"
      :on-apply-patch="onApplyPatch"
      :on-apply-hybrid-patch="onApplyHybridPatch"
    />
  </WorkspacePanel>
  </FullscreenPanel>
</template>
