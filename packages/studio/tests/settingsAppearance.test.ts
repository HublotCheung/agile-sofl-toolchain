import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  accentForeground,
  accentMixPercent,
  accentTintPercent,
  clampTransparency,
  normalizeHex,
  resolveAccentHex,
  UI_ZOOM_FACTOR
} from '../src/renderer/lib/appearance'
import { parseLlmImport, maskApiKey, parseProfile } from '../src/main/services/llm/profileFormat'

describe('appearance', () => {
  it('clamps transparency and maps mix/tint', () => {
    expect(clampTransparency(-10)).toBe(0)
    expect(clampTransparency(150)).toBe(100)
    expect(clampTransparency(50)).toBe(50)
    expect(accentMixPercent(0)).toBe(100)
    expect(accentMixPercent(50)).toBe(80)
    expect(accentMixPercent(100)).toBe(60)
    expect(accentTintPercent(0)).toBe(16)
    expect(accentTintPercent(50)).toBe(8)
    expect(accentTintPercent(100)).toBe(0)
  })

  it('defaults to blue and accepts custom hex', () => {
    expect(resolveAccentHex('blue', '', false)).toBe(ACCENT_PRESETS.blue.light)
    expect(resolveAccentHex('blue', '', true)).toBe(ACCENT_PRESETS.blue.dark)
    expect(ACCENT_PRESETS.blue).toEqual({ light: '#0c628c', dark: '#8fcfe6' })
    expect(accentForeground('#0c628c')).toBe('#ffffff')
    expect(accentForeground('#8fcfe6')).toBe('#12181d')
    expect(resolveAccentHex('custom', '#abc', true)).toBe('#aabbcc')
    expect(normalizeHex('2563EB')).toBe('#2563eb')
    expect(UI_ZOOM_FACTOR.xlarge).toBeGreaterThan(UI_ZOOM_FACTOR.small)
  })
})

describe('llm profile JSON', () => {
  it('masks keys and parses a single profile', () => {
    expect(maskApiKey('sk-12345678')).toBe('••••5678')
    const one = parseProfile(
      { name: 'ChatECNU', baseUrl: 'https://api.example.com/v1/', apiKey: 'k', model: 'ecnu-max' },
      'id-1'
    )
    expect(one?.baseUrl).toBe('https://api.example.com/v1')
    expect(one?.id).toBe('id-1')
  })

  it('imports a JSON array as append with new ids', () => {
    const result = parseLlmImport([
      { name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'aaa', model: 'm1' },
      { name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'bbb', model: 'm2' }
    ])
    expect(result.mode).toBe('append')
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles[0].id).not.toBe(result.profiles[1].id)
  })

  it('imports a dump object as replace', () => {
    const result = parseLlmImport({
      activeId: 'keep-me',
      profiles: [
        { id: 'keep-me', name: 'Main', baseUrl: 'https://x.example/v1', apiKey: 'secret', model: 'm' }
      ]
    })
    expect(result.mode).toBe('replace')
    expect(result.activeId).toBe('keep-me')
    expect(result.profiles[0].apiKey).toBe('secret')
  })
})
