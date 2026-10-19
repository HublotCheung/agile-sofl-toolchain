<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
const props=defineProps<{from:string[]}>(),emit=defineEmits<{close:[]}>()
const trace=useTraceabilityStore(),{t}=useI18n(),note=ref(''),choices=ref<Record<string,string[]>>({}),unlink=ref<Record<string,boolean>>({})
const links=computed(()=>trace.document.links.filter(l=>props.from.includes(l.source)||props.from.includes(l.target)))
watch(links,values=>{for(const l of values)if(!choices.value[l.id])choices.value[l.id]=[]},{immediate:true})
const endpoint=(l:typeof links.value[number])=>props.from.includes(l.source)?'source' as const:'target' as const
const options=(l:typeof links.value[number])=>trace.present.filter(e=>e.side===(endpoint(l)==='source'?'informal':'hybrid')&&!props.from.includes(e.id))
const valid=computed(()=>note.value.trim()&&links.value.every(l=>(choices.value[l.id]?.length??0)>0||unlink.value[l.id]))
async function apply(){await trace.rebind({revision:trace.document.revision,from:props.from,to:[...new Set(Object.values(choices.value).flat())],assignments:links.value.map(l=>({linkId:l.id,endpoint:endpoint(l),targets:unlink.value[l.id]?[]:choices.value[l.id]??[]})),note:note.value});if(!trace.error)emit('close')}
</script>
<template>
  <section class="space-y-3 rounded-lg border border-accent/40 p-3" :aria-label="t('trace.rebindPlan')">
    <strong>{{ t('trace.rebindPlan') }}</strong><p class="text-content-muted">{{ t('trace.rebindHint') }}</p>
    <div v-for="l in links" :key="l.id" class="space-y-1 border-t border-border-subtle pt-2">
      <p>{{ trace.document.entities.find(e=>e.id===l.source)?.title }} ↔ {{ trace.document.entities.find(e=>e.id===l.target)?.title }}</p>
      <select v-model="choices[l.id]" multiple class="w-full rounded border border-border-subtle bg-surface-base p-1" :aria-label="t('trace.choose')"><option v-for="e in options(l)" :key="e.id" :value="e.id">{{ e.title }} · {{ e.documentPath??e.parent }}</option></select>
      <label class="flex items-center gap-1"><input v-model="unlink[l.id]" type="checkbox" />{{ t('trace.explicitUnlink') }}</label>
    </div>
    <label class="block">{{ t('trace.reason') }}<textarea v-model="note" class="w-full rounded border border-border-subtle bg-surface-base p-2" /></label>
    <div class="flex gap-2"><button type="button" class="rounded border border-border-subtle px-2 py-1" :disabled="!valid||trace.busy" @click="apply">{{ t('trace.applyPlan') }}</button><button type="button" class="rounded border border-border-subtle px-2 py-1" @click="emit('close')">{{ t('trace.cancel') }}</button></div>
  </section>
</template>
