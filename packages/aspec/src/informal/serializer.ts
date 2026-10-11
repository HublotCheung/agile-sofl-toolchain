import { specToTree, type InformalSpecification, type InformalTreeNode } from './model.js'
import { sectionDef } from './schema.js'

function emitNode(node: InformalTreeNode, level: number): string {
  const heading = `${'#'.repeat(level)} ${node.title}`
  const parts = [heading]
  if (node.description?.trim()) {
    parts.push('', node.description.trim())
  }
  for (const child of node.children) {
    parts.push('', emitNode(child, level + 1))
  }
  return parts.join('\n')
}

export function serializeInformalSpec(spec: InformalSpecification): string {
  const tree = specToTree(spec)
  const chunks: string[] = []
  const ordered = [...tree.sections].sort(
    (a, b) => sectionDef(a.type).order - sectionDef(b.type).order
  )
  for (const section of ordered) {
    chunks.push(`# ${section.title}`, '')
    for (const child of section.children) {
      chunks.push(emitNode(child, 2), '')
    }
  }
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
