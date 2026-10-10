import { clarificationContinuationText } from '../../../shared/clarificationAnswer'
import type { InformalPatchPayload } from './agentTypes'

export function patchFingerprint(patch: {
  target?: string
  mode?: string
  operations?: Array<Record<string, unknown>>
}): string {
  return JSON.stringify({
    target: patch.target ?? '',
    mode: patch.mode ?? 'crud',
    operations: patch.operations ?? []
  })
}

export function validateAgentPatch(
  target: 'informal' | 'hybrid' | 'gui',
  patch: InformalPatchPayload,
  options?: { mode?: 'crud' | 'source' }
): { ok: boolean; message: string } {
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    return { ok: false, message: 'Patch has no operations.' }
  }
  const mode = options?.mode ?? patch.mode ?? 'crud'
  if (mode === 'source') {
    for (const op of patch.operations) {
      const kind = String(op.op || '')
      if (kind === 'replace-document') {
        if (typeof op.text !== 'string' && typeof op.asflText !== 'string') {
          return { ok: false, message: 'replace-document requires text.' }
        }
        continue
      }
      if (kind === 'append') {
        if (typeof op.text !== 'string' || !String(op.text).length) {
          return { ok: false, message: 'append requires text.' }
        }
        continue
      }
      if (kind === 'replace') {
        if (!String(op.oldText ?? op.from ?? '').length) {
          return { ok: false, message: 'replace requires oldText (a unique snippet from the current source).' }
        }
        continue
      }
      return {
        ok: false,
        message: `Unknown source op "${kind}". Use replace, append, or replace-document.`
      }
    }
    return { ok: true, message: 'ok' }
  }
  if (target === 'gui') {
    const allowed = new Set([
      'add',
      'add-screen',
      'remove',
      'remove-screen',
      'add-widget',
      'replace-html',
      'replace-screen-html',
      'insert-html',
      'patch-node',
      'remove-node'
    ])
    for (const op of patch.operations) {
      const kind = String(op.op || '')
      if (!allowed.has(kind)) {
        return {
          ok: false,
          message: `Unknown GUI op "${kind}". Use add-screen, add-widget, replace-html, replace-screen-html, insert-html.`
        }
      }
    }
    return { ok: true, message: 'ok' }
  }
  for (const op of patch.operations) {
    const kind = String(op.op || '')
    if (kind === 'refine-step') {
      const stepKind = String(op.kind || '')
      if (!stepKind) return { ok: false, message: 'refine-step requires kind.' }
      if (stepKind === 'FormalizePredicate') {
        if (!String(op.fromText ?? '').trim() || op.toText == null || !String(op.toText).trim()) {
          return {
            ok: false,
            message: 'FormalizePredicate requires fromText (the current informal sentence) and toText (legal ASFL).'
          }
        }
      }
      if (stepKind === 'ClassifyGrain') {
        const grain = String(op.grainClass ?? '')
        if (
          !String(op.moduleName ?? '').trim() ||
          !String(op.processName ?? '').trim() ||
          (grain !== 'operation' && grain !== 'abstract')
        ) {
          return {
            ok: false,
            message: 'ClassifyGrain requires moduleName, processName, and grainClass operation|abstract.'
          }
        }
      }
      continue
    }
    if (kind === 'replace-document' || typeof op.asflText === 'string') {
      return {
        ok: false,
        message:
          'replace-document / asflText is not allowed on CRUD. Use add/update/remove, or call propose_source_edit for a source-level fix.'
      }
    }
    const blobs = [op.text, op.fsf, op.pre, op.post, op.comment, op.signature]
    for (const blob of blobs) {
      if (typeof blob !== 'string') continue
      if (/\b(?:module|system)\b[\s\S]{6,}end_module\b/i.test(blob) || /\bend_module\b/i.test(blob)) {
        return {
          ok: false,
          message:
            'Do not put whole modules or end_module in CRUD fields. Add each entity as a separate operation, or call propose_source_edit if you must edit the .asfl text.'
        }
      }
    }
  }
  if (target === 'hybrid') {
    for (const op of patch.operations) {
      const kind = String(op.op || '')
      if (kind === 'add') {
        if (!op.kind) return { ok: false, message: 'Hybrid add requires kind (module, type, var, inv, process, …).' }
        if (op.kind !== 'inv' && !String(op.name ?? '').trim()) {
          return { ok: false, message: 'Hybrid add requires name.' }
        }
      }
      if (
        (kind === 'update' || kind === 'remove' || kind === 'replace-process-body') &&
        !String(op.id ?? '').trim()
      ) {
        return { ok: false, message: `${kind} requires an inventory id.` }
      }
    }
  }
  return { ok: true, message: 'ok' }
}

export type FailedWriteRecord = {
  fingerprint: string
  error: string
  count: number
  mode?: string
}

export function consecutiveWriteFailures(toolContents: string[]): number {
  let n = 0
  for (let i = toolContents.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(toolContents[i] || '{}') as { action?: string; ok?: boolean }
      if (parsed.action === 'error' || parsed.ok === false) n += 1
      else break
    } catch {
      break
    }
  }
  return n
}

export function crudBlockedByFailures(
  lastFailed: FailedWriteRecord | undefined,
  incoming: { fingerprint: string; mode: 'crud' | 'source' }
): string | null {
  if (incoming.mode === 'source') return null
  if (!lastFailed) return null
  if (lastFailed.fingerprint === incoming.fingerprint) {
    return 'This patch already failed. Do not retry it unchanged. Read the error, rewrite the fragment (legal ASFL, a unique fromText) or propose_source_edit, then continue.'
  }
  return null
}

