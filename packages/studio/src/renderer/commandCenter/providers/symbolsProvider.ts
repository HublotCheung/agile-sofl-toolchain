import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-types'
import type { CommandCenterContext, CommandCenterItem, CommandCenterProvider } from '../types'
import { useLspStore } from '../../stores/lsp'
import {
  lspRangeToSpan,
  navigateToLocation,
  symbolKindLabel
} from '../navigation'

const LSP_KIND_TO_SYMBOL: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'type',
  6: 'method',
  7: 'property',
  8: 'var',
  9: 'enum',
  10: 'interface',
  11: 'function',
  12: 'const',
  13: 'string',
  14: 'number',
  15: 'boolean',
  16: 'array',
  17: 'object',
  18: 'key',
  19: 'null',
  20: 'enumMember',
  21: 'struct',
  22: 'event',
  23: 'operator',
  24: 'typeParameter'
}

function mapLspKind(kind: number): string {
  if (kind === 2) return 'module'
  if (kind === 5) return 'type'
  if (kind === 6) return 'process'
  if (kind === 11) return 'function'
  if (kind === 12) return 'const'
  if (kind === 8) return 'var'
  if (kind === 22) return 'fsf'
  return LSP_KIND_TO_SYMBOL[kind] ?? 'symbol'
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  uri: string,
  ctx: CommandCenterContext,
  parentModule?: string
): CommandCenterItem[] {
  const items: CommandCenterItem[] = []
  for (const sym of symbols) {
    const kind = mapLspKind(sym.kind)
    const moduleName = kind === 'module' ? sym.name.replace(/^SYSTEM_/, '') : parentModule ?? ''
    const span = lspRangeToSpan(sym.selectionRange ?? sym.range)
    const badge = symbolKindLabel(kind, ctx.t)

    items.push({
      id: `sym:${uri}:${span.line}:${span.column}:${sym.name}`,
      kind: 'symbol',
      label: sym.name,
      detail: sym.detail ?? parentModule,
      badge,
      group: 'commandCenter.group.symbols',
      score: 35,
      execute: async () => {
        await navigateToLocation(ctx, uri, span, {
          kind,
          moduleName,
          name: sym.name.replace(/^SYSTEM_/, '')
        })
      }
    })

    if (sym.children?.length) {
      const mod = kind === 'module' ? sym.name.replace(/^SYSTEM_/, '') : parentModule
      items.push(...flattenDocumentSymbols(sym.children, uri, ctx, mod))
    }
  }
  return items
}

async function queryDocumentSymbols(uri: string, ctx: CommandCenterContext): Promise<CommandCenterItem[]> {
  const lsp = useLspStore()
  if (!lsp.running) {
    return await queryDocumentSymbolsFallback(uri, ctx)
  }
  const { getLanguageClient } = await import('../../monaco/languageClient')
  const client = getLanguageClient()
  if (!client) return await queryDocumentSymbolsFallback(uri, ctx)

  try {
    const symbols = (await client.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri }
    })) as DocumentSymbol[] | null
    if (!symbols?.length) return await queryDocumentSymbolsFallback(uri, ctx)
    return flattenDocumentSymbols(symbols, uri, ctx)
  } catch {
    return await queryDocumentSymbolsFallback(uri, ctx)
  }
}

async function queryDocumentSymbolsFallback(uri: string, ctx: CommandCenterContext): Promise<CommandCenterItem[]> {
  const tab = ctx.documentTabs.find((t) => t.uri === uri)
  if (!tab) return []
  const model = await window.studio!.buildVisualModel(tab.content, tab.id)
  const items: CommandCenterItem[] = []

  for (const mod of model.modules) {
    const moduleLabel = mod.isSystem ? `SYSTEM_${mod.name}` : mod.name
    items.push({
      id: `sym-fb:module:${mod.name}`,
      kind: 'symbol',
      label: moduleLabel,
      detail: mod.parentName ? `/${mod.parentName}` : undefined,
      badge: symbolKindLabel('module', ctx.t),
      group: 'commandCenter.group.symbols',
      score: 35,
      execute: async () => {
        await navigateToLocation(ctx, uri, mod.span, { kind: 'module', moduleName: mod.name, name: mod.name })
      }
    })

    for (const inv of mod.invariants) {
      items.push({
        id: `sym-fb:inv:${mod.name}:${inv.span.start}`,
        kind: 'symbol',
        label: inv.text.length > 48 ? inv.text.slice(0, 47) + '…' : inv.text,
        detail: moduleLabel,
        badge: symbolKindLabel('invariant', ctx.t),
        group: 'commandCenter.group.symbols',
        score: 20,
        execute: async () => {
          await navigateToLocation(ctx, uri, inv.span)
        }
      })
    }

    for (const p of mod.processes) {
      if (!p.span) continue
      items.push({
        id: `sym-fb:process:${mod.name}:${p.name}`,
        kind: 'symbol',
        label: p.name,
        detail: moduleLabel,
        badge: symbolKindLabel('process', ctx.t),
        group: 'commandCenter.group.symbols',
        score: 35,
        execute: async () => {
          await navigateToLocation(ctx, uri, p.span!, {
            kind: 'process',
            moduleName: mod.name,
            name: p.name
          })
        }
      })
    }

    for (const f of mod.functions) {
      items.push({
        id: `sym-fb:function:${mod.name}:${f.name}`,
        kind: 'symbol',
        label: f.name,
        detail: moduleLabel,
        badge: symbolKindLabel('function', ctx.t),
        group: 'commandCenter.group.symbols',
        score: 35,
        execute: async () => {
          await navigateToLocation(ctx, uri, f.span, {
            kind: 'function',
            moduleName: mod.name,
            name: f.name
          })
        }
      })
    }

    for (const c of mod.consts) {
      items.push(symbolDeclItem(ctx, uri, mod.name, moduleLabel, c.name, c.span, 'const'))
    }
    for (const t of mod.types) {
      items.push(symbolDeclItem(ctx, uri, mod.name, moduleLabel, t.name, t.span, 'type'))
    }
    for (const v of mod.vars) {
      items.push(symbolDeclItem(ctx, uri, mod.name, moduleLabel, v.name, v.span, 'var'))
    }
  }

  return items
}

