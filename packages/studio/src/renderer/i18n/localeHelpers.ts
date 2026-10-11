export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja'

export const STUDIO_LOCALES = ['zh-CN', 'zh-TW', 'ja', 'en'] as const satisfies readonly Locale[]

export function isStudioLocale(value: string): value is Locale {
  return (STUDIO_LOCALES as readonly string[]).includes(value)
}

/** Backends that only accept Simplified Chinese or English prompts. */
export function localeForZhEnApi(locale: Locale): 'zh-CN' | 'en' {
  if (locale === 'en' || locale === 'ja') return 'en'
  return 'zh-CN'
}

export function useZhAgentCopy(locale: Locale): boolean {
  return locale === 'zh-CN' || locale === 'zh-TW'
}

export function localeForMilkdown(locale: Locale): string {
  switch (locale) {
    case 'zh-CN':
      return 'zh_CN'
    case 'zh-TW':
      return 'zh_TW'
    case 'ja':
      return 'ja_JP'
    default:
      return 'en_US'
  }
}

export function systemLocaleToStudio(sys: string | undefined): Locale {
  const tag = (sys ?? '').replace('_', '-')
  if (tag.startsWith('zh-TW') || tag.startsWith('zh-HK') || tag.startsWith('zh-MO')) return 'zh-TW'
  if (tag.startsWith('zh')) return 'zh-CN'
  if (tag.startsWith('ja')) return 'ja'
  return 'en'
}
