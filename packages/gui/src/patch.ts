import { parse as parseYaml, stringify } from 'yaml'
import type { GuiDocument, GuiFlow, GuiScreen, GuiSection, GuiWidget } from './model.js'
import { parseGuiSpec, parseGuiFromAspecYaml } from './parse.js'
import { serializeGuiSpec } from './serialize.js'
import {
  findElements,
  nodeAtPath,
  parentPathOf,
  parseHtmlFragment,
  sanitizeHtml,
  serializeHtml,
  type HtmlNode
} from './html.js'
import { emptyGuiHtml, escapeAttr, escapeText, isAllowedClass } from './dialect.js'
import { migrateYamlDocument } from './migrate.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function appNode(root: HtmlNode): HtmlNode {
  return (
    findElements(root, (n) => Boolean(n.attrs['data-app']))[0] ?? {
      type: 'element',
      tag: 'div',
      attrs: { class: 'as-app', 'data-app': 'App' },
      children: root.children.filter((c) => c.type === 'element')
    }
  )
}

function screenNode(root: HtmlNode, screenId: string): HtmlNode | undefined {
  const key = screenId.trim()
  if (!key) return undefined
  return findElements(
    root,
    (n) =>
      n.attrs['data-screen'] === key ||
      n.attrs.id === key ||
      n.attrs['data-screen']?.toLowerCase() === key.toLowerCase() ||
      n.attrs.id?.toLowerCase() === key.toLowerCase()
  )[0]
}

function widgetHtml(widget: GuiWidget): HtmlNode {
  const html = (() => {
    const id = widget.id ? ` id="${escapeAttr(widget.id)}"` : ''
    const bindParts: string[] = []
    if (widget.binds?.param) bindParts.push(`param:${widget.binds.param}`)
    if (widget.binds?.variable) bindParts.push(`var:${widget.binds.variable}`)
    if (widget.binds?.out) bindParts.push(`out:${widget.binds.out}`)
    if (widget.binds?.display) bindParts.push(`display:${widget.binds.display}`)
    const bindAttr = bindParts.length ? ` data-bind="${escapeAttr(bindParts.join('|'))}"` : ''
    const process = widget.process || (widget.kind === 'button' ? widget.action : undefined)
    const processAttr = process ? ` data-process="${escapeAttr(process)}"` : ''
    const nav = widget.nav || widget.events?.find((e) => e.targetView)?.targetView
    const navAttr = nav ? ` data-nav="${escapeAttr(nav)}"` : ''
    const label = escapeText(widget.label ?? widget.kind)
    switch (widget.kind) {
      case 'text-input':
        return `<label class="as-field">${label}<input class="as-input"${id}${bindAttr} /></label>`
      case 'button':
        return `<button class="as-btn as-btn-primary"${id}${processAttr}${navAttr}>${label}</button>`
      case 'navigation':
        return `<button class="as-btn"${id}${navAttr || processAttr}>${label}</button>`
      case 'checkbox':
        return `<label class="as-field"><input type="checkbox" class="as-input"${id}${bindAttr} /> ${label}</label>`
      case 'select':
        return `<label class="as-field">${label}<select class="as-select"${id}${bindAttr}></select></label>`
      case 'table':
        return `<table class="as-table"${id}${bindAttr}><thead><tr><th>${label}</th></tr></thead><tbody></tbody></table>`
      case 'list':
        return `<ul class="as-list"${id}><li>${label}</li></ul>`
      case 'section':
        return `<div class="as-card"${id}><h2 class="as-title">${label}</h2></div>`
      default:
        return `<p class="as-muted"${id}>${label}</p>`
    }
  })()
  return parseHtmlFragment(html).children[0]!
}

function isScreenRoot(node: HtmlNode | undefined): boolean {
  if (!node || node.type !== 'element') return false
  return (
    node.tag === 'section' ||
    Boolean(node.attrs['data-screen']) ||
    Boolean(node.attrs.class?.split(/\s+/).includes('as-screen'))
  )
}

function applyScreenIdentity(screen: HtmlNode, next: HtmlNode): void {
  const id = screen.attrs.id
  const dataScreen = screen.attrs['data-screen']
  screen.attrs = { ...screen.attrs, ...next.attrs }
  if (id) screen.attrs.id = id
  if (dataScreen) screen.attrs['data-screen'] = dataScreen
}