function symbolDeclItem(
  ctx: CommandCenterContext,
  uri: string,
  moduleName: string,
  moduleLabel: string,
  name: string,
  span: { start: number; end: number; line: number; column: number },
  kind: string
): CommandCenterItem {
  return {
    id: `sym-fb:${kind}:${moduleName}:${name}`,
    kind: 'symbol',
    label: name,
    detail: moduleLabel,
    badge: symbolKindLabel(kind, ctx.t),
    group: 'commandCenter.group.symbols',
    score: 30,
    execute: async () => {
      await navigateToLocation(ctx, uri, span)
    }
  }
}

async function queryWorkspaceSymbols(query: string, ctx: CommandCenterContext): Promise<CommandCenterItem[]> {
  const lsp = useLspStore()
  if (!lsp.running) {
    return await queryWorkspaceSymbolsFallback(query, ctx)
  }
  const { getLanguageClient } = await import('../../monaco/languageClient')
  const client = getLanguageClient()
  if (!client) return await queryWorkspaceSymbolsFallback(query, ctx)

  try {
    const symbols = (await client.sendRequest('workspace/symbol', { query })) as SymbolInformation[] | null
    if (!symbols?.length) return await queryWorkspaceSymbolsFallback(query, ctx)

    return symbols.map((sym) => {
      const uri = sym.location.uri
      const span = lspRangeToSpan(sym.location.range)
      const kind = mapLspKind(sym.kind)
      const moduleName = sym.containerName?.replace(/^SYSTEM_/, '') ?? ''
      const path = uri.split('/').pop() ?? uri

      return {
        id: `wsym:${uri}:${span.line}:${sym.name}`,
        kind: 'symbol' as const,
        label: sym.name,
        detail: sym.containerName ? `${sym.containerName} · ${path}` : path,
        badge: symbolKindLabel(kind, ctx.t),
        group: 'commandCenter.group.symbols',
        score: 40,
        execute: async () => {
          await navigateToLocation(ctx, uri, span, {
            kind,
            moduleName,
            name: sym.name.replace(/^SYSTEM_/, '')
          })
        }
      }
    })
  } catch {
    return await queryWorkspaceSymbolsFallback(query, ctx)
  }
}

async function queryWorkspaceSymbolsFallback(query: string, ctx: CommandCenterContext): Promise<CommandCenterItem[]> {
  const rootDir = resolveSearchRoot(ctx)
  if (!rootDir || !window.studio?.searchWorkspaceSymbols) return []

  const symbols = await window.studio.searchWorkspaceSymbols(rootDir, query)
  return symbols.map((sym) => ({
    id: `wsym-fb:${sym.uri}:${sym.span.start}:${sym.name}`,
    kind: 'symbol' as const,
    label: sym.name,
    detail: sym.containerName ? `${sym.containerName} · ${fileBasename(sym.uri)}` : fileBasename(sym.uri),
    badge: symbolKindLabel(sym.kind, ctx.t),
    group: 'commandCenter.group.symbols',
    score: 35,
    execute: async () => {
      await navigateToLocation(ctx, sym.uri, sym.span, {
        kind: sym.kind,
        moduleName: sym.moduleName,
        name: sym.name.replace(/^SYSTEM_/, '')
      })
    }
  }))
}

function fileBasename(uri: string): string {
  const path = uri.replace(/^file:\/\//, '').split('/').pop() ?? uri
  return path
}

function resolveSearchRoot(ctx: CommandCenterContext): string | null {
  const tab = ctx.activeTab
  if (tab?.filePath) {
    const parts = tab.filePath.split(/[/\\]/)
    parts.pop()
    return parts.join('/') || null
  }
  const recent = ctx.recentFiles[0]
  if (recent?.path) {
    const parts = recent.path.split(/[/\\]/)
    parts.pop()
    return parts.join('/') || null
  }
  return null
}

export const symbolsProvider: CommandCenterProvider = {
  id: 'symbols',
  prefix: '@',
  priority: 10,
  isEnabled: (ctx) => ctx.documentTabs.length > 0 || ctx.recentFiles.length > 0,
  async query(query, ctx) {
    const tab = ctx.activeTab?.kind === 'document' ? ctx.activeTab : ctx.documentTabs[0]
    if (!tab) return []

    if (!query) {
      return await queryDocumentSymbols(tab.uri, ctx)
    }

    const workspace = await queryWorkspaceSymbols(query, ctx)
    if (workspace.length) return workspace

    const local = await queryDocumentSymbols(tab.uri, ctx)
    const needle = query.toLowerCase()
    return local.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        (item.detail?.toLowerCase().includes(needle) ?? false)
    )
  }
}
