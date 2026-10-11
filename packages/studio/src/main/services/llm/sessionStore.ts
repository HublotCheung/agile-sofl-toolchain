import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSession, AgentSpecPermissions } from './agentTypes'
import { normalizePermissions } from './agentTypes'
import { newId } from './agentTypes'
import { applySessionSlice, forkSessionRecord, type SessionBranchMode } from './sessionBranch'

const INDEX_NAME = '_index.json'

type SessionIndexEntry = {
  id: string
  moduleId: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  archived?: boolean
  skillId?: string
  permissions?: AgentSpecPermissions
}

function sessionsDir(projectRoot: string): string {
  return join(projectRoot, '.agile-sofl', 'agent', 'sessions')
}

function indexPath(projectRoot: string): string {
  return join(sessionsDir(projectRoot), INDEX_NAME)
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json') && file !== INDEX_NAME)
}

function readIndex(projectRoot: string): SessionIndexEntry[] | null {
  const file = indexPath(projectRoot)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionIndexEntry[]
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry) => entry && typeof entry.id === 'string')
  } catch {
    return null
  }
}

function writeIndex(projectRoot: string, entries: SessionIndexEntry[]): void {
  ensureDir(sessionsDir(projectRoot))
  writeFileSync(indexPath(projectRoot), JSON.stringify(entries), 'utf8')
}

function entryFromSession(session: AgentSession): SessionIndexEntry {
  return {
    id: session.id,
    moduleId: session.moduleId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pinned: session.pinned,
    archived: session.archived,
    skillId: session.context.skillId,
    permissions: session.context.permissions
  }
}

function covers(entries: SessionIndexEntry[], files: string[], extraId?: string): boolean {
  const ids = new Set(entries.map((entry) => entry.id))
  if (extraId) ids.add(extraId)
  if (ids.size !== files.length) return false
  return files.every((file) => ids.has(file.slice(0, -5)))
}

function compareSessions(
  a: { pinned?: boolean; archived?: boolean; updatedAt: string },
  b: { pinned?: boolean; archived?: boolean; updatedAt: string }
): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1
  return b.updatedAt.localeCompare(a.updatedAt)
}

function toListSession(entry: SessionIndexEntry): AgentSession {
  return {
    id: entry.id,
    moduleId: entry.moduleId,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    pinned: entry.pinned,
    archived: entry.archived,
    messages: [],
    context: {
      skillId: entry.skillId,
      permissions: entry.permissions
    }
  }
}

function upsertIndex(projectRoot: string, session: AgentSession): void {
  const dir = sessionsDir(projectRoot)
  if (!existsSync(dir)) return
  const files = sessionFiles(dir)
  const current = readIndex(projectRoot)
  if (!current || !covers(current, files, session.id)) return
  writeIndex(projectRoot, [...current.filter((entry) => entry.id !== session.id), entryFromSession(session)])
}

/** Drop tool-result bodies before a session crosses into the renderer. */
export function sessionForRenderer(session: AgentSession): AgentSession {
  if (!session.messages.some((message) => message.role === 'tool' && message.content)) return session
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'tool'
        ? { id: message.id, role: 'tool', content: '', timestamp: message.timestamp }
        : message
    )
  }
}

export async function listSessions(projectRoot: string): Promise<AgentSession[]> {
  const dir = sessionsDir(projectRoot)
  if (!existsSync(dir)) return []
  const files = sessionFiles(dir)
  const indexed = readIndex(projectRoot)
  if (indexed && covers(indexed, files)) {
    return indexed.map(toListSession).sort(compareSessions)
  }
  const loaded: AgentSession[] = []
  for (const file of files) {
    try {
      loaded.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as AgentSession)
    } catch {
      /* skip unreadable session files */
    }
    await yieldTick()
  }
  writeIndex(projectRoot, loaded.map(entryFromSession))
  return loaded.map((session) => toListSession(entryFromSession(session))).sort(compareSessions)
}

export function loadSession(projectRoot: string, id: string): AgentSession | null {
  const file = join(sessionsDir(projectRoot), `${id}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AgentSession
  } catch {
    return null
  }
}

export function saveSession(projectRoot: string, session: AgentSession): void {
  const dir = sessionsDir(projectRoot)
  ensureDir(dir)
  session.updatedAt = new Date().toISOString()
  writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session), 'utf8')
  upsertIndex(projectRoot, session)
}

export function deleteSession(projectRoot: string, id: string): boolean {
  const file = join(sessionsDir(projectRoot), `${id}.json`)
  if (!existsSync(file)) return false
  unlinkSync(file)
  const entries = readIndex(projectRoot)
  if (entries) writeIndex(projectRoot, entries.filter((entry) => entry.id !== id))
  return true
}

export function createSession(
  projectRoot: string,
  moduleId: string,
  title?: string,
  options?: {
    skillId?: string
    permissions?: AgentSession['context']['permissions']
    promptExtras?: string
  }
): AgentSession {
  const now = new Date().toISOString()
  const session: AgentSession = {
    id: newId('ses'),
    moduleId,
    title: title || 'Requirement Analysis',
    createdAt: now,
    updatedAt: now,
    messages: [],
    context: {
      skillId: options?.skillId || 'requirement-discovery',
      permissions: normalizePermissions(options?.permissions),
      promptExtras: options?.promptExtras
    }
  }
  saveSession(projectRoot, session)
  return session
}

export function renameSession(projectRoot: string, id: string, title: string): AgentSession | null {
  const session = loadSession(projectRoot, id)
  if (!session) return null
  session.title = title.trim() || session.title
  saveSession(projectRoot, session)
  return session
}

export function duplicateSession(projectRoot: string, id: string): AgentSession | null {
  const session = loadSession(projectRoot, id)
  if (!session) return null
  const now = new Date().toISOString()
  const copy: AgentSession = {
    ...session,
    id: newId('ses'),
    title: `${session.title} copy`,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false
  }
  saveSession(projectRoot, copy)
  return copy
}

export function forkSession(
  projectRoot: string,
  id: string,
  throughMessageId: string,
  options?: { mode?: SessionBranchMode; title?: string }
): AgentSession | null {
  const session = loadSession(projectRoot, id)
  if (!session) return null
  const copy = forkSessionRecord(session, throughMessageId, options)
  if (!copy) return null
  saveSession(projectRoot, copy)
  return copy
}

export function rewindSession(
  projectRoot: string,
  id: string,
  throughMessageId: string,
  options?: { mode?: SessionBranchMode; exclusive?: boolean }
): AgentSession | null {
  const session = loadSession(projectRoot, id)
  if (!session) return null
  const next = applySessionSlice(session, throughMessageId, options?.mode ?? 'reset', options?.exclusive)
  if (!next) return null
  saveSession(projectRoot, next)
  return next
}

export function setSessionFlag(
  projectRoot: string,
  id: string,
  flag: 'pinned' | 'archived',
  value: boolean
): AgentSession | null {
  const session = loadSession(projectRoot, id)
  if (!session) return null
  session[flag] = value
  saveSession(projectRoot, session)
  return session
}
