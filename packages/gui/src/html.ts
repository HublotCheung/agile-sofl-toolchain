import {
  ALLOWED_ATTRS,
  LOGIC_EVENT_ATTRS,
  VOID_TAGS,
  escapeAttr,
  escapeText,
  isAllowedClass,
  isAllowedTag
} from './dialect.js'

export interface HtmlNode {
  type: 'element' | 'text'
  tag?: string
  attrs: Record<string, string>
  children: HtmlNode[]
  text?: string
}

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*)\/?>|([^<]+)/g
const ATTR_RE = /([:@a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  raw.replace(ATTR_RE, (_m, name: string, dq?: string, sq?: string, bare?: string) => {
    const key = String(name).toLowerCase()
    if (LOGIC_EVENT_ATTRS.has(key)) {
      const handler = decodeEntities(dq ?? sq ?? bare ?? '')
      if (handler && !/javascript\s*:/i.test(handler)) attrs[key] = handler
      return ''
    }
    if (key.startsWith('on') || key === 'style' || key === 'src' || key === 'href') return ''
    if (!ALLOWED_ATTRS.has(key)) return ''
    const value = decodeEntities(dq ?? sq ?? bare ?? '')
    if (key === 'class') {
      const kept = value
        .split(/\s+/)
        .map((c) => c.trim())
        .filter((c) => c && isAllowedClass(c))
      if (kept.length) attrs.class = kept.join(' ')
      return ''
    }
    attrs[key] = value
    return ''
  })
  return attrs
}

function liftLogicScripts(source: string): { html: string; scripts: string[] } {
  const scripts: string[] = []
  const lifted = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_full, attrs: string, body: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return ''
    const code = String(body).replace(/^\n/, '').replace(/\s+$/, '')
    if (!code.trim()) return ''
    const index = scripts.length
    scripts.push(code)
    return `<script data-as-slot="${index}"></script>`
  })
  return { html: stripUnclosedScript(lifted), scripts }
}

function stripUnclosedScript(source: string): string {
  const re = /<script\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    const rest = source.slice(match.index + match[0].length)
    if (!/<\/script>/i.test(rest)) return source.slice(0, match.index)
  }
  return source
}

