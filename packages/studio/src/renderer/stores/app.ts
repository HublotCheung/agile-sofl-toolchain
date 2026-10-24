import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { setLocale, type Locale } from '../i18n'
import {
  applyThemeMode,
  monacoThemeId,
  persistTheme,
  readStoredTheme,
  resolveDark,
  type ThemeMode
} from '../lib/themeMode'

export type { ThemeMode }

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let themeClassReady = false

function applyThemeClass(mode: ThemeMode): boolean {
  const dark = applyThemeMode(mode, document.documentElement, prefersDark())
  if (!themeClassReady) {
    themeClassReady = true
    return dark
  }
  const theme = monacoThemeId(mode, prefersDark())
  void import('../monaco/setup').then(({ applyMonacoTheme }) => applyMonacoTheme(theme))
  return dark
}

const savedTheme = readStoredTheme()

export const useAppStore = defineStore('app', () => {
  const theme = ref<ThemeMode>(savedTheme)
  const isDark = ref(resolveDark(savedTheme, prefersDark()))
  const platform = ref('win32')
  const isMaximized = ref(false)

  function paint(mode: ThemeMode): void {
    isDark.value = applyThemeClass(mode)
  }

  function setTheme(mode: ThemeMode): void {
    theme.value = mode
    persistTheme(mode)
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
