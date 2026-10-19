import { applySourceEdits, isSourcePatch } from '../../shared/sourceEdit'
import { HistoryKinds } from '../history/kinds'
import { useHistoryStore } from '../stores/history'
import { notifyRefinementChanged } from '../composables/useRefinementState'
import { useWorkspaceStore } from '../stores/workspace'
import { fileBelongsToRoot } from '../stores/tabUtils'
import type { InformalPatchPayload } from '../../preload/index'

export async function applyHybridDocumentPatch(
  patch: InformalPatchPayload,
  errors: { noTab: string; applyFailed: string },
  applyWithProvenance?: (before: string, after: string) => Promise<void>
): Promise<{ ok: boolean; error?: string; applied?: boolean; repairNotes?: string[] }> {
  const workspace = useWorkspaceStore()
  const hybridTab = workspace.hybridTab
  const root = workspace.activeProject?.rootPath
  const beforeText = hybridTab?.content ?? ''
  if (!hybridTab) return { ok: false, error: errors.noTab }
  if (root && hybridTab.filePath && !fileBelongsToRoot(hybridTab.filePath, root)) {
    return { ok: false, error: errors.noTab }
  }
  if (isSourcePatch(patch)) {
    const result = applySourceEdits(hybridTab.content, patch.operations)
    return commitHybrid(hybridTab, result.content, result.error, applyWithProvenance, beforeText)
  }
  const stepOp = patch.operations.find((op) => op.op === 'refine-step')
  if (stepOp && root && window.studio?.refinementStep && patch.operations.length === 1) {
    try {
      const result = await window.studio.refinementStep({
        source: hybridTab.content,
        projectRoot: root,
        step: stepOp
      })
      if (result.error && result.source === hybridTab.content) return { ok: false, error: result.error }
      const committed = await commitHybrid(hybridTab, result.source, result.error, applyWithProvenance, beforeText)
      if (committed.ok) notifyRefinementChanged()
      return { ...committed, repairNotes: committed.repairNotes ?? result.repairNotes }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!window.studio?.patchHybridSpec) return { ok: false, error: errors.applyFailed }
  try {
    const result = await window.studio.patchHybridSpec({ source: hybridTab.content, patch })
    return commitHybrid(hybridTab, result.content, result.error, applyWithProvenance, beforeText)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function commitHybrid(
  hybridTab: { id: string; content: string },
  next: string,
  priorError?: string,
  applyWithProvenance?: (before: string, after: string) => Promise<void>,
  expectedBefore = hybridTab.content
): Promise<{ ok: boolean; error?: string; applied?: boolean; repairNotes?: string[] }> {
  if (next === hybridTab.content) {
    if (priorError) return { ok: false, error: priorError, applied: false }
    return { ok: true, applied: false }
  }
  const accept = window.studio?.acceptHybridWrite
  if (!accept) return { ok: false, error: priorError ?? 'Hybrid write gate unavailable', applied: false }
  const gated = await accept({ before: hybridTab.content, after: next })
  if(hybridTab.content!==expectedBefore)return {ok:false,error:'The specification changed while preparing this edit. Generate a new preview.',applied:false}
  if (!gated.ok) {
    return { ok: false, error: [priorError, gated.error].filter(Boolean).join(' '), applied: false }
  }
  const applied = gated.content !== hybridTab.content
  if (applied) {
    if (applyWithProvenance) {
      try { await applyWithProvenance(hybridTab.content, gated.content) }
      catch(e) { return {ok:false,error:e instanceof Error?e.message:String(e),applied:false} }
      return {ok:true,applied:true,repairNotes:gated.repairNotes}
    }
    useHistoryStore().applyDocument(hybridTab.id, gated.content, {
      kind: HistoryKinds.visualPatch,
      immediate: true
    })
    void useWorkspaceStore().resyncModulesFromOpenTabs()
  }
  if (priorError) return { ok: false, error: priorError, applied, repairNotes: gated.repairNotes }
  return { ok: true, applied, repairNotes: gated.repairNotes }
}
