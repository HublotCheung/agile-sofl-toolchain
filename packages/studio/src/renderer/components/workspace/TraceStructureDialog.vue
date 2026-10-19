<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
const emit=defineEmits<{close:[]}>(),trace=useTraceabilityStore(),{t}=useI18n()
const ids=ref<string[]>(trace.focusedId?[trace.focusedId]:[])
const parts=ref([{title:'',description:''},{title:'',description:''}]),note=ref('')
const assignments=ref<Record<string,string[]>>({}),unlink=ref<Record<string,boolean>>({})
const nodes=computed(()=>trace.present.filter(e=>e.side==='informal'&&e.kind==='function'&&e.leaf))
const links=computed(()=>trace.document.links.filter(l=>trace.structurePreview?.from.includes(l.source)))
watch(links,values=>{for(const l of values)if(!assignments.value[l.id])assignments.value[l.id]=[]},{immediate:true})
watch([ids,parts],()=>{trace.structurePreview=null;assignments.value={};unlink.value={}},{deep:true})
const ready=computed(()=>note.value.trim()&&links.value.every(l=>assignments.value[l.id]?.length||unlink.value[l.id]))
async function preview(){await trace.previewStructure(ids.value,ids.value.length>1?[parts.value[0]!]:parts.value)}
async function apply(){const p=trace.structurePreview!;await trace.applyStructure({revision:p.revision,from:p.from,to:p.to,assignments:links.value.map(l=>({linkId:l.id,endpoint:'source',targets:unlink.value[l.id]?[]:assignments.value[l.id]??[]})),note:note.value});if(!trace.error)emit('close')}
</script>
<template>
  <section class="space-y-3 rounded border border-accent/40 p-3" :aria-label="t('trace.structure')">
    <strong>{{ t('trace.structure') }}</strong><p class="text-content-muted">{{ t('trace.structureHint') }}</p>
    <label class="block">{{ t('trace.choose') }}<select v-model="ids" multiple class="w-full rounded border border-border-subtle bg-surface-base p-1"><option v-for="e in nodes" :key="e.id" :value="e.id">{{ e.title }} · {{ e.documentPath??e.parent }}</option></select></label>
    <div v-for="(part,i) in (ids.length>1?[parts[0]!]:parts)" :key="i" class="space-y-1">
      <input v-model="part.title" class="w-full rounded border border-border-subtle bg-surface-base p-2" :placeholder="t('trace.requirementTitle')" :aria-label="t('trace.requirementTitle')" />
      <textarea v-model="part.description" class="w-full rounded border border-border-subtle bg-surface-base p-2" :placeholder="t('trace.requirementBody')" :aria-label="t('trace.requirementBody')" />
    </div>
    <button v-if="ids.length===1" type="button" class="rounded border border-border-subtle px-2 py-1" @click="parts.push({title:'',description:''})">{{ t('trace.addPart') }}</button>
    <button type="button" class="ml-2 rounded border border-border-subtle px-2 py-1" :disabled="trace.busy||!ids.length||(ids.length>1?[parts[0]!]:parts).some(p=>!p.title.trim())" @click="preview">{{ t('trace.preview') }}</button>
    <template v-if="trace.structurePreview">
      <div v-for="c in trace.structurePreview.changes" :key="c.path" class="grid grid-cols-1 gap-2">
        <strong>{{ c.path }}</strong><details><summary>{{ t('trace.before') }}</summary><pre class="max-h-40 overflow-auto whitespace-pre-wrap">{{ c.before }}</pre></details><pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-base p-2">{{ c.after }}</pre>
      </div>
      <p>{{ t('trace.rebindHint') }}</p>
      <div v-for="l in links" :key="l.id" class="space-y-1 border-t border-border-subtle pt-2">
        <p>{{ trace.document.entities.find(e=>e.id===l.source)?.title }} ↔ {{ trace.document.entities.find(e=>e.id===l.target)?.title }}</p>
        <select v-model="assignments[l.id]" multiple class="w-full rounded border border-border-subtle bg-surface-base p-1" :aria-label="t('trace.choose')"><option v-for="id in trace.structurePreview.to" :key="id" :value="id">{{ trace.structurePreview.document.entities.find(e=>e.id===id)?.title }}</option></select>
        <label class="flex gap-1"><input v-model="unlink[l.id]" type="checkbox" />{{ t('trace.explicitUnlink') }}</label>
      </div>
      <input v-model="note" class="w-full rounded border border-border-subtle bg-surface-base p-2" :placeholder="t('trace.reason')" :aria-label="t('trace.reason')" />
      <button type="button" class="rounded bg-accent px-2 py-1 text-accent-fg" :disabled="trace.busy||!ready" @click="apply">{{ t('trace.applyPlan') }}</button>
    </template>
    <button type="button" class="ml-2 rounded border border-border-subtle px-2 py-1" @click="trace.structurePreview=null;emit('close')">{{ t('trace.cancel') }}</button>
  </section>
</template>
