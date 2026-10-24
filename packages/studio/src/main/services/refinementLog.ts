import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { authorNotesFromInformalMarkdown, type AuthorTextNote } from '@agile-sofl/parser'
import {
  applyRefinementStep,
  buildRefinementState,
  parseRefinementLog,
  serializeRefinementLog,
  type RefinementLogEntry,
  type RefinementStep
} from '@agile-sofl/editor-api'
import { acceptHybridWrite } from '../../shared/asflRepair'

function informalGrainNotes(projectRoot: string): AuthorTextNote[] {
  if (!projectRoot) return []
  let names: string[] = []
  try {
    names = readdirSync(projectRoot).filter((name) => name.endsWith('.aspec'))
  } catch {
    return []
  }
  const notes: AuthorTextNote[] = []
  for (const name of names) {
    try {
      notes.push(...authorNotesFromInformalMarkdown(readFileSync(join(projectRoot, name), 'utf-8')))
    } catch {
      /* skip unreadable informal files */
    }
  }
  return notes
}

export function refinementLogPath(projectRoot: string): string {
  return join(projectRoot, '.agile-sofl', 'refinement-log.jsonl')
}

export function readRefinementLog(projectRoot: string): RefinementLogEntry[] {
  const file = refinementLogPath(projectRoot)
  if (!existsSync(file)) return []
  try {
    return parseRefinementLog(readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
}

export function writeRefinementLog(projectRoot: string, entries: RefinementLogEntry[]): void {
  const file = refinementLogPath(projectRoot)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serializeRefinementLog(entries), 'utf-8')
}

export function applyProjectRefinementStep(
  projectRoot: string,
  source: string,
  step: RefinementStep
): ReturnType<typeof applyRefinementStep> & { repairNotes?: string[]; warnings?: string[] } {
  const log = readRefinementLog(projectRoot)
  const result = applyRefinementStep(source, log, step, informalGrainNotes(projectRoot))
  if (result.error && result.source === source) return result
  const gated = acceptHybridWrite(source, result.source)
  if (gated.content !== source) writeRefinementLog(projectRoot, result.log)
  const lint = [...(result.error && result.source !== source ? [result.error] : []), ...(gated.warnings ?? [])]
  return {
    ...result,
    source: gated.content,
    repairNotes: gated.repairNotes,
    warnings: lint.length ? lint : undefined,
    error: gated.content === source ? result.error ?? (lint.length ? lint.join('; ') : undefined) : undefined
  }
}

export function projectRefinementState(projectRoot: string, source: string) {
  return buildRefinementState(source, readRefinementLog(projectRoot), informalGrainNotes(projectRoot))
}
