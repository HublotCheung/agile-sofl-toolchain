export type TabKind = 'home' | 'document'
export type DocumentKind = 'asfl' | 'aspec' | 'guispec'

export const HOME_TAB_ID = 'studio-home'

export interface EditorTab {
  id: string
  kind: TabKind
  documentKind: DocumentKind
  filePath: string | null
  uri: string
  title: string
  isDirty: boolean
  content: string
  savedContent?: string
  linkedDocumentId?: string
}

let untitledCounter = 1

export function createUntitledTitle(kind: DocumentKind = 'asfl'): string {
  if (kind === 'aspec') return `Untitled-${untitledCounter++}.aspec`
  if (kind === 'guispec') return `Untitled-${untitledCounter++}.gui.html`
  return `Untitled-${untitledCounter++}.asfl`
}

export function inferDocumentKind(filePath: string | null, uri?: string): DocumentKind {
  const path = filePath?.toLowerCase() ?? ''
  const u = uri?.toLowerCase() ?? ''
  if (path.endsWith('.aspec') || u.includes('.aspec')) return 'aspec'
  if (
    path.endsWith('.guispec') ||
    path.endsWith('.gui.html') ||
    path.endsWith('/gui.html') ||
    path.endsWith('\\gui.html') ||
    u.includes('.guispec') ||
    u.includes('.gui.html') ||
    u.endsWith('/gui.html')
  ) {
    return 'guispec'
  }
  return 'asfl'
}

export function defaultContentForKind(kind: DocumentKind): string {
  if (kind === 'aspec') {
    return `# Functions

# Data Resources

# Constraints
`
  }
  if (kind === 'guispec') {
    return `<div class="as-app" data-app="NewApp">
  <section class="as-screen" data-screen="Home">
    <h1 class="as-title">Home</h1>
    <div class="as-stack as-gap-md">
      <p class="as-muted">Describe the application UI.</p>
    </div>
  </section>
</div>
`
  }
  return 'module SYSTEM_New;\nend_module\n'
}

export function createHomeTab(): EditorTab {
  return {
    id: HOME_TAB_ID,
    kind: 'home',
    documentKind: 'asfl',
    filePath: null,
    uri: 'studio://home',
    title: 'Home',
    isDirty: false,
    content: ''
  }
}

export function tabUriForPath(filePath: string | null, id: string, kind: DocumentKind = 'asfl'): string {
  if (filePath) {
    return pathToFileUri(filePath)
  }
  const ext = kind === 'aspec' ? 'aspec' : kind === 'guispec' ? 'gui.html' : 'asfl'
  return `inmemory://studio/${id}.${ext}`
}

export function normalizeFilePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized[0].toLowerCase() + normalized.slice(1)
  else if (normalized.startsWith('/')) normalized = normalized.toLowerCase()
  return normalized
}

export function filePathsEqual(a: string, b: string): boolean {
  return normalizeFilePath(a) === normalizeFilePath(b)
}

/** True when `filePath` is the project root or a file inside it (not a sibling prefix like `test` vs `test2`). */
export function fileBelongsToRoot(filePath: string, rootPath: string): boolean {
  const file = normalizeFilePath(filePath)
  let root = normalizeFilePath(rootPath)
  if (root.endsWith('/')) root = root.slice(0, -1)
  if (!root) return false
  return file === root || file.startsWith(`${root}/`)
}

export function pathToFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) return `file:///${normalized}`
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

export function createDocumentTab(partial?: Partial<EditorTab>): EditorTab {
  const id = partial?.id ?? crypto.randomUUID()
  const documentKind = partial?.documentKind ?? inferDocumentKind(partial?.filePath ?? null, partial?.uri)
  const title = partial?.title ?? createUntitledTitle(documentKind)
  const filePath = partial?.filePath ?? null
  return {
    id,
    kind: 'document',
    documentKind,
    filePath,
    uri: partial?.uri ?? tabUriForPath(filePath, id, documentKind),
    title,
    isDirty: partial?.isDirty ?? false,
    content: partial?.content ?? defaultContentForKind(documentKind),
    savedContent: partial?.savedContent ?? (partial?.isDirty ? undefined : partial?.content),
    linkedDocumentId: partial?.linkedDocumentId
  }
}

export function monacoLanguageForDocumentKind(kind: DocumentKind): string {
  if (kind === 'aspec') return 'agile-aspec'
  if (kind === 'guispec') return 'html'
  return 'agile-sofl'
}

/** @deprecated use createDocumentTab */
export function createTab(partial?: Partial<EditorTab>): EditorTab {
  return createDocumentTab(partial)
}
