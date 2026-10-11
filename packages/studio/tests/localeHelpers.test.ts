import { describe, expect, it } from 'vitest'
import {
  isStudioLocale,
  localeForMilkdown,
  localeForZhEnApi,
  systemLocaleToStudio,
  useZhAgentCopy
} from '../src/renderer/i18n/localeHelpers'

describe('localeHelpers', () => {
  it('recognizes studio locales', () => {
    expect(isStudioLocale('ja')).toBe(true)
    expect(isStudioLocale('zh-TW')).toBe(true)
    expect(isStudioLocale('fr')).toBe(false)
  })

  it('maps system locale tags', () => {
    expect(systemLocaleToStudio('zh-TW')).toBe('zh-TW')
    expect(systemLocaleToStudio('zh-HK')).toBe('zh-TW')
    expect(systemLocaleToStudio('zh-CN')).toBe('zh-CN')
    expect(systemLocaleToStudio('ja-JP')).toBe('ja')
    expect(systemLocaleToStudio('en-US')).toBe('en')
  })

  it('maps agent and editor locale helpers', () => {
    expect(useZhAgentCopy('zh-TW')).toBe(true)
    expect(useZhAgentCopy('ja')).toBe(false)
    expect(localeForZhEnApi('zh-TW')).toBe('zh-CN')
    expect(localeForZhEnApi('ja')).toBe('en')
    expect(localeForMilkdown('zh-TW')).toBe('zh_TW')
    expect(localeForMilkdown('ja')).toBe('ja_JP')
  })
})
