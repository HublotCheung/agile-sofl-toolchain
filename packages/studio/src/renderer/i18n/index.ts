import { createI18n } from 'vue-i18n'
import { initMonacoNlsFromStudioLocale } from '../monaco/nls'
import en from './en.json'
import ja from './ja.json'
import zhCN from './zh-CN.json'
import zhTW from './zh-TW.json'
import { isStudioLocale, systemLocaleToStudio, type Locale } from './localeHelpers'

export type { Locale }
export { isStudioLocale, localeForMilkdown, localeForZhEnApi, useZhAgentCopy, systemLocaleToStudio } from './localeHelpers'

const rawSaved = localStorage.getItem('studio-locale')
const saved = rawSaved && isStudioLocale(rawSaved) ? rawSaved : null

export const i18n = createI18n({
  legacy: false,
  locale: saved ?? 'zh-CN',
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja }
})

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  localStorage.setItem('studio-locale', locale)
  initMonacoNlsFromStudioLocale(locale)
}

export async function initLocaleFromSystem(): Promise<void> {
  if (saved) return
  const sys = await window.studio?.getLocale()
  setLocale(systemLocaleToStudio(sys))
}
