<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import { linkState } from '../../../shared/traceability'
const props=defineProps<{search?:string}>()
const trace=useTraceabilityStore(),{t}=useI18n()
const links=computed(()=>trace.document.links.filter(l=>l.review!=='rejected'&&(!trace.focusedId||[l.source,l.target].includes(trace.focusedId))&&(!props.search||[l.source,l.target].some(id=>trace.document.entities.find(e=>e.id===id)?.title.toLowerCase().includes(props.search!.toLowerCase())))).slice(0,100))
const nodes=computed(()=>trace.document.entities.filter(e=>links.value.some(l=>[l.source,l.target].includes(e.id))))
const left=computed(()=>nodes.value.filter(e=>e.side==='informal')),right=computed(()=>nodes.value.filter(e=>e.side==='hybrid'))
const y=(id:string)=>20+Math.max(0,(left.value.some(e=>e.id===id)?left.value:right.value).findIndex(e=>e.id===id))*60
const height=computed(()=>Math.max(120,Math.max(left.value.length,right.value.length)*60+30))
</script>
<template>
  <div class="overflow-auto rounded border border-border-subtle bg-surface-base" :aria-label="t('trace.graph')">
    <svg width="660" :height="height" role="group" :aria-label="t('trace.graph')">
      <path v-for="l in links" :key="l.id" :d="`M 250 ${y(l.source)+19} C 330 ${y(l.source)+19},330 ${y(l.target)+19},410 ${y(l.target)+19}`" fill="none" :stroke="linkState(trace.document,l)==='current'?'var(--accent)':'var(--semantic-warning)'" :stroke-dasharray="l.review==='suggested'?'4 3':undefined" opacity=".6"><title>{{ l.reason }}</title></path>
      <g v-for="e in nodes" :key="e.id" role="button" tabindex="0" :aria-label="e.title" class="cursor-pointer" @click="trace.reveal(e)" @keydown.enter.prevent="trace.reveal(e)" @keydown.space.prevent="trace.reveal(e)">
        <rect :x="e.side==='informal'?10:410" :y="y(e.id)" width="240" height="42" rx="6" fill="var(--surface-raised)" :stroke="e.present?'var(--border-subtle)':'var(--semantic-warning)'" />
        <text :x="e.side==='informal'?20:420" :y="y(e.id)+17" fill="var(--text-primary)" font-size="12">{{ e.title.slice(0,28) }}</text>
        <text :x="e.side==='informal'?20:420" :y="y(e.id)+33" fill="var(--text-muted)" font-size="10">{{ (e.documentPath??e.parent).slice(-37) }}</text>
      </g>
    </svg>
    <p class="px-2 pb-2 text-content-muted">{{ t('trace.graphHint') }}</p>
  </div>
</template>
<style scoped>g:focus rect{stroke:var(--accent);stroke-width:2;}</style>
