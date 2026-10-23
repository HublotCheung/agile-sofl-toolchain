import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { getEnvLlmFallback } from './env'
import {
  dumpLlmProfiles,
  newProfileId,
  normalizeBaseUrl,
  parseLlmImport,
  profileHasKey,
  resolveActiveProfile,
  savedProfileBecomesActive,
  toPublicProfile,
  type LlmProfile,
  type LlmProfilePublic,
  type LlmStoreFile
} from './profileFormat'

const TEST_TIMEOUT_MS = 15_000

function storePath(): string {
  return join(app.getPath('userData'), 'llm-profiles.json')
}

function envFallback(): LlmProfile {
  const env = getEnvLlmFallback()
  return {
    id: 'env-default',
    name: 'ChatECNU',
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: env.model
  }
}

function emptyStore(): LlmStoreFile {
  return { activeId: null, profiles: [] }
}

function readStore(): LlmStoreFile {
  const file = storePath()
  if (!existsSync(file)) {
    const seeded = envFallback()
    if (!seeded.apiKey && !seeded.baseUrl) return emptyStore()
    const next: LlmStoreFile = { activeId: seeded.apiKey ? seeded.id : null, profiles: [seeded] }
    writeStore(next)
    return next
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LlmStoreFile
    if (!parsed || !Array.isArray(parsed.profiles)) return emptyStore()
    return {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      profiles: parsed.profiles.filter((p) => p && typeof p.id === 'string')
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: LlmStoreFile): void {
  const file = storePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, dumpLlmProfiles(store), 'utf8')
}

export function listLlmProfiles(): { activeId: string | null; profiles: LlmProfilePublic[] } {
  const store = readStore()
  return {
    activeId: store.activeId,
    profiles: store.profiles.map((p) => toPublicProfile(p, store.activeId))
  }
}

export function getActiveLlmConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  const active = resolveActiveProfile(readStore())
  if (!profileHasKey(active)) return null
  return {
    apiKey: active.apiKey.trim(),
    baseUrl: normalizeBaseUrl(active.baseUrl) || envFallback().baseUrl,
    model: active.model.trim() || 'ecnu-max'
  }
}

export function getEcnuConfig(): { apiKey: string; baseUrl: string; model: string } {
  return getActiveLlmConfig() ?? getEnvLlmFallback()
}

export type LlmProfileDraft = {
  id?: string
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  activate?: boolean
}

export function saveLlmProfile(draft: LlmProfileDraft): {
  activeId: string | null
  savedId: string
  profiles: LlmProfilePublic[]
} {
  const store = readStore()
  const existing = draft.id ? store.profiles.find((p) => p.id === draft.id) : undefined
  const id = existing?.id ?? newProfileId()
  const activeBefore = store.activeId
    ? store.profiles.find((p) => p.id === store.activeId)
    : undefined
  const next: LlmProfile = {
    id,
    name: (draft.name ?? existing?.name ?? '').trim() || (draft.model ?? existing?.model ?? 'LLM'),
    baseUrl: normalizeBaseUrl(draft.baseUrl ?? existing?.baseUrl ?? ''),
    apiKey:
      draft.apiKey != null && draft.apiKey !== ''
        ? draft.apiKey
        : (existing?.apiKey ?? ''),
    model: (draft.model ?? existing?.model ?? '').trim()
  }
  if (existing) {
    store.profiles = store.profiles.map((p) => (p.id === id ? next : p))
  } else {
    store.profiles = [...store.profiles, next]
  }
  if (
    savedProfileBecomesActive({
      requested: Boolean(draft.activate),
      activeHasKey: profileHasKey(activeBefore),
      savedHasKey: profileHasKey(next)
    })
  ) {
    store.activeId = id
  }
  writeStore(store)
  return { ...listLlmProfiles(), savedId: id }
}

export function deleteLlmProfile(id: string): { activeId: string | null; profiles: LlmProfilePublic[] } {
  const store = readStore()
  store.profiles = store.profiles.filter((p) => p.id !== id)
  if (store.activeId === id) store.activeId = store.profiles[0]?.id ?? null
  writeStore(store)
  return listLlmProfiles()
}

