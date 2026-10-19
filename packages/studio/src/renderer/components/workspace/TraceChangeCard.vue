<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import { traceNotification } from '../../../shared/traceInteraction'
import { linkBaseline, linkState, type TraceLink, type TraceSide } from '../../../shared/traceability'
import TraceUpdatePreview from './TraceUpdatePreview.vue'
const props=defineProps<{link:TraceLink;side:TraceSide}>()
const trace=useTraceabilityStore(),{t,locale}=useI18n()
const counterpart=computed(()=>trace.document.entities.find(e=>e.id===(props.side==='hybrid'?props.link.source:props.link.target)))
const receiving=computed(()=>trace.document.entities.find(e=>e.id===(props.side==='hybrid'?props.link.target:props.link.source)))
const attention=computed(()=>traceNotification(trace.document,props.link,props.side))
const state=computed(()=>linkState(trace.document,props.link))
const upstream=computed(()=>props.side==='hybrid'?'informal':'hybrid')
const acknowledged=computed(()=>props.link.acknowledged?.[props.side]?.[upstream.value]===linkBaseline(trace.document,props.link)[upstream.value])
const changes=computed(()=>{
  const before=props.link.baseline[upstream.value].split('\n'),after=linkBaseline(trace.document,props.link)[upstream.value].split('\n')
  let start=0,end=0
  while(start<before.length&&start<after.length&&before[start]===after[start])start++
  while(end<before.length-start&&end<after.length-start&&before[before.length-end-1]===after[after.length-end-1])end++
  return {before:before.slice(start,before.length-end).join('\n'),after:after.slice(start,after.length-end).join('\n')}
})
</script>
<template>
  <article class="space-y-2 rounded-lg px-3 py-2" :class="attention?'border-l-2 border-semantic-warning bg-amber-500/5':'bg-surface-base'">
    <div class="flex flex-wrap items-center gap-1.5"><strong>{{ receiving?.title }}</strong><span class="text-content-muted">←</span><button type="button" class="text-accent hover:underline" :disabled="!counterpart?.present" @click="counterpart&&trace.reveal(counterpart)">{{ counterpart?.title }}</button><span v-if="attention" class="ml-auto text-semantic-warning">{{ t('trace.sourceChanged') }}</span></div>
    <p v-if="!counterpart?.present" class="text-content-muted">{{ t('trace.sourceMissing') }}</p>
    <template v-else-if="attention">
      <p v-if="state==='conflict'" class="text-semantic-warning">{{ t('trace.bothEdited') }}</p>
      <details><summary class="cursor-pointer text-content-muted">{{ t('trace.changeSummary') }}</summary><div class="mt-1 space-y-1"><pre v-if="changes.before" class="max-h-32 overflow-auto whitespace-pre-wrap break-words bg-red-500/5 p-2 text-[11px]">− {{ changes.before }}</pre><pre v-if="changes.after" class="max-h-32 overflow-auto whitespace-pre-wrap break-words bg-emerald-500/5 p-2 text-[11px]">+ {{ changes.after }}</pre></div></details>
      <div class="flex items-center gap-3 pt-1">
        <button type="button" class="text-content-muted hover:text-content-primary disabled:opacity-40" :disabled="trace.busy" @click="trace.acknowledge(link.id,side)">{{ t('trace.acknowledge') }}</button>
        <button type="button" class="text-accent disabled:opacity-40" :disabled="trace.busy||!receiving?.present" @click="trace.editRelated(link.id,side)">{{ t('trace.editManually') }}</button>
        <button type="button" class="rounded bg-accent/10 px-2 py-1 text-accent disabled:opacity-40" :disabled="trace.busy||!receiving?.present" @click="trace.suggest(link.id,side,locale)">{{ t('trace.aiEdit') }}</button>
      </div>
    </template>
    <p v-else class="text-content-muted">{{ state==='current'?t('trace.boundAutomatically'):acknowledged?t('trace.changeAcknowledged'):t('trace.localChangeNotified') }}</p>
    <TraceUpdatePreview v-if="trace.proposal?.linkId===link.id" />
  </article>
</template>
