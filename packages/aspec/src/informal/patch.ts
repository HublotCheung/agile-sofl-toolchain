import { createNodeId } from './ids.js'
import {
  cloneSpec,
  findNode,
  flattenNodes,
  type InformalNode,
  type InformalPatch,
  type InformalPatchOp,
  type InformalSection,
  type InformalSpecification
} from './model.js'
import {
  normalizeInformalNodeType,
  resolveSectionRef,
  sectionTypeForNodeType,
  type InformalNodeType,
  type InformalSectionType
} from './schema.js'
import { parseInformalSpec } from './parser.js'
import { serializeInformalSpec } from './serializer.js'
import { validateInformalSpec } from './validator.js'
import { detectAspecFormat } from './format.js'
import { parseAspec } from '../parse.js'
import { aspecToInformal } from './bridge.js'
import type { AspecDiagnostic } from '../model.js'

function resolveNodeRef(spec: InformalSpecification, id: string): InformalNode | undefined {
  const exact = findNode(spec, id)
  if (exact) return exact
  const matches = flattenNodes(spec).filter((n) => n.title === id || n.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

function normalizePatch(patch: InformalPatch): InformalPatch {
  return {
    ...patch,
    operations: patch.operations.map((op) => {
      if (op.op === 'add') {
        const extra = op as {
          op: 'add'
          target?: string
          afterId?: string
          title?: string
          description?: string
          type?: string
          node?: {
            type?: InformalNodeType
            title?: string
            description?: string
            id?: string
            children?: InformalNode[]
            metadata?: Record<string, unknown>
          }
        }
        const incoming = extra.node ?? {
          type: extra.type as InformalNodeType | undefined,
          title: extra.title,
          description: extra.description
        }
        const nodeType = normalizeInformalNodeType(incoming.type, sectionTypeFromFallback(extra.target))
        const target = resolveSectionRef(extra.target) ?? sectionTypeForNodeType(nodeType)
        const title = String(incoming.title ?? extra.title ?? '').trim() || 'Untitled'
        return {
          op: 'add' as const,
          target,
          afterId: extra.afterId,
          node: {
            ...incoming,
            type: nodeType,
            title,
            description: incoming.description ?? extra.description
          }
        }
      }
      if (op.op === 'move') {
        return {
          ...op,
          parentId: resolveSectionRef(String(op.parentId)) ?? op.parentId
        }
      }
      return op
    })
  }
}

function sectionTypeFromFallback(target?: string): InformalNodeType {
  const section = resolveSectionRef(target)
  if (section === 'data-resources') return 'data-resource'
  if (section === 'constraints') return 'constraint'
  return 'function'
}

function usedIds(spec: InformalSpecification): Set<string> {
  const used = new Set<string>([spec.id])
  const walk = (nodes: InformalNode[]) => {
    for (const node of nodes) {
      used.add(node.id)
      walk((node.metadata?.nested as InformalNode[] | undefined) ?? [])
    }
  }
  for (const section of spec.sections) walk(section.children)
  return used
}

function nestedOf(node: InformalNode): InformalNode[] {
  if (!node.metadata) node.metadata = {}
  if (!Array.isArray(node.metadata.nested)) node.metadata.nested = []
  return node.metadata.nested as InformalNode[]
}

function readNested(node: { metadata?: Record<string, unknown>; children?: unknown }): InformalNode[] {
  const meta = node.metadata?.nested
  if (Array.isArray(meta) && meta.some(isNodeLike)) return meta.filter(isNodeLike)
  const raw = node.children
  if (Array.isArray(raw) && raw.some(isNodeLike)) return raw.filter(isNodeLike)
  return []
}

function isNodeLike(value: unknown): value is InformalNode {
  return Boolean(value) && typeof value === 'object' && typeof (value as InformalNode).title === 'string'
}

function containsNode(node: InformalNode, id: string): boolean {
  if (node.id === id) return true
  return readNested(node).some((child) => containsNode(child, id))
}

function sectionOf(spec: InformalSpecification, target: InformalSectionType | string): InformalSection | undefined {
  return (
    spec.sections.find((s) => s.type === target) ??
    spec.sections.find((s) => s.id === target)
  )
}

function removeNode(spec: InformalSpecification, id: string): InformalNode | undefined {
  let removed: InformalNode | undefined
  const strip = (list: InformalNode[]): InformalNode[] => {
    const next: InformalNode[] = []
    for (const node of list) {
      if (node.id === id) {
        removed = node
        continue
      }
      const nested = nestedOf(node)
      node.metadata = { ...node.metadata, nested: strip(nested) }
      node.children = (node.metadata.nested as InformalNode[]).map((c) => c.id)
      next.push(node)
    }
    return next
  }
  for (const section of spec.sections) {
    section.children = strip(section.children)
  }
  return removed
}

function insertNode(
  spec: InformalSpecification,
  parentId: string | InformalSectionType,
  node: InformalNode,
  afterId?: string,
  beforeId?: string
): boolean {
  const resolvedParent = resolveSectionRef(String(parentId)) ?? parentId
  const section = sectionOf(spec, resolvedParent)
  if (section && (resolvedParent === section.type || resolvedParent === section.id)) {
    insertInto(section.children, node, afterId, beforeId)
    node.parentId = undefined
    return true
  }
  const parent = resolveNodeRef(spec, String(resolvedParent))
  if (!parent) return false
  const nested = nestedOf(parent)
  insertInto(nested, node, afterId, beforeId)
  parent.metadata = { ...parent.metadata, nested }
  parent.children = nested.map((c) => c.id)
  node.parentId = parent.id
  return true
}

function insertInto(list: InformalNode[], node: InformalNode, afterId?: string, beforeId?: string): void {
  if (beforeId) {
    const beforeIdx = list.findIndex((n) => n.id === beforeId)
    if (beforeIdx >= 0) {
      list.splice(beforeIdx, 0, node)
      return
    }
  }
  if (!afterId) {
    list.push(node)
    return
  }
  const idx = list.findIndex((n) => n.id === afterId)
  if (idx < 0) list.push(node)
  else list.splice(idx + 1, 0, node)
}

function hydrateIncoming(
  raw: InformalPatchOp & { op: 'add' },
  used: Set<string>
): InformalNode {
  const incoming = raw.node
  const type = normalizeInformalNodeType(incoming?.type, sectionTypeFromFallback(raw.target))
  const title = String(incoming?.title ?? '').trim() || 'Untitled'
  const id = incoming?.id && !used.has(incoming.id) ? incoming.id : createNodeId(type, title, used)
  used.add(id)
  const children = readNested(incoming ?? {})
  const nested = children.map((child) =>
    hydrateIncoming(
      {
        op: 'add',
        target: id,
        node: { ...child, children: readNested(child) }
      },
      used
    )
  )
  return {
    id,
    type,
    title,
    description: incoming?.description,
    children: nested.map((c) => c.id),
    metadata: { ...incoming?.metadata, nested }
  }
}

export function applyInformalPatch(
  spec: InformalSpecification,
  patch: InformalPatch
): { spec: InformalSpecification; diagnostics: AspecDiagnostic[] } {
  const next = cloneSpec(spec)
  const diagnostics: AspecDiagnostic[] = []
  const used = usedIds(next)
  const ops = normalizePatch(patch).operations

  for (const op of ops) {
    if (op.op === 'add') {
      const node = hydrateIncoming(op, used)
      const ok = insertNode(next, op.target, node, op.afterId)
      if (!ok) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot add node: unknown target "${op.target}".`,
          severity: 'error',
          path: String(op.target)
        })
      }
    } else if (op.op === 'update') {
      const node = resolveNodeRef(next, op.id)
      if (!node) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot update unknown node "${op.id}".`,
          severity: 'error',
          path: op.id
        })
        continue
      }
      if (op.title !== undefined) node.title = op.title
      if (op.description !== undefined) node.description = op.description
      if (op.metadata) node.metadata = { ...node.metadata, ...op.metadata }
    } else if (op.op === 'remove') {
      const target = resolveNodeRef(next, op.id)
      const removed = target ? removeNode(next, target.id) : undefined
      if (!removed) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot remove unknown node "${op.id}".`,
          severity: 'error',
          path: op.id
        })
      }
    } else if (op.op === 'move') {
      const target = resolveNodeRef(next, op.id)
      if (!target) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot move unknown node "${op.id}".`,
          severity: 'error',
          path: op.id
        })
        continue
      }
      const parentKey = resolveSectionRef(String(op.parentId)) ?? op.parentId
      const parentNode = resolveNodeRef(next, String(parentKey))
      if (parentNode && containsNode(target, parentNode.id)) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot move "${op.id}" under itself.`,
          severity: 'error',
          path: op.id
        })
        continue
      }
      const moved = removeNode(next, target.id)
      if (!moved) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot move unknown node "${op.id}".`,
          severity: 'error',
          path: op.id
        })
        continue
      }
      const ok = insertNode(next, op.parentId, moved, op.afterId, op.beforeId)
      if (!ok) {
        diagnostics.push({
          code: 'ASPEC_PATCH_001',
          message: `Cannot move node to unknown parent "${op.parentId}".`,
          severity: 'error',
          path: String(op.parentId)
        })
      }
    }
  }

  diagnostics.push(...validateInformalSpec(next))
  return { spec: next, diagnostics }
}

export function applyInformalSourcePatch(
  source: string,
  patch: InformalPatch
): { content: string; ok: boolean; error?: string } {
  let spec
  if (detectAspecFormat(source) === 'yaml') {
    const { document } = parseAspec(source)
    if (!document) return { content: source, ok: false, error: 'Informal specification could not be parsed.' }
    spec = aspecToInformal(document)
  } else {
    const parsed = parseInformalSpec(source)
    if (!parsed.specification) {
      return { content: source, ok: false, error: 'Informal specification could not be parsed.' }
    }
    spec = parsed.specification
  }
  const { spec: next, diagnostics } = applyInformalPatch(spec, patch)
  const patchError = diagnostics.find((d) => d.severity === 'error' && d.code === 'ASPEC_PATCH_001')
  if (patchError) {
    return { content: source, ok: false, error: patchError.message }
  }
  return { content: serializeInformalSpec(next), ok: true }
}

export function patchInformalSource(source: string, patch: InformalPatch): string {
  return applyInformalSourcePatch(source, patch).content
}