export function setActiveLlmProfile(id: string): { activeId: string | null; profiles: LlmProfilePublic[] } {
  const store = readStore()
  if (!store.profiles.some((p) => p.id === id)) throw new Error('Unknown LLM profile')
  store.activeId = id
  writeStore(store)
  return listLlmProfiles()
}

export function exportLlmProfiles(): string {
  return dumpLlmProfiles(readStore())
}

export function importLlmProfiles(raw: unknown): { activeId: string | null; profiles: LlmProfilePublic[] } {
  const parsed = parseLlmImport(raw)
  const store = readStore()
  if (parsed.mode === 'replace') {
    store.profiles = parsed.profiles
    store.activeId =
      parsed.activeId && parsed.profiles.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : parsed.profiles[0]?.id ?? null
  } else {
    store.profiles = [...store.profiles, ...parsed.profiles]
    if (!store.activeId && parsed.profiles[0]) store.activeId = parsed.profiles[0].id
  }
  writeStore(store)
  return listLlmProfiles()
}

export type LlmTestKind = 'connectivity' | 'params'

export type LlmTestRequest = {
  kind: LlmTestKind
  profileId?: string
  draft?: { baseUrl?: string; apiKey?: string; model?: string }
}

export type LlmTestResult = {
  ok: boolean
  message: string
  ms: number
  detail?: string
}

function resolveTestConfig(request: LlmTestRequest): { apiKey: string; baseUrl: string; model: string } {
  const store = readStore()
  const existing = request.profileId ? store.profiles.find((p) => p.id === request.profileId) : undefined
  const apiKey =
    request.draft?.apiKey && request.draft.apiKey.trim()
      ? request.draft.apiKey.trim()
      : (existing?.apiKey.trim() ?? '')
  const baseUrl = normalizeBaseUrl(request.draft?.baseUrl || existing?.baseUrl || '')
  const model = (request.draft?.model || existing?.model || '').trim()
  return { apiKey, baseUrl, model }
}

async function pingModels(cfg: { baseUrl: string; apiKey: string }): Promise<LlmTestResult> {
  const started = Date.now()
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
  })
  const ms = Date.now() - started
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status}`, ms, detail: text.slice(0, 240) }
  }
  let count: number | undefined
  try {
    const json = JSON.parse(text) as { data?: unknown[] }
    if (Array.isArray(json.data)) count = json.data.length
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    message: count != null ? `OK · ${count} models` : `OK · HTTP ${res.status}`,
    ms
  }
}

async function pingChat(cfg: { baseUrl: string; apiKey: string; model: string }): Promise<LlmTestResult> {
  const started = Date.now()
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
      thinking: { type: 'disabled' }
    }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
  })
  const ms = Date.now() - started
  const text = await res.text()
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status}`, ms, detail: text.slice(0, 240) }
  }
  let snippet = text.slice(0, 160)
  try {
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    snippet = json.choices?.[0]?.message?.content?.trim() || snippet
  } catch {
    /* ignore */
  }
  return { ok: true, message: `OK · ${ms}ms`, ms, detail: snippet }
}

export async function testLlmProfile(request: LlmTestRequest): Promise<LlmTestResult> {
  const cfg = resolveTestConfig(request)
  if (!cfg.baseUrl) return { ok: false, message: 'Missing base URL', ms: 0 }
  if (!cfg.apiKey) return { ok: false, message: 'Missing API key', ms: 0 }
  if (request.kind === 'params' && !cfg.model) return { ok: false, message: 'Missing model name', ms: 0 }
  try {
    if (request.kind === 'params') return await pingChat(cfg)
    try {
      const models = await pingModels(cfg)
      if (models.ok) return models
      if (models.message.includes('HTTP 404') || models.message.includes('HTTP 405')) {
        if (!cfg.model) return models
        return await pingChat(cfg)
      }
      return models
    } catch {
      if (!cfg.model) throw new Error('Connectivity test failed')
      return await pingChat(cfg)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, ms: 0 }
  }
}
