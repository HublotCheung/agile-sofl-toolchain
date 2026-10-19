<script setup lang="ts">
import TraceStructureDialog from './TraceStructureDialog.vue'
import TraceGraph from './TraceGraph.vue'
import TraceRebindDialog from './TraceRebindDialog.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTraceabilityStore } from '../../stores/traceability'
import { relocateTraceDocument } from '../../../shared/traceAdvanced'
import { linkBaseline, linkState, sameBaseline, type TraceLink, type TraceSide } from '../../../shared/traceability'
const props = defineProps<{ side: TraceSide }>()
const trace = useTraceabilityStore()
const { t, locale } = useI18n()
const filter = ref<'all' | 'pending' | 'suggested' | 'unlinked'>('all')
const search = ref(''), source = ref(''), target = ref(''), reason = ref(''), note = ref(''), relinkId = ref('')
const selected = ref<string[]>([])
const selectedLinks=ref<string[]>([]),rebindFrom=ref<string[]>([])
const showStructure=ref(false)
const bulkNote=ref(''),scopeMode=ref('project')
const relocationFrom=ref(''),relocationTo=ref('')
const relocationPreview=computed(()=>{try{return relocateTraceDocument(trace.document,relocationFrom.value,relocationTo.value)}catch{return null}})
const mergeChoices=ref<Record<string,'local'|'remote'>>({})
const showManual = ref(false), showRejected = ref(false)
const previewElement = ref<HTMLElement | null>(null)
const candidates = computed(() => trace.present.filter(e => e.side === props.side && (!search.value || `${e.title} ${e.parent} ${e.text}`.toLowerCase().includes(search.value.toLowerCase()))))
const focus = computed(() => trace.document.entities.find(e => e.id === trace.focusedId))
const activeLinks = computed(() => trace.document.links.filter(l => {
  if(scopeMode.value==='current'&&![entity(l.source),entity(l.target)].some(e=>e?.documentPath&&[trace.pair?.informalPath,trace.pair?.hybridPath].some(p=>p?.replace(/\\/g,'/').endsWith('/'+e.documentPath))))return false
  if (l.review === 'rejected' && !showRejected.value) return false
  if (search.value && ![entity(l.source), entity(l.target)].some(e => e && `${e.title} ${e.parent} ${e.context}`.toLowerCase().includes(search.value.toLowerCase()))) return false
  if (trace.focusedId && l.source !== trace.focusedId && l.target !== trace.focusedId) return false
  if (filter.value === 'suggested') return l.review === 'suggested'
  if (filter.value === 'pending') return l.review === 'confirmed' && linkState(trace.document, l) !== 'current'
  if (filter.value === 'unlinked') return false
  return true
}))
const unlinked = computed(() => candidates.value.filter(e => !trace.document.links.some(l => l.review === 'confirmed' && (l.source === e.id || l.target === e.id))))
const entity = (id: string) => trace.document.entities.find(e => e.id === id)
const coverage = computed(() => {
  if (!focus.value || focus.value.side !== 'informal' || focus.value.leaf) return null
  const leaves = trace.present.filter(e => e.side === 'informal' && e.leaf && e.dependencies.includes(focus.value!.id))
  const linked = leaves.filter(e => trace.document.links.some(l => l.source === e.id && l.review === 'confirmed' && state(l) !== 'missing'))
  return { total: leaves.length, count: linked.length }
})
const state = (link: TraceLink) => linkState(trace.document, link)
const deferred = (link: TraceLink) => sameBaseline(link.deferred, linkBaseline(trace.document, link))
const shared = computed(() => {
  const ids = selected.value
  return trace.present.filter(e => e.side === 'hybrid' && e.dependencies.some(id => ids.includes(id)))
})
watch(() => trace.proposal, async value => {
  selected.value = value?.replacements.map(r => r.entityId) ?? []
  if (value) { await nextTick(); previewElement.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
})
function selectLink(id:string){selectedLinks.value=selectedLinks.value.includes(id)?selectedLinks.value.filter(v=>v!==id):[...selectedLinks.value,id]}
function choose(id: string) {
  trace.focusedId = id || null
  if (props.side === 'informal') source.value = id
  else target.value = id
}
function startManual(link?: TraceLink) {
  relinkId.value = link?.id ?? ''
  source.value = link?.source ?? (props.side === 'informal' ? focus.value?.id ?? '' : '')
  target.value = link?.target ?? (props.side === 'hybrid' ? focus.value?.id ?? '' : '')
  reason.value = link?.reason ?? ''; showManual.value = true
}
async function add() {
  await trace.manual(source.value, target.value, reason.value, relinkId.value || undefined)
  if (!trace.error) { showManual.value = false; relinkId.value = '' }
}
function recoverCurrent(){const scope=focus.value?.side==='informal'?[focus.value.id]:scopeMode.value==='current'?trace.present.filter(e=>e.side==='informal'&&e.leaf&&e.kind==='function'&&e.documentPath&&trace.pair!.informalPath.replace(/\\/g,'/').endsWith('/'+e.documentPath)).map(e=>e.id):[];void trace.recover(locale.value,scope)}
function cancel() { void window.studio?.traceCancel() }
function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter(v => v !== id) : [...selected.value, id]
}
function changedLines(before: string, after: string): Array<{ text: string; kind: string }> {
  const a = before.replace(/\r\n/g, '\n').split('\n'), b = after.replace(/\r\n/g, '\n').split('\n')
  let start = 0, end = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  return [...a.slice(Math.max(0,start - 2),start).map(text => ({ text, kind: 'same' })),
    ...a.slice(start, a.length - end).map(text => ({ text, kind: 'removed' })),
    ...b.slice(start, b.length - end).map(text => ({ text, kind: 'added' })),
    ...b.slice(b.length - end, b.length - end + 2).map(text => ({ text, kind: 'same' }))]
}
</script>