export function nextFailedWrite(
  lastFailed: FailedWriteRecord | undefined,
  incoming: { fingerprint: string; error: string; mode: string }
): FailedWriteRecord {
  const count = lastFailed ? lastFailed.count + 1 : 1
  return {
    fingerprint: incoming.fingerprint,
    error: incoming.error,
    count,
    mode: incoming.mode
  }
}

export function continuationUserText(lastToolContent?: string, failures = 0): string {
  const clarification = clarificationContinuationText(lastToolContent || '')
  if (clarification) return clarification
  let action: string | undefined
  let error: string | undefined
  let instruction: string | undefined
  try {
    const parsed = JSON.parse(lastToolContent || '{}') as { action?: string; error?: string; type?: string; text?: string }
    action = parsed.action
    error = parsed.error
    if (parsed.type === 'user_instruction') instruction = parsed.text || ''
  } catch {
    /* plain clarification answer */
  }
  if (instruction != null) {
    return `The user wrote this while a proposed change was still unconfirmed: ${instruction}. That change was neither applied nor rejected. Interpret their meaning and act now: re-propose the same change if they want it, propose a revision if they want something different, or leave it if they declined. Then continue the task. Do not stop and do not wait.`
  }
  const sourceHint =
    'If CRUD cannot express the fix, call read_* with view=source, then propose_source_edit (replace/append/replace-document). That is allowed.'
  if (action === 'applied') {
    if (error) {
      return `The patch was applied, but some operations failed: ${error}. Immediately call read_specification and/or read_hybrid_specification, fix remaining work with CRUD or ${sourceHint}`
    }
    return 'The patch was applied. Immediately call read_specification and/or read_hybrid_specification and read_refinement_state (if Hybrid changed). Compare with the plan, and either propose the next incremental CRUD/refinement step or write a final summary. If the refinement digest is not unambiguous, invite the next slice with ask_clarification. Do not wait for a new user message.'
  }
  if (action === 'error' || failures >= 2) {
    return `The write failed: ${error || 'unknown error'}. This is a tool result, not a stopped session. Do not retry the same patch unchanged. Rewrite it (legal ASFL, unique fromText) and re-propose, or call read_specification and/or read_hybrid_specification with view=source, then propose_source_edit to unstick (replace a unique snippet, append, or replace-document). Then verify. Do not stop with an empty message.`
  }
  if (action === 'rejected') {
    return 'The user rejected that patch. Adjust: ask_clarification if needed, propose a smaller CRUD patch, or use propose_source_edit if the file itself is stuck. Do not stop with an empty message.'
  }
  return 'Continue now. Prefer propose_changes / propose_hybrid_changes. If those fail, read source and propose_source_edit. After writes, read the spec to verify. When the task is done, write a short summary and stop. Do not reply with an empty message.'
}

export function appliedToolResult(extra?: { error?: string; userNote?: string; repair?: string }): string {
  const notes = [
    extra?.repair ? `Auto-repair kept the write legal: ${extra.repair}.` : '',
    extra?.userNote ? `The user also said: ${extra.userNote}. Follow that after verifying.` : ''
  ].filter(Boolean)
  const next = extra?.error
    ? `Some operations failed: ${extra.error}. Read the inventory (and view=source if needed). Follow up with a corrected CRUD or propose_source_edit. Do not stop.`
    : 'Call read_specification and/or read_hybrid_specification and read_refinement_state (if Hybrid changed) to verify. If syntax errors remain, fix them before the next step. If more work remains, propose the next CRUD or propose_refinement_step (or propose_source_edit if CRUD cannot express it). If Hybrid still has dual-line gaps, ask_clarification for the next slice. If the task is complete, write a short summary and stop.'
  return JSON.stringify({
    action: 'applied',
    ok: !extra?.error,
    error: extra?.error,
    repair: extra?.repair,
    userNote: extra?.userNote,
    next: [next, ...notes].join(' ')
  })
}

export function userInstructionToolResult(text: string): string {
  return JSON.stringify({
    type: 'user_instruction',
    applied: false,
    rejected: false,
    text,
    next: 'The user wrote this while your proposed change was still unconfirmed. It was neither applied nor rejected. Interpret their meaning: re-propose the same change if they want it, propose a revision if they want something else, or drop it if they declined. Then continue the task. Do not stop.'
  })
}

export function rejectedToolResult(): string {
  return JSON.stringify({
    action: 'rejected',
    ok: false,
    next: 'Revise the plan. Ask if needed, propose a smaller CRUD patch, or propose_source_edit if the file is stuck.'
  })
}

export function assistantTurnIsComplete(content: string, toolCallCount: number): boolean {
  return toolCallCount === 0 && content.trim().length > 0
}

export function failedToolResult(error: string, userNote?: string): string {
  return JSON.stringify({
    action: 'error',
    ok: false,
    error,
    userNote: userNote || undefined,
    next: [
      'Tool failed. Do not retry the identical patch. Read the error, rewrite the fragment, and re-propose. If CRUD cannot express the fix, read inventory and view=source, then propose_source_edit. Do not stop the task.',
      userNote ? `The user also said: ${userNote}` : ''
    ]
      .filter(Boolean)
      .join(' ')
  })
}
