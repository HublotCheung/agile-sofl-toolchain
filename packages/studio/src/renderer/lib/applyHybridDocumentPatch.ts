import { applySourceEdits, isSourcePatch } from '../../shared/sourceEdit'
import { HistoryKinds } from '../history/kinds'
import { useHistoryStore } from '../stores/history'
import { notifyRefinementChanged } from '../composables/useRefinementState'
import { useWorkspaceStore } from '../stores/workspace'
import { fileBelongsToRoot } from '../stores/tabUtils'
import type { InformalPatchPayload } from '../../preload/index'
import type { WriteDiagnostics } from '../../shared/asflRepair'

export type HybridApplyResult = {
  ok: boolean
  error?: string
  applied?: boolean
  repairNotes?: string[]
  warnings?: string[]
  diagnostics?: WriteDiagnostics
}

export async function applyHybridDocumentPatch(
  patch: InformalPatchPayload,
  errors: { noTab: string; applyFailed: string },
  applyWithProvenance?: (before: string, after: string) => Promise<{ warnings?: string[] } | void>
): Promise<HybridApplyResult> {
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
    const soft = result.error ? [result.error] : undefined
    return commitHybrid(hybridTab, result.content, undefined, applyWithProvenance, beforeText, soft)
  }
  const stepOp = patch.operations.find((op) => op.op === 'refine-step')
  if (stepOp && root && window.studio?.refinementStep && patch.operations.length === 1) {
    try {
      const result = await window.studio.refinementStep({
        source: hybridTab.content,
        projectRoot: root,
        step: stepOp
      })
      if (result.error && result.source === hybridTab.content) {
        return {
          ok: true,
          applied: false,
          warnings: result.warnings ?? [result.error]
        }
      }
      const committed = await commitHybrid(
        hybridTab,
        result.source,
        undefined,
        applyWithProvenance,
        beforeText,
        result.warnings ?? (result.error ? [result.error] : undefined)
      )
      if (committed.ok) notifyRefinementChanged()
      return { ...committed, repairNotes: committed.repairNotes ?? result.repairNotes }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!window.studio?.patchHybridSpec) return { ok: false, error: errors.applyFailed }
  try {
    const result = await window.studio.patchHybridSpec({ source: hybridTab.content, patch })
    const changed = result.content !== hybridTab.content
    const soft = [...(result.warnings ?? [])]
    if (result.error && !soft.includes(result.error)) soft.unshift(result.error)
    const hard = changed ? undefined : undefined
    return commitHybrid(hybridTab, result.content, hard, applyWithProvenance, beforeText, soft)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function commitHybrid(
  hybridTab: { id: string; content: string },
  next: string,
  priorError?: string,
  applyWithProvenance?: (before: string, after: string) => Promise<{ warnings?: string[] } | void>,
  expectedBefore = hybridTab.content,
  softWarnings?: string[]
): Promise<HybridApplyResult> {
  if (next === hybridTab.content) {
    const warnings = [...(softWarnings ?? []), ...(priorError ? [priorError] : [])].filter(Boolean)
    return { ok: true, applied: false, warnings: warnings.length ? warnings : undefined, error: priorError }
  }
  const accept = window.studio?.acceptHybridWrite
  if (!accept) return { ok: false, error: priorError ?? 'Hybrid write gate unavailable', applied: false }
  const gated = await accept({ before: hybridTab.content, after: next })
  if (hybridTab.content !== expectedBefore) {
    return { ok: false, error: 'The specification changed while preparing this edit. Generate a new preview.', applied: false }
  }
  const warnings = [...(softWarnings ?? []), ...(gated.warnings ?? [])].filter(Boolean)
  const applied = gated.content !== hybridTab.content
  if (applied) {
    if (applyWithProvenance) {
      try {
        const traced = await applyWithProvenance(hybridTab.content, gated.content)
        if (traced?.warnings?.length) warnings.push(...traced.warnings)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (/changed|preview|unavailable/i.test(message)) {
          return { ok: false, error: message, applied: false }
        }
        warnings.push(message)
      }
      return {
        ok: true,
        applied: true,
        repairNotes: gated.repairNotes,
        warnings: warnings.length ? warnings : undefined,
        diagnostics: gated.diagnostics
      }
    }
    useHistoryStore().applyDocument(hybridTab.id, gated.content, {
      kind: HistoryKinds.visualPatch,
      immediate: true
    })
    void useWorkspaceStore().resyncModulesFromOpenTabs()
  }
  return {
    ok: true,
    applied,
    repairNotes: gated.repairNotes,
    warnings: warnings.length ? warnings : undefined,
    diagnostics: gated.diagnostics
  }
}
