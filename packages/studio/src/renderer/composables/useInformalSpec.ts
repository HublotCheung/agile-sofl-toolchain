import { useTraceabilityStore } from '../stores/traceability'
import { computed, ref, watch, type Ref } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useHistoryStore } from '../stores/history'
import { HistoryKinds } from '../history/kinds'
import { useWorkspaceStore } from '../stores/workspace'
import { applySourceEdits, isSourcePatch } from '../../shared/sourceEdit'
import type { InformalPatchPayload, InformalSpecPayload } from '../../preload/index'

export function nestedNodes(node: InformalSpecPayload['sections'][0]['children'][0]) {
  return (node.metadata?.nested as InformalSpecPayload['sections'][0]['children'] | undefined) ?? []
}

function findTitle(spec: InformalSpecPayload | null, id: string): string | null {
  if (!spec) return null
  for (const section of spec.sections) {
    if (section.id === id) return section.title
    const walk = (nodes: InformalSpecPayload['sections'][0]['children']): string | null => {
      for (const node of nodes) {
        if (node.id === id) return node.title
        const found = walk(nestedNodes(node))
        if (found) return found
      }
      return null
    }
    const found = walk(section.children)
    if (found) return found
  }
  return null
}

export function useInformalSpec(tabId: Ref<string | undefined>) {
  const doc = useDocumentStore()
  const history = useHistoryStore()
  const workspace = useWorkspaceStore()
  const spec = ref<InformalSpecPayload | null>(null)
  const loading = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = ''

  const tab = computed(() => doc.tabs.find((t) => t.id === tabId.value && t.documentKind === 'aspec'))

  async function rebuild(): Promise<void> {
    const current = tab.value
    if (!current || !window.studio?.parseInformalSpec) return
    loading.value = true
    try {
      const parsed = await window.studio.parseInformalSpec(current.content, {
        projectRoot: workspace.activeProject?.rootPath,
        filePath: current.filePath
      })
      spec.value = parsed.specification
      last = current.content
      if (parsed.displaySource && parsed.displaySource !== current.content) {
        last = parsed.displaySource
        doc.setContent(current.id, parsed.displaySource, true)
      }
    } finally {
      loading.value = false
    }
  }

  let sawContent = false
  watch(
    () => tab.value?.content,
    (content) => {
      if (content == null || content === last) return
      if (timer) clearTimeout(timer)
      const delay = sawContent ? 280 : 450
      sawContent = true
      timer = setTimeout(() => void rebuild(), delay)
    },
    { immediate: true }
  )

  watch(tabId, () => void rebuild())

  function applyMarkdown(next: string): void {
    const current = tab.value
    if (!current || next === current.content) return
    history.applyDocument(current.id, next, {
      kind: HistoryKinds.informalEdit,
      immediate: true
    })
    last = next
    void rebuild()
  }

  async function applyPatch(
    patch: InformalPatchPayload
  ): Promise<{
    ok: boolean
    error?: string
    applied?: boolean
    warnings?: string[]
    diagnostics?: { errors: number; warnings: number; items: Array<{ severity: string; code: string; message: string }> }
  }> {
    const current = tab.value
    if (!current) return { ok: false, error: 'Patch service unavailable.' }
    if (isSourcePatch(patch)) {
      const result = applySourceEdits(current.content, patch.operations)
      const applied = result.content !== current.content
      if (applied) {
        history.applyDocument(current.id, result.content, {
          kind: HistoryKinds.informalEdit,
          immediate: true
        })
        last = result.content
        await rebuild()
      }
      if (result.error && !applied) {
        return { ok: true, applied: false, warnings: [result.error] }
      }
      return { ok: true, applied, warnings: result.error ? [result.error] : undefined }
    }
    if (!window.studio?.patchInformalSpec) return { ok: false, error: 'Patch service unavailable.' }
    const result = await window.studio.patchInformalSpec({
      source: current.content,
      patch: JSON.parse(JSON.stringify(patch)) as InformalPatchPayload
    })
    const applied = result.content !== current.content
    if (!result.ok && !applied) {
      return {
        ok: true,
        applied: false,
        warnings: result.warnings ?? (result.error ? [result.error] : ['Patch did not change the document.'])
      }
    }
    if (applied) {
      for (const op of patch.operations) {
        if (op.op === 'update' && typeof op.id === 'string' && typeof op.title === 'string') useTraceabilityStore().hintRename('informal', op.id, op.title)
      }
      history.applyDocument(current.id, result.content, {
        kind: HistoryKinds.informalEdit,
        immediate: true
      })
      last = result.content
      await rebuild()
    }
    const model = applied ? await window.studio.buildInformalModel?.(result.content) : undefined
    const items = (model?.diagnostics ?? [])
      .filter((d) => d.severity === 'error' || d.severity === 'warning')
      .slice(0, 12)
      .map((d) => ({ severity: d.severity, code: d.code, message: d.message }))
    const errors = (model?.diagnostics ?? []).filter((d) => d.severity === 'error').length
    const warningCount = (model?.diagnostics ?? []).filter((d) => d.severity === 'warning').length
    return {
      ok: true,
      applied,
      warnings: result.warnings,
      diagnostics: model ? { errors, warnings: warningCount, items } : undefined
    }
  }

  async function addNode(
    section: 'functions' | 'data-resources' | 'constraints',
    title: string,
    description?: string
  ): Promise<string | null> {
    const type =
      section === 'functions' ? 'function' : section === 'data-resources' ? 'data-resource' : 'constraint'
    const result = await applyPatch({
      operations: [{ op: 'add', target: section, node: { type, title, description } }]
    })
    if (!result.ok) return null
    const created = spec.value?.sections.find((s) => s.type === section)?.children.find((n) => n.title === title)
    if (created) selectNode(created.id)
    return created?.id ?? null
  }

  function revealNode(
    id: string
  ): { start: number; end: number; line: number; column: number; title: string } | null {
    const current = tab.value
    if (!current) return null
    const title = findTitle(spec.value, id)
    if (!title) return null
    const lines = current.content.split(/\r?\n/)
    const headingIdx = lines.findIndex((line) => {
      const heading = line.match(/^#+\s+(.+?)\s*$/)
      if (!heading) return false
      const text = heading[1]!.replace(/<!--\s*@id:[^>]+-->/gi, '').trim()
      return text === title || line.includes(id)
    })
    return {
      start: 0,
      end: 0,
      line: headingIdx >= 0 ? headingIdx + 1 : 0,
      column: 1,
      title
    }
  }

  function selectNode(id: string | null): void {
    workspace.informalSelectedNodeId = id
  }

  return { spec, loading, tab, rebuild, applyMarkdown, applyPatch, addNode, revealNode, selectNode }
}
