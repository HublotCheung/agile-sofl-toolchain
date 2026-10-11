import { nestedNodes } from '../composables/useInformalSpec'
import type { InformalNodePayload, InformalSpecPayload } from '../../preload/index'

export type InformalSectionType = 'functions' | 'data-resources' | 'constraints'

export type LocatedInformalNode = {
  node: InformalNodePayload
  section: InformalSectionType
  /** Section type for a root item, otherwise the parent node id. */
  parentId: string
}

export function locateInformalNode(
  spec: InformalSpecPayload | null | undefined,
  id: string
): LocatedInformalNode | null {
  if (!spec) return null
  const walk = (
    nodes: InformalNodePayload[],
    section: InformalSectionType,
    parentId: string
  ): LocatedInformalNode | null => {
    for (const node of nodes) {
      if (node.id === id) return { node, section, parentId }
      const found = walk(nestedNodes(node), section, node.id)
      if (found) return found
    }
    return null
  }
  for (const section of spec.sections) {
    const found = walk(section.children, section.type, section.type)
    if (found) return found
  }
  return null
}

export function childNodeType(
  section: InformalSectionType,
  nested: boolean
): InformalNodePayload['type'] {
  if (section === 'functions') return 'function'
  if (section === 'constraints') return 'constraint'
  return nested ? 'data-field' : 'data-resource'
}

/** Patch payload that keeps the whole subtree, with a new title on the root. */
export function subtreePatchNode(node: InformalNodePayload, title?: string) {
  return {
    type: node.type,
    title: title ?? node.title,
    description: node.description,
    children: nestedNodes(node).map((child) => subtreePatchNode(child))
  }
}