<template>
  <section v-if="trace.opened === side" class="trace-workbench shrink-0 border-b border-border-subtle bg-surface-raised text-[12px] text-content-primary" :aria-label="t('trace.title')">
    <header class="flex flex-wrap items-center gap-2 px-3 py-2">
      <strong>{{ t('trace.title') }}</strong>
      <span class="text-content-muted">{{ t('trace.pendingCount', { count: trace.pending.length }) }}</span>
      <button type="button" class="ml-auto rounded px-2 hover:bg-accent/10" :aria-label="t('trace.close')" @click="trace.opened = null">×</button>
    </header>
    <div class="max-h-[54vh] space-y-3 overflow-auto px-3 pb-3 studio-scroll" :aria-busy="trace.busy || trace.loading">
      <p class="text-content-muted">{{ t('trace.description') }}</p>
      <p v-if="!trace.pair" role="status">{{ t('trace.noPair') }}</p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="trace-action" :disabled="trace.busy || trace.loading" @click="startManual()">{{ t('trace.add') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy || trace.loading" @click="recoverCurrent">{{ t('trace.recover') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.refreshNow().catch(e => trace.error = String(e.message))">{{ t('trace.refresh') }}</button>
          <button v-if="trace.busy" type="button" class="trace-action" @click="cancel">{{ t('trace.cancel') }}</button>
          <label class="flex items-center gap-1"><input v-model="trace.followSelection" type="checkbox" />{{ t('trace.follow') }}</label>
          <span v-if="trace.busy || trace.loading" role="status" class="text-content-muted">{{ t('trace.working') }}</span>
        </div>
        <div v-for="j in trace.recoveries" :key="j.id" class="space-y-2 rounded border border-semantic-warning/50 p-2" role="status">
          <p>{{ t('trace.recoveryHint') }} {{ j.at }}</p><p class="text-content-muted">{{ j.changes.map(c=>c.path).join(', ') }}</p>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.recoverTransaction(j.id,'restore')">{{ t('trace.restore') }}</button>
          <button type="button" class="trace-action ml-2" :disabled="trace.busy" @click="trace.recoverTransaction(j.id,'discard')">{{ t('trace.dismissRecovery') }}</button>
        </div>
        <p v-if="trace.progress" role="status" class="text-content-muted">{{ t('trace.progress',trace.progress) }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <label>{{ t('trace.workspaceScope') }} <select v-model="scopeMode" class="rounded border border-border-subtle bg-surface-base"><option value="project">{{ t('trace.projectScope') }}</option><option value="current">{{ t('trace.currentScope') }}</option></select></label>
          <button type="button" class="trace-action" :aria-pressed="trace.graphVisible" @click="trace.graphVisible=!trace.graphVisible">{{ t('trace.graph') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="showStructure=!showStructure">{{ t('trace.structure') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.saveLinkedFiles()">{{ t('trace.saveAll') }}</button>
        </div>
        <TraceGraph v-if="trace.graphVisible" :search="search" />
        <TraceStructureDialog v-if="showStructure" @close="showStructure=false" />
        <TraceRebindDialog v-if="rebindFrom.length" :from="rebindFrom" @close="rebindFrom=[]" />
        <input v-model="search" type="search" class="trace-field" :placeholder="t('trace.search')" :aria-label="t('trace.search')" />
        <select class="trace-field" :value="trace.focusedId ?? ''" :aria-label="t('trace.scope')" @change="choose(($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('trace.allItems') }}</option>
          <option v-for="e in candidates" :key="e.id" :value="e.id">{{ e.title }} · {{ e.documentPath??e.parent }}</option>
        </select>
        <p v-if="coverage" class="text-content-muted">{{ t('trace.childCoverage', coverage) }}</p>
        <div class="flex flex-wrap gap-1" role="group" :aria-label="t('trace.filter')">
          <button v-for="f in (['all','pending','suggested','unlinked'] as const)" :key="f" type="button" class="trace-action" :aria-pressed="filter === f" :class="filter === f ? 'bg-accent/15 text-accent' : ''" @click="filter = f">{{ t(`trace.filter.${f}`) }}</button>
          <label class="ml-auto flex items-center gap-1 text-content-muted"><input v-model="showRejected" type="checkbox" />{{ t('trace.showRejected') }}</label>
        </div>
        <form v-if="showManual" class="space-y-2 rounded border border-border-subtle p-2" @submit.prevent="add">
          <label class="block">Informal<select v-model="source" class="trace-field" required><option value="">{{ t('trace.choose') }}</option><option v-for="e in trace.present.filter(e => e.side === 'informal')" :key="e.id" :value="e.id">{{ e.title }} · {{ e.documentPath??e.parent }}</option></select></label>
          <label class="block">Hybrid<select v-model="target" class="trace-field" required><option value="">{{ t('trace.choose') }}</option><option v-for="e in trace.present.filter(e => e.side === 'hybrid')" :key="e.id" :value="e.id">{{ e.title }} · {{ e.parent }} · {{ e.kind }}</option></select></label>
          <label class="block">{{ t('trace.reason') }}<input v-model="reason" class="trace-field" :placeholder="t('trace.reasonHint')" /></label>
          <button type="submit" class="trace-action" :disabled="trace.busy || !source || !target">{{ t('trace.saveLink') }}</button>
          <button type="button" class="trace-action ml-2" @click="showManual = false">{{ t('trace.cancel') }}</button>
        </form>
        <div v-if="selectedLinks.length" class="flex flex-wrap items-center gap-2 rounded border border-border-subtle p-2">
          <span>{{ t('trace.selectedCount',{count:selectedLinks.length}) }}</span>
          <button type="button" class="trace-action" :disabled="trace.busy||selectedLinks.some(id=>trace.document.links.find(l=>l.id===id)?.review!=='suggested')" @click="trace.reviewMany(selectedLinks,'accept',bulkNote)">{{ t('trace.accept') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.reviewMany(selectedLinks,'reject',bulkNote)">{{ t('trace.reject') }}</button>
          <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.reviewMany(selectedLinks,'defer',bulkNote)">{{ t('trace.later') }}</button>
          <input v-model="bulkNote" class="trace-field" :placeholder="t('trace.reviewNote')" />
          <button type="button" class="trace-action" :disabled="trace.busy||!bulkNote.trim()" @click="trace.reviewMany(selectedLinks,'check',bulkNote)">{{ t('trace.noUpdate') }}</button>
        </div>
        <p v-if="!activeLinks.length && filter !== 'unlinked'" class="rounded border border-dashed border-border-subtle p-3 text-content-muted">{{ t('trace.empty') }}</p>
        <article v-for="link in activeLinks" :key="link.id" class="space-y-2 rounded-lg border border-border-subtle p-2.5">
          <div class="flex flex-wrap items-center gap-1 font-medium">
            <input type="checkbox" :aria-label="t('trace.selectLink')" :checked="selectedLinks.includes(link.id)" @change="selectLink(link.id)" />
            <button type="button" class="text-accent hover:underline" :disabled="!entity(link.source)?.present" @click="trace.reveal(entity(link.source)!)">{{ entity(link.source)?.title }}</button>
            <span>↔</span>
            <button type="button" class="text-accent hover:underline" :disabled="!entity(link.target)?.present" @click="trace.reveal(entity(link.target)!)">{{ entity(link.target)?.parent }}.{{ entity(link.target)?.title }}</button>
            <span class="ml-auto rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]" :class="state(link) !== 'current' ? 'text-semantic-warning' : 'text-content-muted'">{{ t(`trace.state.${state(link)}`) }}</span>
          </div>
          <p class="text-content-muted">{{ t(`trace.origin.${link.origin}`) }} · {{ t(`trace.review.${link.review}`) }}<span v-if="deferred(link)"> · {{ t('trace.deferred') }}</span></p>
          <p class="whitespace-pre-wrap break-words">{{ link.reason || t('trace.manualReason') }}</p>
          <p v-if="link.assessment" class="text-content-muted">{{ t('trace.modelAssessment') }} · {{ sameBaseline(link.assessment.baseline,linkBaseline(trace.document,link))?t(`trace.coverage.${link.assessment.result}`):t('trace.evidenceStale') }}</p>
          <ul v-if="link.assessment?.missingConstraints.length" class="list-inside list-disc text-semantic-warning"><li v-for="missing in link.assessment.missingConstraints" :key="missing">{{ missing }}</li></ul>
          <p v-if="link.note" class="text-content-muted">{{ link.note }}</p>
          <details>
            <summary class="cursor-pointer text-accent">{{ t('trace.evidence') }}</summary>
            <blockquote v-for="(e,i) in link.evidence??[]" :key="i" class="my-2 space-y-1 border-l-2 border-accent pl-2">
              <p>{{ e.requirementFragment }}</p><p>{{ e.specificationFragment }}</p><p class="text-content-muted">{{ sameBaseline(e.baseline,linkBaseline(trace.document,link))?t('trace.verifiedQuote'):t('trace.evidenceStale') }}</p>
            </blockquote>
            <div v-for="s in (['informal','hybrid'] as const)" :key="s" class="mt-2">
              <strong>{{ s === 'informal' ? 'Informal' : 'Hybrid' }}</strong>
              <p class="text-content-muted">{{ t('trace.sinceReview') }}</p>
              <pre class="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-base p-2 text-[11px]"><span v-for="(line,i) in changedLines(link.baseline[s], linkBaseline(trace.document,link)[s])" :key="i" class="block" :class="line.kind === 'removed' ? 'bg-red-500/10 text-red-500' : line.kind === 'added' ? 'bg-emerald-500/10 text-emerald-600' : ''">{{ line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  ' }}{{ line.text }}</span></pre>
              <details><summary class="cursor-pointer">{{ t('trace.currentText') }}</summary><pre class="max-h-52 overflow-auto whitespace-pre-wrap break-words bg-surface-base p-2 text-[11px]">{{ entity(s === 'informal' ? link.source : link.target)?.context }}</pre></details>
            </div>
          </details>
          <p v-if="state(link) === 'conflict'" class="text-semantic-warning">{{ t('trace.conflictHint') }}</p>
          <div class="flex flex-wrap gap-2">
            <template v-if="link.review === 'suggested'">
              <button type="button" class="trace-action" :disabled="trace.busy || state(link) === 'missing'" @click="trace.review(link.id, 'accept')">{{ t('trace.accept') }}</button>
              <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.review(link.id, 'reject')">{{ t('trace.reject') }}</button>
            </template>
            <template v-if="link.review === 'confirmed' && state(link) !== 'missing'">
              <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.suggest(link.id, 'hybrid', locale)">{{ t('trace.updateHybrid') }}</button>
              <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.suggest(link.id, 'informal', locale)">{{ t('trace.updateInformal') }}</button>
              <button v-if="state(link) !== 'current'" type="button" class="trace-action" :disabled="trace.busy" @click="trace.review(link.id, 'defer')">{{ t('trace.later') }}</button>
            </template>
            <button type="button" class="trace-action" :disabled="trace.busy||state(link)==='missing'" @click="trace.assess(link.id,locale)">{{ t('trace.assess') }}</button>
            <button type="button" class="trace-action" :disabled="trace.busy" @click="rebindFrom=[trace.opened==='informal'?link.source:link.target]">{{ t('trace.rebindPlan') }}</button>
            <button type="button" class="trace-action" :disabled="trace.busy" @click="startManual(link)">{{ t('trace.relink') }}</button>
            <button type="button" class="trace-action" :disabled="trace.busy" @click="trace.review(link.id, 'remove')">{{ t('trace.unlink') }}</button>
          </div>
          <form v-if="link.review === 'confirmed' && state(link) !== 'current' && state(link) !== 'missing'" class="flex gap-2" @submit.prevent="trace.review(link.id, 'check', note)">
            <input v-model="note" class="trace-field min-w-0 flex-1" required :placeholder="t('trace.reviewNote')" :aria-label="t('trace.reviewNote')" />
            <button type="submit" class="trace-action shrink-0" :disabled="trace.busy || !note.trim()">{{ t('trace.noUpdate') }}</button>
          </form>
        </article>
        <template v-if="filter === 'unlinked'">
          <p class="text-content-muted">{{ t('trace.unlinkedHint') }}</p>
          <button v-for="e in unlinked" :key="e.id" type="button" class="trace-action mr-1" @click="choose(e.id); startManual()">{{ e.title }}</button>
        </template>
        <section v-if="trace.proposal" ref="previewElement" class="space-y-3 rounded-lg border border-accent/40 p-3" :aria-label="t('trace.preview')">
          <div class="flex items-center"><strong>{{ t('trace.preview') }}</strong><button type="button" class="ml-auto trace-action" @click="trace.proposal = null">{{ t('trace.close') }}</button></div>
          <p class="whitespace-pre-wrap">{{ trace.proposal.explanation }}</p>
          <p v-if="trace.proposalStale" role="alert" class="text-semantic-warning">{{ t('trace.stalePreview') }}</p>
          <p v-if="!trace.proposal.replacements.length" class="text-content-muted">{{ t('trace.noEdits') }}</p>
          <article v-for="r in trace.proposal.replacements" :key="r.entityId" class="space-y-2 border-t border-border-subtle pt-2">
            <label class="flex items-center gap-2"><input type="checkbox" :checked="selected.includes(r.entityId)" @change="toggle(r.entityId)" /><strong>{{ entity(r.entityId)?.title }}</strong></label>
            <p>{{ r.reason }}</p>
            <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-base p-2 text-[11px]"><span v-for="(line,i) in changedLines(r.before,r.after)" :key="i" class="block" :class="line.kind === 'removed' ? 'bg-red-500/10 text-red-500' : line.kind === 'added' ? 'bg-emerald-500/10 text-emerald-600' : ''">{{ line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  ' }}{{ line.text }}</span></pre>
          </article>
          <p v-if="shared.length" class="text-semantic-warning">{{ t('trace.shared') }} {{ shared.map(e => `${e.parent}.${e.title}`).join(', ') }}</p>
          <p class="text-content-muted">{{ t('trace.applyHint') }}</p>
          <button type="button" class="trace-action bg-accent text-accent-fg" :disabled="trace.busy || trace.proposalStale || !selected.length" @click="trace.applyProposal(selected, t('trace.applyHistory'))">{{ t('trace.applySelected', { count: selected.length }) }}</button>
        </section>
        <details class="rounded border border-border-subtle p-2">
          <summary class="cursor-pointer">{{ t('trace.more') }}</summary>
          <div class="mt-2 space-y-2">
            <label>{{ t('trace.provider') }} <select v-model="trace.providerId" class="rounded border border-border-subtle bg-surface-base"><option v-for="p in trace.availableProviders" :key="p.id" :value="p.id">{{ p.id==='studio'?t('trace.studioProvider'):p.name }}</option></select></label>
            <label>{{ t('trace.analysisMode') }} <select v-model="trace.analysisMode" class="rounded border border-border-subtle bg-surface-base"><option value="complete">{{ t('trace.completeAnalysis') }}</option><option value="focused">{{ t('trace.focusedAnalysis') }}</option></select></label>
            <p class="text-content-muted">{{ t('trace.tokenHint') }}</p>
            <div class="flex gap-2"><button type="button" class="trace-action" :disabled="trace.busy" @click="trace.exportReview()">{{ t('trace.exportReview') }}</button><button type="button" class="trace-action" :disabled="trace.busy" @click="trace.importReview()">{{ t('trace.importReview') }}</button></div>
            <div v-if="trace.mergePreview" class="space-y-2">
              <p>{{ t('trace.mergeHint') }}</p>
              <article v-for="c in trace.mergePreview.conflicts" :key="c.collection+c.id" class="rounded border border-semantic-warning/40 p-2">
                <p>{{ c.collection }} · {{ c.id }}</p>
                <label class="block"><input v-model="mergeChoices[c.collection+':'+c.id]" type="radio" value="local" />{{ t('trace.keepLocal') }}</label>
                <pre class="max-h-28 overflow-auto whitespace-pre-wrap text-[10px]">{{ JSON.stringify(c.local,null,2) }}</pre>
                <label class="block"><input v-model="mergeChoices[c.collection+':'+c.id]" type="radio" value="remote" />{{ t('trace.keepRemote') }}</label>
                <pre class="max-h-28 overflow-auto whitespace-pre-wrap text-[10px]">{{ JSON.stringify(c.remote,null,2) }}</pre>
              </article>
              <button v-if="trace.mergePreview.conflicts.length" type="button" class="trace-action" :disabled="trace.busy||trace.mergePreview.conflicts.some(c=>!mergeChoices[c.collection+':'+c.id])" @click="trace.importReview(mergeChoices)">{{ t('trace.resolveMerge') }}</button>
              <button v-else type="button" class="trace-action" :disabled="trace.busy" @click="trace.applyMerge()">{{ t('trace.applyMerge') }}</button>
            </div>
            <details v-if="trace.document.files?.some(f=>!f.present)">
              <summary class="cursor-pointer">{{ t('trace.relocateFile') }}</summary>
              <select v-model="relocationFrom" class="trace-field" :aria-label="t('trace.missingFile')"><option value="">{{ t('trace.missingFile') }}</option><option v-for="f in trace.document.files.filter(f=>!f.present)" :key="f.id" :value="f.id">{{ f.path }}</option></select>
              <select v-model="relocationTo" class="trace-field" :aria-label="t('trace.existingFile')"><option value="">{{ t('trace.existingFile') }}</option><option v-for="f in trace.document.files.filter(f=>f.present)" :key="f.id" :value="f.id">{{ f.path }}</option></select>
              <p v-if="relocationPreview">{{ t('trace.relocationCount',relocationPreview) }}</p>
              <button type="button" class="trace-action" :disabled="!relocationPreview||trace.busy" @click="trace.relocateFile(relocationFrom,relocationTo)">{{ t('trace.applyPlan') }}</button>
            </details>
            <details v-if="trace.document.migrations?.length"><summary class="cursor-pointer">{{ t('trace.migrations') }}</summary><p v-for="m in trace.document.migrations" :key="m">{{ m }}</p></details>
            <details><summary class="cursor-pointer">{{ t('trace.audit') }}</summary><ol class="space-y-1"><li v-for="a in [...(trace.document.audit??[])].reverse().slice(0,100)" :key="a.id">{{ a.at }} · {{ a.actor }} · {{ a.action }} · {{ a.links.length }}</li></ol></details>
          </div>
        </details>
      </template>
      <p v-for="warning in trace.warnings" :key="warning" role="status" class="text-semantic-warning">{{ warning }}</p>
      <p v-if="trace.error" role="alert" class="whitespace-pre-wrap break-words text-semantic-error">{{ trace.error }}</p>
    </div>
  </section>
</template>
<style scoped>
.trace-action { border: 1px solid var(--color-border-subtle, #8885); border-radius: 5px; padding: 4px 8px; }
.trace-action:hover:not(:disabled) { background-color: rgb(100 130 180 / 12%); }
.trace-action:disabled { opacity: .45; cursor: not-allowed; }
.trace-field { display: block; width: 100%; border: 1px solid var(--color-border-subtle, #8885); border-radius: 5px; background: transparent; padding: 5px 8px; }
.trace-workbench button:focus-visible, .trace-field:focus-visible { outline: 2px solid #5689db; outline-offset: 2px; }
</style>
