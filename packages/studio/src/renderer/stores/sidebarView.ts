import { defineStore } from 'pinia'
import { ref } from 'vue'
import { replaceEditorMatches } from '../search/applyReplace'
import { runProjectTextSearch } from '../search/runSearch'
import {
  normalizePathKey,
  toRelativePath,
  type TextMatch,
  type TextSearchFileHit,
  type TextSearchQuery
} from '../../shared/textSearch'

export type SidebarViewId = 'explorer' | 'search'

function queryOf(state: {
  query: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
  include: string
  exclude: string
}): TextSearchQuery {
  return {
    query: state.query,
    matchCase: state.matchCase,
    wholeWord: state.wholeWord,
    useRegex: state.useRegex,
    include: state.include,
    exclude: state.exclude
  }
}

export const useSidebarViewStore = defineStore('sidebarView', () => {
  const view = ref<SidebarViewId>('explorer')
  const focusNonce = ref(0)
  const focusTarget = ref<'find' | 'replace'>('find')
  const replaceVisible = ref(false)
  const query = ref('')
  const replaceText = ref('')
  const matchCase = ref(false)
  const wholeWord = ref(false)
  const useRegex = ref(false)
  const preserveCase = ref(false)
  const include = ref('')
  const exclude = ref('')
  const detailsOpen = ref(false)
  const searching = ref(false)
  const replacing = ref(false)
  const files = ref<TextSearchFileHit[]>([])
  const truncated = ref(false)
  const error = ref<string | null>(null)
  const collapsed = ref<Record<string, boolean>>({})
  let searchSeq = 0

  function showExplorer(): void {
    view.value = 'explorer'
  }

  function showSearch(options?: { replace?: boolean; query?: string }): void {
    view.value = 'search'
    if (options?.replace) replaceVisible.value = true
    if (options?.query) query.value = options.query
    focusTarget.value = options?.replace ? 'replace' : 'find'
    focusNonce.value += 1
  }

  async function openFindInFiles(replace: boolean): Promise<void> {
    const { useWorkspaceStore } = await import('../stores/workspace')
    useWorkspaceStore().setInformalCollapsed(false)
    let seeded: string | undefined
    try {
      const { captureFindQuery } = await import('../search/captureFindQuery')
      seeded = captureFindQuery() ?? undefined
    } catch {
      seeded = undefined
    }
    showSearch({ replace, query: seeded })
  }

  function currentQuery(): TextSearchQuery {
    return queryOf({
      query: query.value,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      useRegex: useRegex.value,
      include: include.value,
      exclude: exclude.value
    })
  }

  async function search(): Promise<void> {
    const seq = ++searchSeq
    const text = query.value
    if (!text) {
      files.value = []
      truncated.value = false
      error.value = null
      searching.value = false
      return
    }
    searching.value = true
    const { useWorkspaceStore } = await import('../stores/workspace')
    const root = useWorkspaceStore().activeProject?.rootPath ?? null
    const result = await runProjectTextSearch(root, currentQuery())
    if (seq !== searchSeq) return
    files.value = result.files
    truncated.value = result.truncated
    error.value = result.error
    collapsed.value = {}
    searching.value = false
  }

  function toggleCollapsed(path: string): void {
    const key = normalizePathKey(path)
    collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] }
  }

  function collapseAll(): void {
    const next: Record<string, boolean> = {}
    for (const file of files.value) next[normalizePathKey(file.path)] = true
    collapsed.value = next
  }

  function expandAll(): void {
    collapsed.value = {}
  }

  function clearResults(): void {
    searchSeq += 1
    query.value = ''
    replaceText.value = ''
    files.value = []
    truncated.value = false
    error.value = null
    searching.value = false
    collapsed.value = {}
  }

  function dismissFile(path: string): void {
    const key = normalizePathKey(path)
    files.value = files.value.filter((file) => normalizePathKey(file.path) !== key)
  }

  function dismissMatch(path: string, start: number): void {
    const key = normalizePathKey(path)
    files.value = files.value
      .map((file) => {
        if (normalizePathKey(file.path) !== key) return file
        return { ...file, matches: file.matches.filter((match) => match.start !== start) }
      })
      .filter((file) => file.matches.length > 0)
  }

  function replaceablePaths(onlyPath?: string): string[] {
    return files.value
      .filter((file) => file.replaceable && (!onlyPath || normalizePathKey(file.path) === normalizePathKey(onlyPath)))
      .map((file) => file.path)
  }

  async function replaceAll(onlyPath?: string): Promise<void> {
    if (replacing.value) return
    const paths = replaceablePaths(onlyPath)
    if (!paths.length || !query.value) return
    replacing.value = true
    try {
      await replaceEditorMatches({
        paths,
        query: currentQuery(),
        replacement: replaceText.value,
        preserveCase: preserveCase.value
      })
      await search()
    } finally {
      replacing.value = false
    }
  }

  async function replaceMatch(path: string, match: TextMatch): Promise<void> {
    if (replacing.value) return
    const file = files.value.find((item) => normalizePathKey(item.path) === normalizePathKey(path))
    if (!file?.replaceable) return
    replacing.value = true
    try {
      await replaceEditorMatches({
        paths: [file.path],
        query: currentQuery(),
        replacement: replaceText.value,
        preserveCase: preserveCase.value,
        only: match
      })
      await search()
    } finally {
      replacing.value = false
    }
  }

  function isCollapsed(path: string): boolean {
    return Boolean(collapsed.value[normalizePathKey(path)])
  }

  function relativeLabel(root: string, path: string): { name: string; dir: string } {
    const relative = toRelativePath(root, path)
    const slash = relative.lastIndexOf('/')
    if (slash < 0) return { name: relative, dir: '' }
    return { name: relative.slice(slash + 1), dir: relative.slice(0, slash) }
  }

  return {
    view,
    focusNonce,
    focusTarget,
    replaceVisible,
    query,
    replaceText,
    matchCase,
    wholeWord,
    useRegex,
    preserveCase,
    include,
    exclude,
    detailsOpen,
    searching,
    replacing,
    files,
    truncated,
    error,
    showExplorer,
    showSearch,
    openFindInFiles,
    search,
    toggleCollapsed,
    collapseAll,
    expandAll,
    clearResults,
    dismissFile,
    dismissMatch,
    replaceAll,
    replaceMatch,
    isCollapsed,
    relativeLabel
  }
})