function screenTemplate(screen: GuiScreen): HtmlNode {
  if (screen.html?.trim()) {
    const frag = parseHtmlFragment(screen.html)
    const first = frag.children.find((c) => c.type === 'element')
    if (first && isScreenRoot(first)) {
      first.attrs.id = screen.id || first.attrs.id
      first.attrs['data-screen'] = screen.name || first.attrs['data-screen']
      if (screen.triggersProcess) first.attrs['data-process'] = screen.triggersProcess
      if (!first.attrs.class?.includes('as-screen')) {
        first.attrs.class = [first.attrs.class, 'as-screen'].filter(Boolean).join(' ')
      }
      return first
    }
    return {
      type: 'element',
      tag: 'section',
      attrs: {
        class: 'as-screen',
        id: screen.id,
        'data-screen': screen.name,
        ...(screen.triggersProcess ? { 'data-process': screen.triggersProcess } : {})
      },
      children: frag.children
    }
  }
  const process = screen.triggersProcess ? ` data-process="${escapeAttr(screen.triggersProcess)}"` : ''
  const html = `<section class="as-screen" id="${escapeAttr(screen.id)}" data-screen="${escapeAttr(screen.name)}"${process}>
    <h1 class="as-title">${escapeText(screen.title ?? screen.name)}</h1>
    <div class="as-stack as-gap-md"></div>
  </section>`
  const node = parseHtmlFragment(html).children[0]!
  const stack = findElements(node, (n) => Boolean(n.attrs.class?.includes('as-stack')))[0]
  for (const widget of screen.widgets ?? []) {
    stack?.children.push(widgetHtml(widget))
  }
  return node
}

function toSource(root: HtmlNode): string {
  const app = appNode(root)
  if (app.tag === '#root') return sanitizeHtml(serializeHtml(root))
  return sanitizeHtml(serializeHtml(app))
}

function withRoot(source: string, mutate: (root: HtmlNode) => void): string {
  const { document } = parseGuiSpec(source)
  if (!document) return source
  const root = parseHtmlFragment(document.html)
  mutate(root)
  return toSource(root)
}

export function patchFieldById(source: string, idPath: string, value: unknown): string {
  const parts = idPath.split('.')
  if (parts.length < 2) return source
  const [kind, id, ...rest] = parts
  const field = rest.join('.')
  return withRoot(source, (root) => {
    if (kind === 'app') {
      const app = appNode(root)
      if (id === 'name' || field === 'name') app.attrs['data-app'] = String(value ?? '')
      return
    }
    if (kind === 'screen') {
      const screen = screenNode(root, id!)
      if (!screen) return
      if (field === 'title' || field === 'name') {
        screen.attrs['data-screen'] = String(value ?? screen.attrs['data-screen'])
        const title = findElements(screen, (n) => n.tag === 'h1')[0]
        if (title) {
          title.children = [{ type: 'text', attrs: {}, children: [], text: String(value ?? '') }]
        }
      }
      if (field === 'triggersProcess') {
        if (value) screen.attrs['data-process'] = String(value)
        else delete screen.attrs['data-process']
      }
    }
    if (kind === 'widget') {
      const el = findElements(root, (n) => n.attrs.id === id || n.attrs['data-id'] === id)[0]
      if (!el) return
      if (field === 'label') {
        el.children = [{ type: 'text', attrs: {}, children: [], text: String(value ?? '') }]
      }
      if (field === 'events' && Array.isArray(value)) {
        const nav = (value as Array<{ targetView?: string }>).find((e) => e.targetView)
        if (nav?.targetView) el.attrs['data-nav'] = nav.targetView
      }
      if (field.startsWith('bounds')) return
    }
  })
}

export function addGuiScreen(source: string, screen: GuiScreen): string {
  return withRoot(source, (root) => {
    appNode(root).children.push(screenTemplate(screen))
  })
}

export function removeGuiScreen(source: string, screenId: string): string {
  return withRoot(source, (root) => {
    const app = appNode(root)
    app.children = app.children.filter(
      (c) => !(c.type === 'element' && (c.attrs.id === screenId || c.attrs['data-screen'] === screenId))
    )
  })
}

