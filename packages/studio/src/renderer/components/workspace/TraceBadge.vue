<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import { filePathsEqual } from '../../stores/tabUtils'
import { traceNotification } from '../../../shared/traceInteraction'
import type { TraceSide } from '../../../shared/traceability'
import TraceChangeCard from './TraceChangeCard.vue'
const props=defineProps<{side:TraceSide;locator?:string}>()
const trace=useTraceabilityStore(),{t}=useI18n()
const anchorId=crypto.randomUUID(),button=ref<HTMLButtonElement|null>(null),panel=ref<HTMLElement|null>(null)
const position=ref({top:'0px',left:'0px'})
trace.start()
const entity=computed(()=>trace.present.find(e=>e.side===props.side&&e.locator===props.locator&&(!e.documentPath||filePathsEqual(trace.absolutePath(e.documentPath),(props.side==='informal'?trace.pair?.informalPath:trace.pair?.hybridPath)??''))))
const links=computed(()=>trace.document.links.filter(l=>l.review!=='rejected'&&(!props.locator||(entity.value&&[l.source,l.target].includes(entity.value.id)))))
const pending=computed(()=>links.value.some(l=>traceNotification(trace.document,l,props.side)))
const expanded=computed(()=>trace.activeAnchor===anchorId&&trace.opened===props.side)
function close(){if(!expanded.value)return;trace.activeAnchor=null;trace.opened=null;trace.proposal=null}
async function toggle(){
  if(expanded.value){close();return}
  trace.open(props.side,props.locator)
  if(!props.locator)return
  const rect=button.value!.getBoundingClientRect()
  position.value={top:Math.max(8,Math.min(rect.bottom+6,window.innerHeight-340))+'px',left:Math.max(8,Math.min(rect.left,window.innerWidth-440))+'px'}
  trace.activeAnchor=anchorId
  await nextTick();panel.value?.focus()
}
function outside(event:PointerEvent){if(!panel.value?.contains(event.target as Node)&&!button.value?.contains(event.target as Node))close()}
function escape(event:KeyboardEvent){if(event.key==='Escape'&&expanded.value){event.stopPropagation();close();button.value?.focus()}}
onMounted(()=>{document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape)})
onUnmounted(()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);close()})
</script>
<template>
  <button v-if="!locator||links.length" ref="button" type="button" class="shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" :class="pending?'bg-amber-500/10 text-semantic-warning':'text-content-muted'" :title="pending?t('trace.sourceChanged'):t('trace.openHint')" :aria-label="pending?t('trace.sourceChanged'):t('trace.links')" :aria-expanded="locator?expanded:trace.opened===side&&!trace.activeAnchor" @click.stop="toggle">
    <span aria-hidden="true">↔</span><span v-if="!locator" class="ml-1">{{ t('trace.links') }}</span><span v-if="pending" aria-hidden="true" class="ml-1">●</span>
  </button>
  <Teleport to="body">
    <aside v-if="expanded" ref="panel" tabindex="-1" role="dialog" :aria-label="t('trace.title')" class="fixed z-[1000] w-[420px] max-w-[calc(100vw-16px)] rounded-xl border border-border-subtle bg-surface-raised p-2 text-xs text-content-primary shadow-xl focus:outline-none" :style="position">
      <div class="flex items-center px-2 py-1.5"><strong>{{ t('trace.title') }}</strong><button type="button" class="ml-auto px-1 text-content-muted" :aria-label="t('trace.close')" @click="close();button?.focus()">×</button></div>
      <div class="max-h-[65vh] space-y-2 overflow-auto studio-scroll"><TraceChangeCard v-for="link in links" :key="link.id" :link="link" :side="side" /><p v-if="trace.busy" role="status" class="px-3 text-content-muted">{{ t('trace.working') }}</p><p v-if="trace.error" role="alert" class="px-3 text-semantic-error">{{ trace.error }}</p></div>
    </aside>
  </Teleport>
</template>
