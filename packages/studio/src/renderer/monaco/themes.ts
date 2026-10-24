import type { editor } from 'monaco-editor'
import palettes from '../../../../vscode/scripts/syntax-palettes.json'

type PaletteRule = {
  token: string
  foreground: string
  fontStyle?: string
}

type Palette = {
  editor: { background: string; foreground: string }
  field?: { background: string; foreground: string }
  rules: PaletteRule[]
}

function toMonacoRules(rules: PaletteRule[]): editor.ITokenThemeRule[] {
  return rules.map((r) => ({
    token: r.token,
    foreground: r.foreground,
    ...(r.fontStyle ? { fontStyle: r.fontStyle } : {})
  }))
}

function toMonacoTheme(name: 'vs' | 'vs-dark', palette: Palette): editor.IStandaloneThemeData {
  return {
    base: name,
    inherit: true,
    rules: toMonacoRules(palette.rules),
    colors: {
      'editor.background': palette.editor.background,
      'editor.foreground': palette.editor.foreground
    }
  }
}

function toFieldMonacoTheme(name: 'vs' | 'vs-dark', palette: Palette): editor.IStandaloneThemeData {
  const field = palette.field ?? palette.editor
  return {
    base: name,
    inherit: true,
    rules: toMonacoRules(palette.rules),
    colors: {
      'editor.background': field.background,
      'editor.foreground': field.foreground,
      'editor.lineHighlightBackground': '#00000000',
      'editorWidget.background': field.background
    }
  }
}

const CONTRAST_FG: Record<string, string> = {
  'keyword.control.asfl': '0C628C',
  'keyword.control.system-prefix.asfl': '8A5A10',
  'keyword.control.fsf.asfl': '8A5A10',
  'keyword.declaration.asfl': '0C628C',
  'keyword.modifier.rdwr.asfl': '147A38',
  'keyword.other.informal-marker.asfl': '9E2F2B',
  'keyword.other.fsf.asfl': '147A38',
  'keyword.other.fsf-branch.asfl': '8A5A10',
  'keyword.operator.logical.asfl': '12181D',
  'keyword.operator.comparison.asfl': '12181D',
  'keyword.operator.word.asfl': '12181D',
  'storage.type.asfl': '0C628C',
  'entity.name.namespace.asfl': '0C628C',
  'entity.name.function.asfl': '8A5A10',
  'entity.name.type.asfl': '147A38',
  'entity.name.tag.asfl': '1A242C',
  'variable.parameter.asfl': '1A242C',
  'variable.other.asfl': '1A242C',
  'string.unquoted.informal.asfl': '9E2F2B',
  'string.quoted.double.asfl': '9E2F2B',
  'constant.other.enum.asfl': '8A5A10',
  'constant.numeric': '147A38',
  'constant.language': '0C628C',
  'comment.block.asfl': '3D4C58',
  'meta.fsf.asfl': '12181D',
  'meta.comment.informal.asfl': '9E2F2B'
}

export const CONTRAST_SEMANTIC: Record<string, string> = {
  namespace: '#0C628C',
  function: '#8A5A10',
  method: '#8A5A10',
  type: '#147A38',
  parameter: '#1A242C',
  variable: '#1A242C',
  string: '#9E2F2B',
  keyword: '#0C628C'
}

function contrastPalette(base: Palette): Palette {
  return {
    editor: { background: '#ffffff', foreground: '#12181d' },
    field: { background: '#ffffff', foreground: '#12181d' },
    rules: base.rules.map((rule) =>
      CONTRAST_FG[rule.token] ? { ...rule, foreground: CONTRAST_FG[rule.token] } : rule
    )
  }
}

function contrastChrome(background: string, foreground: string, field: boolean): editor.IColors {
  return {
    'editor.background': background,
    'editor.foreground': foreground,
    'editorLineNumber.foreground': '#3d4c58',
    'editorLineNumber.activeForeground': '#12181d',
    'editorCursor.foreground': '#0c628c',
    'editor.selectionBackground': '#c5dcea',
    'editor.inactiveSelectionBackground': '#d7e6ef',
    'editor.lineHighlightBackground': field ? '#00000000' : '#f4f7f9',
    'editorWidget.background': '#f4f7f9',
    'editorWidget.border': '#8aa0ae',
    'editorError.foreground': '#9e2f2b',
    'editorWarning.foreground': '#8a5a10',
    'editorInfo.foreground': '#0c628c'
  }
}

function toContrastMonacoTheme(palette: Palette, field: boolean): editor.IStandaloneThemeData {
  const face = field ? (palette.field ?? palette.editor) : palette.editor
  return {
    base: 'vs',
    inherit: true,
    rules: toMonacoRules(palette.rules),
    colors: contrastChrome(face.background, face.foreground, field)
  }
}

const contrastSource = contrastPalette(palettes.light as Palette)

export const agileSoflLightTheme = toMonacoTheme('vs', palettes.light as Palette)
export const agileSoflDarkTheme = toMonacoTheme('vs-dark', palettes.dark as Palette)
export const agileSoflContrastTheme = toContrastMonacoTheme(contrastSource, false)
export const agileSoflLightFieldTheme = toFieldMonacoTheme('vs', palettes.light as Palette)
export const agileSoflDarkFieldTheme = toFieldMonacoTheme('vs-dark', palettes.dark as Palette)
export const agileSoflContrastFieldTheme = toContrastMonacoTheme(contrastSource, true)

export type StudioMonacoTheme = 'agile-sofl-light' | 'agile-sofl-dark' | 'agile-sofl-contrast'

export function editorThemeName(isDark: boolean): StudioMonacoTheme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('contrast')) {
    return 'agile-sofl-contrast'
  }
  return isDark ? 'agile-sofl-dark' : 'agile-sofl-light'
}

export function fieldThemeForDarkMode(isDark: boolean): editor.IStandaloneThemeData {
  return isDark ? agileSoflDarkFieldTheme : agileSoflLightFieldTheme
}

export function fieldThemeName(isDark: boolean): string {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('contrast')) {
    return 'agile-sofl-contrast-field'
  }
  return isDark ? 'agile-sofl-dark-field' : 'agile-sofl-light-field'
}

export type MonacoTone = 'light' | 'dark' | 'contrast'

/** LSP semantic token colors aligned with TextMate palette (Monaco uses theme rules for standard types). */
export function semanticTokenRulesForTone(tone: MonacoTone): editor.ITokenThemeRule[] {
  const semantic =
    tone === 'dark'
      ? (palettes.dark.semantic as Record<string, string>)
      : tone === 'contrast'
        ? CONTRAST_SEMANTIC
        : (palettes.light.semantic as Record<string, string>)
  return Object.entries(semantic).map(([token, color]) => ({
    token,
    foreground: color.replace(/^#/, '')
  }))
}

export function semanticTokenRulesForTheme(isDark: boolean): editor.ITokenThemeRule[] {
  return semanticTokenRulesForTone(isDark ? 'dark' : 'light')
}
