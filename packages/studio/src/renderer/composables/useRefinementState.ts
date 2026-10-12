import { computed, onUnmounted, shallowRef, watch, type Ref } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useWorkspaceStore } from '../stores/workspace'
import { emptyRefinementState, type RefinementStateDto } from '../lib/refinementTypes'

/** Bumped when the audit log changes even if Hybrid source text is unchanged. */
const revision = shallowRef(0)
const state = shallowRef<RefinementStateDto | null>(null)

let listeners = 0
let stopWatch: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let requestGen = 0

const REFINE_IDLE_MS = 600

export function notifyRefinementChanged(): void {
  revision.value += 1
}

function scheduleRefresh(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (useDocumentStore().hasPendingEdit()) {
      scheduleRefresh()
      return
    }
    void refresh()
  }, REFINE_IDLE_MS)
}

async function refresh(): Promise<void> {
  const ticket = ++requestGen
  const workspace = useWorkspaceStore()
  const source = workspace.hybridTab?.content
  const root = workspace.activeProject?.rootPath
  const sourceAtRequest = source
  if (!source || !root || !window.studio?.refinementState) {
    if (ticket === requestGen) state.value = null
    return
  }
  try {
    const next = (await window.studio.refinementState({
      source,
      projectRoot: root
    })) as RefinementStateDto
    if (ticket !== requestGen) return
    if (useWorkspaceStore().hybridTab?.content !== sourceAtRequest) return
    if (useDocumentStore().hasPendingEdit()) {
      scheduleRefresh()
      return
    }
    state.value = {
      ...emptyRefinementState(),
      ...next,
      processes: Array.isArray(next.processes)
        ? next.processes.map((p) => ({
            ...p,
            isStub: p.isStub ?? false,
            effectPattern: p.effectPattern ?? 'opaque',
            grainClass: p.grainClass ?? 'unclassified',
            nameEffectMismatch: p.nameEffectMismatch ?? false,
            variations: p.variations ?? [],
            grainClosed: p.grainClosed ?? false,
            operationallyAtomic: p.operationallyAtomic ?? false
          }))
        : [],
      grainAmbiguity: next.grainAmbiguity ?? 0,
      unloggedGrainClosures: next.unloggedGrainClosures ?? 0,
      modules: Array.isArray(next.modules) ? next.modules.map((m) => ({ isEmpty: false, ...m })) : [],
      dataItems: Array.isArray(next.dataItems) ? next.dataItems : [],
      log: Array.isArray(next.log) ? next.log : [],
      breakdown: { ...emptyRefinementState().breakdown, ...next.breakdown }
    }
  } catch {
    if (ticket === requestGen && useWorkspaceStore().hybridTab?.content === sourceAtRequest) {
      state.value = null
    }
  }
}

function retain(): void {
  listeners++
  if (stopWatch) return
  const workspace = useWorkspaceStore()
  stopWatch = watch(
    () => [workspace.hybridTab?.content, workspace.activeProject?.rootPath, revision.value] as const,
    () => scheduleRefresh(),
    { immediate: true }
  )
}

function release(): void {
  listeners = Math.max(0, listeners - 1)
  if (listeners > 0) return
  stopWatch?.()
  stopWatch = null
  if (timer) clearTimeout(timer)
  timer = null
  requestGen++
}

export function useRefinementState(enabled?: Ref<boolean>) {
  const isOn = enabled ?? computed(() => true)
  let held = false

  function sync(on: boolean): void {
    if (on && !held) {
      held = true
      retain()
    } else if (!on && held) {
      held = false
      release()
    }
  }

  watch(isOn, (on) => sync(on), { immediate: true })
  onUnmounted(() => sync(false))

  return { state }
}
