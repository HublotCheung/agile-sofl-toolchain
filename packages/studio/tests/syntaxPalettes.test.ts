import { describe, it, expect } from 'vitest'
import { agileSoflContrastTheme, agileSoflLightTheme, agileSoflDarkTheme } from '../src/renderer/monaco/themes'

function ruleFg(rules: { token: string; foreground?: string }[], token: string): string | undefined {
  return rules.find((r) => r.token === token)?.foreground
}

describe('Monaco syntax palettes', () => {
  it('light theme uses readable operator color on white background', () => {
    expect(ruleFg(agileSoflLightTheme.rules, 'keyword.operator.logical.asfl')).toBe('333333')
  })

  it('dark theme keeps pale operator color', () => {
    expect(ruleFg(agileSoflDarkTheme.rules, 'keyword.operator.logical.asfl')).toBe('D4D4D4')
  })

  it('contrast theme stays on a light surface in the mock palette', () => {
    expect(agileSoflContrastTheme.base).toBe('vs')
    expect(agileSoflContrastTheme.colors['editor.background']).toBe('#ffffff')
    expect(agileSoflContrastTheme.colors['editor.foreground']).toBe('#12181d')
    expect(ruleFg(agileSoflContrastTheme.rules, 'keyword.declaration.asfl')).toBe('0C628C')
    expect(ruleFg(agileSoflContrastTheme.rules, 'keyword.operator.logical.asfl')).toBe('12181D')
  })
})
