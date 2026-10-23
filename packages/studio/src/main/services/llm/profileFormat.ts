export type LlmProfile = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

export type LlmProfilePublic = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  hasKey: boolean
  active: boolean
}

export type LlmStoreFile = {
  activeId: string | null
  profiles: LlmProfile[]
}

export type LlmImportResult = {
  mode: 'append' | 'replace'
  profiles: LlmProfile[]
  activeId?: string | null
}

export function newProfileId(): string {
  return `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

export function toPublicProfile(profile: LlmProfile, activeId: string | null): LlmProfilePublic {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKeyMasked: maskApiKey(profile.apiKey),
    hasKey: Boolean(profile.apiKey.trim()),
    active: profile.id === activeId
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseProfile(raw: unknown, fallbackId: string): LlmProfile | null {
  const object = asRecord(raw)
  if (!object) return null
  const baseUrl = typeof object.baseUrl === 'string' ? normalizeBaseUrl(object.baseUrl) : ''
  const apiKey = typeof object.apiKey === 'string' ? object.apiKey : ''
  const model = typeof object.model === 'string' ? object.model.trim() : ''
  const nameRaw = typeof object.name === 'string' ? object.name.trim() : ''
  if (!baseUrl && !model && !apiKey && !nameRaw) return null
  const id =
    typeof object.id === 'string' && object.id.trim() ? object.id.trim() : fallbackId
  return {
    id,
    name: nameRaw || model || 'LLM',
    baseUrl,
    apiKey,
    model
  }
}

export function parseLlmImport(raw: unknown): LlmImportResult {
  let value = raw
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) throw new Error('Empty JSON')
    value = JSON.parse(trimmed) as unknown
  }
  if (Array.isArray(value)) {
    const profiles = value
      .map((item) => parseProfile(item, newProfileId()))
      .filter((item): item is LlmProfile => Boolean(item))
      .map((item) => ({ ...item, id: newProfileId() }))
    if (!profiles.length) throw new Error('No LLM profiles in JSON array')
    return { mode: 'append', profiles }
  }
  const object = asRecord(value)
  if (object && Array.isArray(object.profiles)) {
    const profiles = object.profiles
      .map((item, index) => parseProfile(item, `llm-import-${index}`))
      .filter((item): item is LlmProfile => Boolean(item))
    if (!profiles.length) throw new Error('No LLM profiles in dump')
    const seen = new Set<string>()
    for (const profile of profiles) {
      if (seen.has(profile.id)) profile.id = newProfileId()
      seen.add(profile.id)
    }
    const activeId = typeof object.activeId === 'string' || object.activeId === null ? object.activeId : undefined
    return { mode: 'replace', profiles, activeId }
  }
  const one = parseProfile(value, newProfileId())
  if (one) return { mode: 'append', profiles: [{ ...one, id: newProfileId() }] }
  throw new Error('Invalid LLM profile JSON')
}

export function dumpLlmProfiles(store: LlmStoreFile): string {
  return JSON.stringify({ activeId: store.activeId, profiles: store.profiles }, null, 2)
}

export function profileHasKey(profile: LlmProfile | null | undefined): boolean {
  return Boolean(profile?.apiKey?.trim())
}

/**
 * Saving a profile with a key should take over when nothing usable is active.
 * An explicit activate request still wins, including switching between keyed profiles.
 */
export function savedProfileBecomesActive(options: {
  requested: boolean
  activeHasKey: boolean
  savedHasKey: boolean
}): boolean {
  return options.requested || (!options.activeHasKey && options.savedHasKey)
}

export function resolveActiveProfile(store: LlmStoreFile): LlmProfile | null {
  const active = store.activeId
    ? (store.profiles.find((p) => p.id === store.activeId) ?? null)
    : null
  if (profileHasKey(active)) return active
  return store.profiles.find((p) => profileHasKey(p)) ?? active ?? store.profiles[0] ?? null
}
