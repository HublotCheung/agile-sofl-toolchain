<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
const trace = useTraceabilityStore(), { t } = useI18n()
const selected = ref<string[]>([])
watch(()=>trace.proposal,p=>{selected.value=p?.replacements.map(r=>r.entityId)??[]},{immediate:true})
const shared = computed(()=>trace.present.filter(e=>e.side==='hybrid'&&e.dependencies.some(id=>selected.value.includes(id))))
function toggle(id:string){selected.value=selected.value.includes(id)?selected.value.filter(v=>v!==id):[...selected.value,id]}
</script>
<template>
  <section v-if="trace.proposal" class="space-y-3 rounded-lg border border-accent/30 p-3" :aria-label="t('trace.preview')">
    <div class="flex items-center gap-2"><strong>{{ t('trace.preview') }}</strong><button type="button" class="ml-auto text-content-muted" @click="trace.proposal=null">{{ t('trace.cancel') }}</button></div>
    <p>{{ trace.proposal.explanation }}</p>
    <p v-if="trace.proposalStale" role="alert" class="text-semantic-warning">{{ t('trace.stalePreview') }}</p>
    <p v-if="!trace.proposal.replacements.length">{{ t('trace.noEdits') }}</p>
    <article v-for="r in trace.proposal.replacements" :key="r.entityId" class="space-y-1">
      <label class="flex items-center gap-2"><input type="checkbox" :checked="selected.includes(r.entityId)" @change="toggle(r.entityId)" />{{ trace.present.find(e=>e.id===r.entityId)?.title }}</label>
      <p class="text-content-muted">{{ r.reason }}</p>
      <div class="grid gap-2 md:grid-cols-2"><div><span class="text-content-muted">{{ t('trace.before') }}</span><pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-red-500/5 p-2 text-[11px]">{{ r.before }}</pre></div><div><span class="text-content-muted">{{ t('trace.after') }}</span><pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-emerald-500/5 p-2 text-[11px]">{{ r.after }}</pre></div></div>
    </article>
    <p v-if="shared.length" class="text-semantic-warning">{{ t('trace.shared') }} {{ shared.map(e=>e.title).join(', ') }}</p>
    <p class="text-content-muted">{{ t('trace.previewOnly') }}</p>
    <button type="button" class="rounded bg-accent px-3 py-1.5 text-accent-fg disabled:opacity-40" :disabled="trace.busy||trace.proposalStale||!selected.length" @click="trace.applyProposal(selected,t('trace.applyHistory'))">{{ t('trace.applySelected',{count:selected.length}) }}</button>
  </section>
</template>
