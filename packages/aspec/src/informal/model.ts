import type { InformalNodeType, InformalSectionType } from './schema.js'
import type { AspecDiagnostic } from '../model.js'

export interface SpecificationMetadata {
  title?: string
  author?: string
  hybridTarget?: string
  guiTarget?: string
  sourceFormat?: 'markdown' | 'yaml'
}

export interface InformalNode {
  id: string
  type: InformalNodeType
  title: string
  description?: string
  parentId?: string
  children: string[]
  metadata?: Record<string, unknown>
}

export interface InformalSection {
  id: string
  type: InformalSectionType
  title: string
  children: InformalNode[]
}

export interface InformalSpecification {
  id: string
  moduleId: string
  sections: InformalSection[]
  version: number
  metadata: SpecificationMetadata
}

export interface InformalParseResult {
  specification: InformalSpecification | null
  diagnostics: AspecDiagnostic[]
  format: 'markdown' | 'yaml'
  displaySource?: string
}

export type InformalPatchOp =
  | {
      op: 'add'
      target: InformalSectionType | string
      node: Omit<InformalNode, 'id' | 'children'> & { id?: string; children?: InformalNode[] }
      afterId?: string
    }
  | {
      op: 'update'
      id: string
      title?: string
      description?: string
      metadata?: Record<string, unknown>
    }
  | {
      op: 'remove'
      id: string
    }
  | {
      op: 'move'
      id: string
      parentId: string | InformalSectionType
      afterId?: string
      beforeId?: string
    }

export interface InformalPatch {
  operations: InformalPatchOp[]
  explanation?: string
}

export interface InformalAuditEntry {
  who: 'AI' | 'User'
  what: 'add' | 'modify' | 'delete' | 'move'
  where: string
  when: string
  why?: string
}

export function emptyInformalSpecification(partial?: Partial<InformalSpecification>): InformalSpecification {
  return {
    id: partial?.id ?? 'spec-new',
    moduleId: partial?.moduleId ?? 'project',
    version: partial?.version ?? 1,
    metadata: {
      title: 'Informal Specification',
      sourceFormat: 'markdown',
      ...partial?.metadata
    },
    sections: partial?.sections ?? [
      { id: 'sec-fn', type: 'functions', title: 'Functions', children: [] },
      { id: 'sec-dr', type: 'data-resources', title: 'Data Resources', children: [] },
      { id: 'sec-c', type: 'constraints', title: 'Constraints', children: [] }
    ]
  }
}

export function flattenNodes(spec: InformalSpecification): InformalNode[] {
  const out: InformalNode[] = []
  const walk = (nodes: InformalNode[]) => {
    for (const node of nodes) {
      out.push(node)
      if (node.children.length) {
        const childNodes = lookupChildren(spec, node)
        walk(childNodes)
      }
    }
  }
  for (const section of spec.sections) walk(section.children)
  return out
}

export function lookupChildren(spec: InformalSpecification, parent: InformalNode): InformalNode[] {
  const index = indexNodes(spec)
  return parent.children.map((id) => index.get(id)).filter((n): n is InformalNode => Boolean(n))
}

export function indexNodes(spec: InformalSpecification): Map<string, InformalNode> {
  const map = new Map<string, InformalNode>()
  const walk = (nodes: InformalNode[]) => {
    for (const node of nodes) {
      map.set(node.id, node)
      walk(collectNested(node))
    }
  }
  for (const section of spec.sections) walk(section.children)
  return map
}

function collectNested(node: InformalNode): InformalNode[] {
  const nested = node.metadata?.nested as InformalNode[] | undefined
  return nested ?? []
}

export function collectAllNodes(nodes: InformalNode[]): InformalNode[] {
  const out: InformalNode[] = []
  const walk = (list: InformalNode[]) => {
    for (const n of list) {
      out.push(n)
      walk(n.metadata?.nested as InformalNode[] ?? [])
    }
  }
  walk(nodes)
  return out
}

/** Nested tree used by parser/serializer: children live on the node, not a flat id list. */
export interface InformalTreeNode extends Omit<InformalNode, 'children'> {
  children: InformalTreeNode[]
}

export interface InformalTreeSection {
  id: string
  type: InformalSectionType
  title: string
  children: InformalTreeNode[]
}

export interface InformalTreeSpec {
  id: string
  moduleId: string
  version: number
  metadata: SpecificationMetadata
  sections: InformalTreeSection[]
}

export function treeToSpec(tree: InformalTreeSpec): InformalSpecification {
  const sections: InformalSection[] = tree.sections.map((section) => ({
    id: section.id,
    type: section.type,
    title: section.title,
    children: section.children.map((child) => treeNodeToFlat(child, undefined))
  }))
  relink(sections)
  return {
    id: tree.id,
    moduleId: tree.moduleId,
    version: tree.version,
    metadata: tree.metadata,
    sections
  }
}

function treeNodeToFlat(node: InformalTreeNode, parentId: string | undefined): InformalNode {
  const children = node.children.map((c) => treeNodeToFlat(c, node.id))
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    description: node.description,
    parentId,
    children: children.map((c) => c.id),
    metadata: {
      ...node.metadata,
      nested: children
    }
  }
}

function relink(sections: InformalSection[]): void {
  for (const section of sections) {
    const walk = (nodes: InformalNode[], parentId: string | undefined) => {
      for (const node of nodes) {
        node.parentId = parentId
        const nested = (node.metadata?.nested as InformalNode[] | undefined) ?? []
        node.children = nested.map((c) => c.id)
        walk(nested, node.id)
      }
    }
    walk(section.children, undefined)
  }
}

export function specToTree(spec: InformalSpecification): InformalTreeSpec {
  const fromFlat = (node: InformalNode): InformalTreeNode => {
    const nested = (node.metadata?.nested as InformalNode[] | undefined) ?? []
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      description: node.description,
      parentId: node.parentId,
      metadata: omitNested(node.metadata),
      children: nested.map(fromFlat)
    }
  }
  return {
    id: spec.id,
    moduleId: spec.moduleId,
    version: spec.version,
    metadata: spec.metadata,
    sections: spec.sections.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      children: s.children.map(fromFlat)
    }))
  }
}

function omitNested(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const { nested: _nested, ...rest } = meta
  return Object.keys(rest).length ? rest : undefined
}

export function walkTree(
  spec: InformalSpecification,
  visit: (node: InformalNode, section: InformalSection, depth: number) => void
): void {
  const walk = (nodes: InformalNode[], section: InformalSection, depth: number) => {
    for (const node of nodes) {
      visit(node, section, depth)
      const nested = (node.metadata?.nested as InformalNode[] | undefined) ?? []
      walk(nested, section, depth + 1)
    }
  }
  for (const section of spec.sections) walk(section.children, section, 1)
}

export function findNode(spec: InformalSpecification, id: string): InformalNode | undefined {
  let found: InformalNode | undefined
  walkTree(spec, (node) => {
    if (node.id === id) found = node
  })
  return found
}

export function cloneSpec<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
