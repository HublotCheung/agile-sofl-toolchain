import { describe, expect, it } from 'vitest'
import {
  applyThemeMode,
  monacoThemeId,
  persistTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
  type ThemeRoot
} from '../src/renderer/lib/themeMode'

function fakeRoot(): ThemeRoot & { classes: Set<string> } {
  const classes = new Set<string>()
  const dataset: { theme?: string } = {}
  return {
    classes,
    dataset,
    classList: {
      toggle(token: string, force?: boolean) {
        const on = force ?? !classes.has(token)
        if (on) classes.add(token)
        else classes.delete(token)
        return on
      },
      contains(token: string) {
        return classes.has(token)
      }
    }
  }
}

describe('theme mode', () => {
  it('persists contrast and marks the root', () => {
    persistTheme('contrast')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('contrast')
    expect(readStoredTheme()).toBe('contrast')

    const root = fakeRoot()
    root.classList.toggle('dark', true)
    applyThemeMode('contrast', root, true)
    expect(root.classList.contains('contrast')).toBe(true)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.dataset.theme).toBe('contrast')
    expect(monacoThemeId('contrast', true)).toBe('agile-sofl-contrast')
  })

  it('keeps light and dark on their own classes', () => {
    const root = fakeRoot()
    applyThemeMode('contrast', root, false)
    applyThemeMode('light', root, true)
    expect(root.classList.contains('contrast')).toBe(false)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.dataset.theme).toBe('light')
    expect(monacoThemeId('light', true)).toBe('agile-sofl-light')

    persistTheme('dark')
    applyThemeMode(readStoredTheme(), root, false)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('contrast')).toBe(false)
    expect(root.dataset.theme).toBe('dark')
    expect(monacoThemeId('dark', false)).toBe('agile-sofl-dark')
  })

  it('lets system follow the OS scheme without the contrast class', () => {
    const root = fakeRoot()
    applyThemeMode('system', root, true)
    expect(root.dataset.theme).toBe('system')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('contrast')).toBe(false)
    expect(monacoThemeId('system', false)).toBe('agile-sofl-light')
    expect(readStoredTheme()).toBe('system')
  })
})
