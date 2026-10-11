import { createDiagnostic, DiagnosticCodes } from '../diagnostics/codes.js'
import type { AspecDiagnostic } from '../model.js'
import {
  applyInformalMeta,
  extractInformalFrontmatter,
  stripInformalIdComments,
  type InformalMeta
} from './format.js'
import { createNodeId } from './ids.js'
import {
  emptyInformalSpecification,
  treeToSpec,
  type InformalParseResult,
  type InformalTreeNode,
  type InformalTreeSection,
  type InformalTreeSpec
} from './model.js'
import {
  DEFAULT_INFORMAL_SECTIONS,
  nodeTypeForLevel,
  sectionDef,
  sectionTypeFromTitle,
  type InformalSectionType
} from './schema.js'

const ID_COMMENT = /<!--\s*@id:([^>]+?)\s*-->/i
const HEADING = /^(#+)\s+(.+?)\s*$/

interface HeadingBlock {
  level: number
  title: string
  id?: string
  body: string
}

function splitBlocks(markdown: string): HeadingBlock[] {
  const lines = markdown.split(/\r?\n/)
  const blocks: HeadingBlock[] = []
  let current: HeadingBlock | null = null
  const bodyLines: string[] = []

  const flush = () => {
    if (!current) return
    const taken = consumeIdFromBody(bodyLines.join('\n'), current.id)
    current.id = taken.id
    current.body = taken.body
    blocks.push(current)
    bodyLines.length = 0
  }

  for (const line of lines) {
    const match = line.match(HEADING)
    if (match) {
      flush()
      const rawTitle = match[2] ?? ''
      const idMatch = rawTitle.match(ID_COMMENT)
      const title = rawTitle.replace(ID_COMMENT, '').trim()
      current = {
        level: match[1]!.length,
        title,
        id: idMatch?.[1]?.trim(),
        body: ''
      }
      continue
    }
    if (current) bodyLines.push(line)
  }
  flush()
  return blocks
}

function consumeIdFromBody(body: string, existingId?: string): { id?: string; body: string } {
  const lines = body.split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start += 1
  const match = lines[start]?.trim().match(/^<!--\s*@id:([^>]+?)\s*-->$/)
  if (!match) return { id: existingId, body: body.trim() }
  const rest = [...lines.slice(0, start), ...lines.slice(start + 1)].join('\n').trim()
  return { id: existingId || match[1]?.trim(), body: rest }
}

export function parseInformalSpec(
  markdown: string,
  options?: { meta?: InformalMeta }
): InformalParseResult {
  const diagnostics: AspecDiagnostic[] = []
  const extracted = extractInformalFrontmatter(markdown)
  const body = extracted.body
  const meta = { ...extracted.meta, ...options?.meta }
  const blocks = splitBlocks(body)
  const used = new Set<string>()
  const sections: InformalTreeSection[] = DEFAULT_INFORMAL_SECTIONS.map((def) => ({
    id: def.id === 'functions' ? 'sec-fn' : def.id === 'data-resources' ? 'sec-dr' : 'sec-c',
    type: def.id,
    title: def.title,
    children: []
  }))
  const sectionByType = new Map(sections.map((s) => [s.type, s]))

  let activeType: InformalSectionType | null = null
  const stack: { level: number; node: InformalTreeNode }[] = []

  for (const block of blocks) {
    if (block.level === 1) {
      const type = sectionTypeFromTitle(block.title)
      if (!type) {
        diagnostics.push(
          createDiagnostic(
            DiagnosticCodes.INFORMAL_UNKNOWN_SECTION,
            `Top-level heading "# ${block.title}" is not allowed. Use Functions, Data Resources, or Constraints.`,
            'error',
            block.title
          )
        )
        activeType = null
        stack.length = 0
        continue
      }
      activeType = type
      stack.length = 0
      const section = sectionByType.get(type)
      if (section && block.id) section.id = block.id
      continue
    }

    if (!activeType) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticCodes.INFORMAL_ORPHAN_HEADING,
          `Heading "${block.title}" appears before a valid top-level section.`,
          'warning',
          block.title
        )
      )
      continue
    }

    const type = nodeTypeForLevel(activeType, block.level)
    const id = block.id && !used.has(block.id) ? block.id : createNodeId(type, block.title, used)
    used.add(id)
    const node: InformalTreeNode = {
      id,
      type,
      title: block.title,
      description: block.body || undefined,
      children: []
    }

    while (stack.length && stack[stack.length - 1]!.level >= block.level) stack.pop()
    if (stack.length === 0) {
      sectionByType.get(activeType)!.children.push(node)
    } else {
      stack[stack.length - 1]!.node.children.push(node)
      node.parentId = stack[stack.length - 1]!.node.id
    }
    stack.push({ level: block.level, node })
  }

  const tree: InformalTreeSpec = {
    id: meta.id || 'spec-local',
    moduleId: meta.moduleId || 'project',
    version: meta.version && Number.isFinite(meta.version) ? meta.version : 1,
    metadata: {
      title: meta.title,
      author: meta.author,
      hybridTarget: meta.hybridTarget,
      guiTarget: meta.guiTarget,
      sourceFormat: 'markdown'
    },
    sections
  }

  const specification = treeToSpec(tree)
  for (const def of DEFAULT_INFORMAL_SECTIONS) {
    if (def.required && !specification.sections.some((s) => s.type === def.id)) {
      specification.sections.push({
        id: sectionDef(def.id).id,
        type: def.id,
        title: def.title,
        children: []
      })
    }
  }
  specification.sections.sort(
    (a, b) => sectionDef(a.type).order - sectionDef(b.type).order
  )

  return {
    specification,
    diagnostics,
    format: 'markdown',
    displaySource: stripInformalIdComments(body)
  }
}

export function parseInformalOrEmpty(
  markdown: string,
  options?: { meta?: InformalMeta }
): InformalParseResult {
  const trimmed = markdown.trim()
  if (!trimmed) {
    const specification = emptyInformalSpecification()
    if (options?.meta) applyInformalMeta(specification, options.meta)
    return {
      specification,
      diagnostics: [],
      format: 'markdown',
      displaySource: markdown
    }
  }
  return parseInformalSpec(markdown, options)
}
