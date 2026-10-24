/**
 * Dual save (final grammar G:36-38): whenever a Hybrid specification (.asfl) is saved,
 * every module is additionally written as a text file and an XML file:
 *
 *   <dir>/.agile-sofl/modules/<file-basename>/<ModuleName>.asfl   (module text)
 *   <dir>/.agile-sofl/modules/<file-basename>/<ModuleName>.xml    (XML, schema urn:agile-sofl:module:1)
 *
 * The main .asfl file is written unchanged first; dual save never blocks or fails the save.
 * If the document does not parse, the previous per-module files are kept and the reason is returned.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { parse, moduleArtifacts } from '@agile-sofl/parser'

export interface DualSaveResult {
  written: string[]
  skipped?: string
}

export function moduleArtifactDir(filePath: string): string {
  return join(dirname(filePath), '.agile-sofl', 'modules', basename(filePath, extname(filePath)))
}

export function writeModuleArtifacts(filePath: string, content: string): DualSaveResult {
  if (extname(filePath).toLowerCase() !== '.asfl') return { written: [], skipped: 'not an .asfl file' }
  let ast
  try {
    ast = parse(content).ast
  } catch (e) {
    return { written: [], skipped: `parse failed: ${String(e)}` }
  }
  if (!ast || ast.type !== 'program' || ast.modules.length === 0) {
    return { written: [], skipped: 'no parsable modules' }
  }
  const dir = moduleArtifactDir(filePath)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const keep = new Set<string>()
  for (const a of moduleArtifacts(ast, content)) {
    const safe = a.moduleName.replace(/[^A-Za-z0-9_.-]/g, '_')
    const txt = join(dir, `${safe}.asfl`)
    const xml = join(dir, `${safe}.xml`)
    writeFileSync(txt, a.text, 'utf-8')
    writeFileSync(xml, a.xml, 'utf-8')
    written.push(txt, xml)
    keep.add(`${safe}.asfl`).add(`${safe}.xml`)
  }
  // remove artifacts of modules that no longer exist
  for (const f of readdirSync(dir)) if (/\.(asfl|xml)$/.test(f) && !keep.has(f)) unlinkSync(join(dir, f))
  return { written }
}