function unwrapFence(source: string): string {
  const fenced = /^```(?:html)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(source.trim())
  return fenced?.[1] ?? source
}

export function parseHtmlFragment(source: string): HtmlNode {
  const root: HtmlNode = { type: 'element', tag: '#root', attrs: {}, children: [] }
  const stack: HtmlNode[] = [root]
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  const lifted = liftLogicScripts(unwrapFence(source))
  const text = lifted.html.replace(/<style[\s\S]*?<\/style>/gi, '')
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*)\/?>|([^<]+)/g
  while ((match = re.exec(text))) {
    if (match[0].startsWith('<!--')) continue
    if (match[3] != null) {
      const value = match[3].replace(/\s+/g, ' ')
      if (!value.trim()) continue
      stack[stack.length - 1]!.children.push({ type: 'text', attrs: {}, children: [], text: decodeEntities(value) })
      continue
    }
    const tag = match[1]!.toLowerCase()
    const closing = match[0].startsWith('</')
    const selfClosing = VOID_TAGS.has(tag) || /\/\s*>$/.test(match[0])
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    if (!isAllowedTag(tag)) continue
    if (tag === 'script') {
      const slot = /data-as-slot\s*=\s*"(\d+)"/.exec(match[2] ?? '')
      const code = slot ? lifted.scripts[Number(slot[1])] ?? '' : ''
      if (code.trim()) {
        stack[stack.length - 1]!.children.push({
          type: 'element',
          tag: 'script',
          attrs: { type: 'text/as-logic' },
          children: [{ type: 'text', attrs: {}, children: [], text: code }]
        })
      }
      continue
    }
    const node: HtmlNode = { type: 'element', tag, attrs: parseAttrs(match[2] ?? ''), children: [] }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node)
  }
  return root
}

export function serializeHtml(node: HtmlNode, indent = 0): string {
  if (node.type === 'text') return escapeText(node.text ?? '')
  const pad = '  '.repeat(indent)
  if (node.tag === 'script') {
    const body = node.children.map((child) => child.text ?? '').join('')
    const safe = body.replace(/<\/script/gi, '<\\/script')
    return `${pad}<script type="text/as-logic">${safe}</script>`
  }
  if (node.tag === '#root') {
    return node.children
      .map((child) => serializeHtml(child, indent))
      .filter((s) => s.trim().length > 0)
      .join('\n') + (node.children.length ? '\n' : '')
  }
  const attrText = Object.entries(node.attrs)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => (v === '' || v === k ? k : `${k}="${escapeAttr(v)}"`))
    .join(' ')
  const open = attrText ? `<${node.tag} ${attrText}>` : `<${node.tag}>`
  if (VOID_TAGS.has(node.tag!)) return `${pad}${open.replace(/>$/, ' />')}`
  const onlyText =
    node.children.length === 1 && node.children[0]!.type === 'text' && !(node.children[0]!.text ?? '').includes('\n')
  if (!node.children.length) return `${pad}${open}</${node.tag}>`
  if (onlyText) return `${pad}${open}${serializeHtml(node.children[0]!)}</${node.tag}>`
  const inner = node.children.map((c) => serializeHtml(c, indent + 1)).join('\n')
  return `${pad}${open}\n${inner}\n${pad}</${node.tag}>`
}

export function walkHtml(node: HtmlNode, visit: (n: HtmlNode, parent: HtmlNode | null) => void, parent: HtmlNode | null = null): void {
  visit(node, parent)
  for (const child of node.children) walkHtml(child, visit, node)
}

export function findElements(node: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = []
  walkHtml(node, (n) => {
    if (n.type === 'element' && n.tag !== '#root' && pred(n)) out.push(n)
  })
  return out
}

export function innerText(node: HtmlNode): string {
  if (node.type === 'text') return node.text ?? ''
  return node.children.map(innerText).join('').replace(/\s+/g, ' ').trim()
}

export function cloneNode(node: HtmlNode): HtmlNode {
  return {
    type: node.type,
    tag: node.tag,
    attrs: { ...node.attrs },
    text: node.text,
    children: node.children.map(cloneNode)
  }
}

export function sanitizeHtml(source: string): string {
  return serializeHtml(parseHtmlFragment(source)).trim() + '\n'
}

export type HtmlTreeItem = {
  path: string
  tag: string
  id?: string
  label: string
  classes: string[]
  attrs: Record<string, string>
  text?: string
  children: HtmlTreeItem[]
}

export function elementChildren(node: HtmlNode): HtmlNode[] {
  return node.children.filter((c) => c.type === 'element')
}

export function nodeAtPath(root: HtmlNode, path: string): HtmlNode | undefined {
  if (!path) return root
  let cur = root
  for (const part of path.split('.')) {
    const i = Number(part)
    if (!Number.isInteger(i) || i < 0) return undefined
    const next = elementChildren(cur)[i]
    if (!next) return undefined
    cur = next
  }
  return cur
}

export function parentPathOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(0, i)
}

function toTreeItem(node: HtmlNode, path: string): HtmlTreeItem {
  const textChild =
    node.children.length === 1 && node.children[0]!.type === 'text' ? node.children[0]!.text : undefined
  const label =
    node.attrs['data-screen'] ||
    node.attrs['data-process'] ||
    node.attrs.id ||
    innerText(node).slice(0, 32) ||
    node.tag ||
    'node'
  return {
    path,
    tag: node.tag || 'div',
    id: node.attrs.id,
    label,
    classes: (node.attrs.class ?? '').split(/\s+/).filter(Boolean),
    attrs: { ...node.attrs },
    text: textChild,
    children: elementChildren(node).map((c, i) => toTreeItem(c, `${path}.${i}`))
  }
}

export function listHtmlTree(source: string): HtmlTreeItem[] {
  const root = parseHtmlFragment(source)
  return elementChildren(root).map((n, i) => toTreeItem(n, String(i)))
}

export function findTreeItem(items: HtmlTreeItem[], path: string): HtmlTreeItem | undefined {
  for (const item of items) {
    if (item.path === path) return item
    const nested = findTreeItem(item.children, path)
    if (nested) return nested
  }
  return undefined
}