export function addGuiWidget(source: string, screenId: string, widget: GuiWidget): string {
  return withRoot(source, (root) => {
    const screen = screenNode(root, screenId)
    if (!screen) return
    const stack =
      findElements(screen, (n) => Boolean(n.attrs.class?.includes('as-stack')))[0] ?? screen
    stack.children.push(widgetHtml(widget))
  })
}

export function removeGuiWidget(source: string, widgetId: string): string {
  const strip = (node: HtmlNode): HtmlNode[] =>
    node.children
      .filter((c) => !(c.type === 'element' && (c.attrs.id === widgetId || c.attrs['data-id'] === widgetId)))
      .map((c) => {
        c.children = strip(c)
        return c
      })
  return withRoot(source, (root) => {
    root.children = strip(root)
  })
}

export function addGuiFlow(source: string, flow: GuiFlow): string {
  return withRoot(source, (root) => {
    const screen = screenNode(root, flow.from)
    if (!screen) return
    const btn = findElements(screen, (n) => n.tag === 'button')[0]
    if (btn) btn.attrs['data-nav'] = flow.to
    else {
      screen.children.push(
        widgetHtml({
          id: `${flow.from}-to-${flow.to}`,
          kind: 'navigation',
          label: flow.label || 'Go',
          nav: flow.to
        })
      )
    }
  })
}

export function removeGuiFlow(source: string, from: string, to: string): string {
  return withRoot(source, (root) => {
    const screen = screenNode(root, from)
    if (!screen) return
    for (const el of findElements(screen, (n) => n.attrs['data-nav'] === to)) {
      delete el.attrs['data-nav']
    }
  })
}

function applyClassValue(value: string): string {
  return value
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c && isAllowedClass(c))
    .join(' ')
}

export function patchHtmlNode(
  source: string,
  path: string,
  patch: { attrs?: Record<string, string | null>; text?: string }
): string {
  return withRoot(source, (root) => {
    const node = nodeAtPath(root, path)
    if (!node || node.type !== 'element') return
    if (patch.attrs) {
      for (const [key, value] of Object.entries(patch.attrs)) {
        if (value == null || value === '') {
          delete node.attrs[key]
          continue
        }
        node.attrs[key] = key === 'class' ? applyClassValue(value) : value
      }
    }
    if (patch.text != null) {
      node.children = [{ type: 'text', attrs: {}, children: [], text: patch.text }]
    }
  })
}

export function insertHtml(source: string, parentPath: string, html: string): string {
  return withRoot(source, (root) => {
    const parent = nodeAtPath(root, parentPath)
    if (!parent || parent.type !== 'element') return
    const fragment = parseHtmlFragment(html)
    parent.children.push(...fragment.children.filter((c) => c.type === 'element' || Boolean(c.text?.trim())))
  })
}

export function removeHtmlNode(source: string, path: string): string {
  return withRoot(source, (root) => {
    const parent = nodeAtPath(root, parentPathOf(path))
    if (!parent) return
    const index = Number(path.slice(parentPathOf(path) ? parentPathOf(path).length + 1 : 0))
    const kids = parent.children.filter((c) => c.type === 'element')
    const target = kids[index]
    if (!target) return
    parent.children = parent.children.filter((c) => c !== target)
  })
}

export type PatchGuiAction =
  | { action: 'patch-by-id'; idPath: string; value: unknown }
  | { action: 'add-screen'; screen: GuiScreen }
  | { action: 'remove-screen'; screenId: string }
  | { action: 'add-widget'; screenId: string; widget: GuiWidget }
  | { action: 'remove-widget'; widgetId: string }
  | { action: 'add-flow'; flow: GuiFlow }
  | { action: 'remove-flow'; from: string; to: string }
  | { action: 'patch-app'; field: string; value: unknown }
  | { action: 'replace-html'; html: string }
  | { action: 'replace-screen-html'; screenId: string; html: string }
  | { action: 'patch-node'; path: string; attrs?: Record<string, string | null>; text?: string }
  | { action: 'insert-html'; parentPath: string; html: string }
  | { action: 'remove-node'; path: string }

