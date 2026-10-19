<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import type { TraceSide } from '../../../shared/traceability'
import TraceChangeCard from './TraceChangeCard.vue'
const props=defineProps<{side:TraceSide}>()
const trace=useTraceabilityStore(),{t,locale}=useI18n()
const links=computed(()=>trace.document.links.filter(l=>l.review!=='rejected'&&(!trace.focusedId||[l.source,l.target].includes(trace.focusedId!))).sort((a,b)=>Number(trace.notifications(props.side).includes(b))-Number(trace.notifications(props.side).includes(a))))
function cancel(){void window.studio?.traceCancel()}
</script>
<template>
  <section v-if="trace.opened===side&&!trace.activeAnchor" class="trace-workbench shrink-0 border-b border-border-subtle bg-surface-raised text-xs text-content-primary" :aria-label="t('trace.title')">
    <header class="flex items-center gap-2 px-3 py-2"><strong>{{ t('trace.title') }}</strong><span class="text-content-muted">{{ t('trace.noticeCount',{count:trace.notifications(side).length}) }}</span><button type="button" class="ml-auto px-1 text-content-muted" :aria-label="t('trace.close')" @click="trace.opened=null;trace.proposal=null">×</button></header>
    <div class="max-h-[38vh] space-y-2 overflow-auto px-3 pb-3 studio-scroll" :aria-busy="trace.busy||trace.loading">
      <p v-if="!trace.pair" class="text-content-muted">{{ t('trace.noPair') }}</p>
      <template v-else>
        <button v-if="trace.focusedId" type="button" class="text-content-muted hover:text-accent" @click="trace.focusedId=null">{{ t('trace.allRelated') }}</button>
        <TraceChangeCard v-for="link in links" :key="link.id" :link="link" :side="side" />
        <p v-if="!links.length" class="py-2 text-content-muted">{{ t('trace.autoBindingHint') }}</p>
        <details v-if="!trace.document.links.length" class="text-content-muted"><summary class="cursor-pointer">{{ t('trace.existingProject') }}</summary><p class="py-2">{{ t('trace.recoverHint') }}</p><button type="button" class="text-accent" :disabled="trace.busy" @click="trace.recover(locale,[])">{{ t('trace.recoverExisting') }}</button></details>
        <div v-for="j in trace.recoveries" :key="j.id" class="rounded border border-semantic-warning/30 p-2"><p>{{ t('trace.recoveryHint') }}</p><div class="mt-1 flex gap-3"><button type="button" :disabled="trace.busy" @click="trace.recoverTransaction(j.id,'restore')">{{ t('trace.restore') }}</button><button type="button" :disabled="trace.busy" @click="trace.recoverTransaction(j.id,'discard')">{{ t('trace.dismissRecovery') }}</button><button v-if="j.state==='buffers-applied'" type="button" :disabled="trace.busy" @click="trace.saveLinkedFiles()">{{ t('trace.saveAll') }}</button></div></div>
      </template>
      <p v-if="trace.busy||trace.loading" role="status" class="text-content-muted">{{ t('trace.working') }} <button v-if="trace.busy" type="button" class="ml-2" @click="cancel">{{ t('trace.cancel') }}</button></p>
      <p v-if="trace.error" role="alert" class="text-semantic-error">{{ trace.error }}</p>
      <p v-for="warning in trace.warnings" :key="warning" role="status" class="text-semantic-warning">{{ warning }}</p>
    </div>
  </section>
</template>
