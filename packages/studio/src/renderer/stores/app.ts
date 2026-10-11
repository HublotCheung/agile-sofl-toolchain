import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { setLocale, type Locale } from '../i18n'

export type ThemeMode = 'light' | 'dark' | 'system'

function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let themeClassReady = false

function applyThemeClass(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
  if (!themeClassReady) {
    themeClassReady = true
    return
  }
  const theme = dark ? 'agile-sofl-dark' : 'agile-sofl-light'
  void import('../monaco/setup').then(({ applyMonacoTheme }) => applyMonacoTheme(theme))
}

const savedTheme = (localStorage.getItem('studio-theme') as ThemeMode | null) ?? 'system'

export const useAppStore = defineStore('app', () => {
  const theme = ref<ThemeMode>(savedTheme)
  const isDark = ref(resolveDark(savedTheme))
  const platform = ref('win32')
  const isMaximized = ref(false)

  function paint(mode: ThemeMode): void {
    const dark = resolveDark(mode)
    isDark.value = dark
    applyThemeClass(dark)
  }

  function setTheme(mode: ThemeMode): void {
    theme.value = mode
    localStorage.setItem('studio-theme', mode)
    paint(mode)
  }

  function setLanguage(locale: Locale): void {
    setLocale(locale)
  }

  async function init(): Promise<void> {
    platform.value = (await window.studio?.getPlatform()) ?? 'win32'
    isMaximized.value = (await window.studio?.isMaximized()) ?? false
    paint(theme.value)

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') paint('system')
    })

    window.studio?.onMaximizedChanged((max) => {
      isMaximized.value = max
    })
  }

  watch(theme, (mode) => paint(mode))

  return { theme, isDark, platform, isMaximized, setTheme, setLanguage, init }
})
