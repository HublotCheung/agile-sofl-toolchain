export type ThemeMode = 'light' | 'dark' | 'system' | 'contrast'

export type MonacoThemeId = 'agile-sofl-light' | 'agile-sofl-dark' | 'agile-sofl-contrast'

export const THEME_STORAGE_KEY = 'studio-theme'

export type ThemeRoot = {
  classList: {
    toggle: (token: string, force?: boolean) => boolean
    contains: (token: string) => boolean
  }
  dataset: { theme?: string }
}

export function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' || value === 'contrast'
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> = localStorage): ThemeMode {
  const raw = storage.getItem(THEME_STORAGE_KEY)
  return isThemeMode(raw) ? raw : 'system'
}

export function persistTheme(mode: ThemeMode, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(THEME_STORAGE_KEY, mode)
}

/** Contrast is a light palette. System follows the OS scheme. */
export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  if (mode === 'dark') return true
  if (mode === 'light' || mode === 'contrast') return false
  return prefersDark
}

export function monacoThemeId(mode: ThemeMode, prefersDark: boolean): MonacoThemeId {
  if (mode === 'contrast') return 'agile-sofl-contrast'
  if (resolveDark(mode, prefersDark)) return 'agile-sofl-dark'
  return 'agile-sofl-light'
}

/** Toggle `dark` / `contrast` and record the selected theme id on `data-theme`. */
export function applyThemeMode(mode: ThemeMode, root: ThemeRoot, prefersDark: boolean): boolean {
  const dark = resolveDark(mode, prefersDark)
  root.classList.toggle('dark', dark)
  root.classList.toggle('contrast', mode === 'contrast')
  root.dataset.theme = mode
  return dark
}
