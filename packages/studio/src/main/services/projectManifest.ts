import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import {
  MANIFEST_FILENAME,
  type AgileSoflManifest
} from '../../shared/projectTypes.js'
import { writeInformalSpecFile } from './informalMeta.js'

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

function isGuiSpecFile(name: string): boolean {
  return name === 'gui.html' || name.endsWith('.gui.html') || name.endsWith('.guispec')
}

function scanSpecFiles(root: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = join(root, name)
    const st = statSync(full)
    if (st.isDirectory()) scanSpecFiles(full, ext, out)
    else if (name.endsWith(ext)) out.push(full)
  }
  return out
}

function scanGuiFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = join(root, name)
    const st = statSync(full)
    if (st.isDirectory()) scanGuiFiles(full, out)
    else if (isGuiSpecFile(name)) out.push(full)
  }
  return out
}

function scanProjectRoot(root: string): {
  aspecFiles: string[]
  asflFiles: string[]
  guispecFiles: string[]
} {
  return {
    aspecFiles: scanSpecFiles(root, '.aspec'),
    asflFiles: scanSpecFiles(root, '.asfl'),
    guispecFiles: scanGuiFiles(root)
  }
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_FILENAME)
}

export function readManifest(root: string): AgileSoflManifest | null {
  const path = manifestPath(root)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgileSoflManifest>
    if (!raw || typeof raw.name !== 'string') return null
    return normalizeManifest(raw, basename(root))
  } catch {
    return null
  }
}

export function writeManifest(root: string, manifest: AgileSoflManifest): void {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

export function normalizeManifest(
  raw: Partial<AgileSoflManifest>,
  fallbackName: string
): AgileSoflManifest {
  const hybrid = Array.isArray(raw.hybrid)
    ? raw.hybrid.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return {
    version: '1.0',
    name: raw.name?.trim() || fallbackName,
    guiModule: raw.guiModule?.trim() || undefined,
    informal: raw.informal?.trim() || 'informal.aspec',
    hybrid: hybrid.length ? hybrid : ['hybrid.asfl'],
    gui: raw.gui?.trim() || undefined
  }
}

export async function loadOrCreateManifest(root: string): Promise<AgileSoflManifest> {
  const existing = readManifest(root)
  if (existing) return existing
  const inferred = await inferManifest(root)
  writeManifest(root, inferred)
  return inferred
}

export async function inferManifest(root: string): Promise<AgileSoflManifest> {
  const scan = scanProjectRoot(root)
  const informalRel = toRel(root, scan.aspecFiles[0]) ?? 'informal.aspec'
  const hybrid = scan.asflFiles.map((p) => toRel(root, p)!).filter(Boolean)
  const guiRel = toRel(root, scan.guispecFiles[0])
  const base = basename(scan.aspecFiles[0] ?? '', '.aspec')
  const pairGui =
    scan.guispecFiles.find((p) => basename(p, '.gui.html') === `${base}-gui`) ??
    scan.guispecFiles.find((p) => basename(p, '.guispec') === `${base}-gui`) ??
    scan.guispecFiles.find((p) => basename(p, '.gui.html') === base.replace(/-informal$/, '') + '-gui') ??
    scan.guispecFiles.find((p) => basename(p, '.guispec') === base.replace(/-informal$/, '') + '-gui')
  return {
    version: '1.0',
    name: basename(root),
    informal: informalRel,
    hybrid: hybrid.length ? hybrid : ['hybrid.asfl'],
    gui: guiRel ?? (pairGui ? toRel(root, pairGui) : undefined)
  }
}

function toRel(root: string, abs?: string): string | undefined {
  if (!abs) return undefined
  return relative(root, abs).replace(/\\/g, '/')
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'NewSystem'
}

export function asflIdent(name: string): string {
  const ident = slugifyProjectName(name).replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(ident) ? ident : `System_${ident}`
}

export function createProjectTemplate(root: string, name: string): AgileSoflManifest {
  mkdirSync(root, { recursive: true })
  const ident = asflIdent(name)
  const informal = 'informal.aspec'
  const hybrid = 'hybrid.asfl'
  const gui = 'gui.html'
  const manifest: AgileSoflManifest = {
    version: '1.0',
    name,
    informal,
    hybrid: [hybrid],
    gui
  }

  writeInformalSpecFile(
    root,
    informal,
    `# Functions\n\n# Data Resources\n\n# Constraints\n`,
    {
      moduleId: ident,
      title: name,
      hybridTarget: `./${hybrid}`,
      guiTarget: `./${gui}`
    }
  )

  writeFileSync(
    join(root, hybrid),
    `module SYSTEM_${ident};
end_module
`,
    'utf-8'
  )

  writeFileSync(
    join(root, gui),
    `<div class="as-app" data-app="${ident}App">
  <section class="as-screen" data-screen="Home"></section>
</div>
`,
    'utf-8'
  )

  writeManifest(root, manifest)
  return manifest
}