export function patchGui(source: string, payload: PatchGuiAction): string {
  switch (payload.action) {
    case 'patch-by-id':
      return patchFieldById(source, payload.idPath, payload.value)
    case 'add-screen':
      return addGuiScreen(source, payload.screen)
    case 'remove-screen':
      return removeGuiScreen(source, payload.screenId)
    case 'add-widget':
      return addGuiWidget(source, payload.screenId, payload.widget)
    case 'remove-widget':
      return removeGuiWidget(source, payload.widgetId)
    case 'add-flow':
      return addGuiFlow(source, payload.flow)
    case 'remove-flow':
      return removeGuiFlow(source, payload.from, payload.to)
    case 'patch-app':
      return patchFieldById(source, `app.${payload.field}`, payload.value)
    case 'replace-html':
      return sanitizeHtml(payload.html)
    case 'replace-screen-html':
      return withRoot(source, (root) => {
        const screen = screenNode(root, payload.screenId)
        if (!screen) return
        const frag = parseHtmlFragment(payload.html)
        const elements = frag.children.filter((c) => c.type === 'element')
        const first = elements[0]
        if (first && isScreenRoot(first) && elements.length === 1) {
          applyScreenIdentity(screen, first)
          screen.children = first.children
          return
        }
        screen.children = frag.children
      })
    case 'patch-node':
      return patchHtmlNode(source, payload.path, { attrs: payload.attrs, text: payload.text })
    case 'insert-html':
      return insertHtml(source, payload.parentPath, payload.html)
    case 'remove-node':
      return removeHtmlNode(source, payload.path)
    default:
      return source
  }
}

export function extractGuiFromAspec(aspecSource: string): GuiSection | null {
  return parseGuiFromAspecYaml(aspecSource).gui
}

export function embedGuiInAspec(aspecSource: string, gui: GuiSection): string {
  try {
    const raw = parseYaml(aspecSource)
    if (!isRecord(raw)) return aspecSource
    raw.gui = gui
    return stringify(raw, { lineWidth: 0 })
  } catch {
    return aspecSource
  }
}

export function removeGuiFromAspec(aspecSource: string): string {
  return aspecSource
}

export function mergeGuiSources(embedded: GuiSection | null, external: GuiSection | null): GuiSection | null {
  if (!embedded && !external) return null
  if (!embedded) return external
  if (!external) return embedded
  const screenMap = new Map<string, GuiScreen>()
  for (const s of embedded.screens) screenMap.set(s.id, s)
  for (const s of external.screens) screenMap.set(s.id, s)
  const flowKey = (f: GuiFlow) => `${f.from}->${f.to}`
  const flowMap = new Map<string, GuiFlow>()
  for (const f of embedded.flows ?? []) flowMap.set(flowKey(f), f)
  for (const f of external.flows ?? []) flowMap.set(flowKey(f), f)
  return {
    app: external.app?.name ? external.app : embedded.app,
    screens: [...screenMap.values()],
    flows: [...flowMap.values()]
  }
}

export function guispecFromGuiSection(
  gui: GuiSection,
  meta: { id: string; title: string; informalTarget?: string }
): GuiDocument {
  const html = migrateYamlDocument({ meta, gui })
  return {
    guispecVersion: 'html-1',
    meta,
    gui,
    html
  }
}

export function formatGui(source: string): string {
  const { document } = parseGuiSpec(source)
  if (!document) return source
  return serializeGuiSpec(document)
}

export function defaultGuiHtml(appName = 'App'): string {
  return emptyGuiHtml(appName)
}

/** Serialize one screen as a standalone HTML document fragment. */
export function extractScreenHtml(source: string, screenId: string): string {
  const { document } = parseGuiSpec(source)
  if (!document) return ''
  const root = parseHtmlFragment(document.html)
  const screen = screenNode(root, screenId)
  if (!screen) return ''
  // A screen stored as inactive (is-hidden) must still render when opened alone.
  const classes = (screen.attrs.class ?? '').split(/\s+/).filter((c) => c && c !== 'is-hidden')
  if (classes.length) screen.attrs.class = classes.join(' ')
  else delete screen.attrs.class
  return sanitizeHtml(serializeHtml(screen))
}

/** Wrap a single screen so the prototype host can render it as its own page. */
export function wrapPrototypeHtml(appName: string, screenHtml: string): string {
  const inner = screenHtml.trim()
  if (!inner) return emptyGuiHtml(appName)
  if (/\bdata-app\s*=/.test(inner) || /\bas-app\b/.test(inner)) return sanitizeHtml(inner)
  return sanitizeHtml(`<div class="as-app" data-app="${escapeAttr(appName)}">\n${inner}\n</div>\n`)
}
