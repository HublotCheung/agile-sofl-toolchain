<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import { filePathsEqual } from '../../stores/tabUtils'
import { linkState, type TraceSide } from '../../../shared/traceability'
const props = defineProps<{ side: TraceSide; locator?: string }>()
const trace = useTraceabilityStore()
const { t } = useI18n()
trace.start()
const entity = computed(() => trace.present.find(e => e.side === props.side && e.locator === props.locator && (!e.documentPath||filePathsEqual(trace.absolutePath(e.documentPath),(props.side==='informal'?trace.pair?.informalPath:trace.pair?.hybridPath)??''))))
const links = computed(() => trace.document.links.filter(l => l.review !== 'rejected' && (!props.locator || (entity.value && (l.source === entity.value.id || l.target === entity.value.id)))))
const pending = computed(() => links.value.some(l => l.review === 'suggested' || linkState(trace.document, l) !== 'current'))
</script>
<template>
  <button type="button" class="shrink-0 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    :class="pending ? 'border-semantic-warning/50 text-semantic-warning' : 'border-border-subtle text-content-secondary'"
    :title="t('trace.openHint')" :aria-expanded="trace.opened === side" @click.stop="trace.open(side, locator)">
    {{ t('trace.links') }} {{ links.length }}<span v-if="pending" aria-hidden="true"> •</span>
  </button>
</template>
