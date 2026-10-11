import zhHans from 'monaco-editor-nls-adapter/locales/zh-hans.json'
import type { Locale } from '../i18n'

export type MonacoNlsLocale = 'zh-hans' | 'en'

type NlsAdapterState = { data: Record<string, unknown> | null; name: string }

declare global {
  // eslint-disable-next-line no-var
  var __MONACO_NLS_ADAPTER_STATE__: NlsAdapterState | undefined
  // eslint-disable-next-line no-var
  var _VSCODE_NLS_LANGUAGE: string | undefined
  // eslint-disable-next-line no-var
  var _VSCODE_NLS_MESSAGES: string[] | undefined
}

let configured = false

export function studioLocaleToMonacoNls(locale: Locale): MonacoNlsLocale {
  return locale === 'zh-CN' || locale === 'zh-TW' ? 'zh-hans' : 'en'
}

/** Must run before any `monaco-editor` module is evaluated. */
export function initMonacoNls(locale: MonacoNlsLocale): void {
  globalThis.__MONACO_NLS_ADAPTER_STATE__ = {
    data: locale === 'zh-hans' ? (zhHans as Record<string, unknown>) : {},
    name: locale
  }
  globalThis._VSCODE_NLS_LANGUAGE = locale
  globalThis._VSCODE_NLS_MESSAGES = globalThis._VSCODE_NLS_MESSAGES || []
  configured = true
}

export function initMonacoNlsFromStudioLocale(locale: Locale): void {
  initMonacoNls(studioLocaleToMonacoNls(locale))
}

export function isMonacoNlsConfigured(): boolean {
  return configured
}
