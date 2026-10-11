/**
 * Regenerate zh-TW from zh-CN (OpenCC) and ja from en (Google Translate unofficial API).
 * Usage: node scripts/generate-i18n-locales.mjs [--tw-only] [--ja-only]
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as OpenCC from 'opencc-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'i18n')
const twOnly = process.argv.includes('--tw-only')
const jaOnly = process.argv.includes('--ja-only')

/** @param {Record<string, string>} messages @param {Record<string, string>} keyOrderSource */
function orderMessages(messages, keyOrderSource) {
  const ordered = {}
  for (const key of Object.keys(keyOrderSource)) {
    if (messages[key] !== undefined) ordered[key] = messages[key]
  }
  for (const [key, value] of Object.entries(messages)) {
    if (!(key in ordered)) ordered[key] = value
  }
  return ordered
}

/** @param {string} text */
function shouldSkipTranslate(text) {
  if (!text || !text.trim()) return true
  if (/^[\d\s#:./\\\-_{}<>|&]+$/.test(text)) return true
  return false
}

async function generateZhTw() {
  const zhCN = JSON.parse(readFileSync(join(root, 'zh-CN.json'), 'utf8'))
  const converter = OpenCC.Converter({ from: 'cn', to: 'tw' })
  /** @type {Record<string, string>} */
  const zhTW = {}
  for (const [key, value] of Object.entries(zhCN)) {
    zhTW[key] = typeof value === 'string' ? converter(value) : value
  }
  zhTW['menu.view.languageZh'] = '简体中文'
  zhTW['menu.view.languageZhTW'] = '繁體中文'
  zhTW['menu.view.languageJa'] = '日本語'
  zhTW['menu.view.languageEn'] = 'English'
  zhTW['settings.languageZh'] = '简体中文'
  zhTW['settings.languageZhTW'] = '繁體中文'
  zhTW['settings.languageJa'] = '日本語'
  zhTW['settings.languageEn'] = 'English'
  const en = JSON.parse(readFileSync(join(root, 'en.json'), 'utf8'))
  writeFileSync(
    join(root, 'zh-TW.json'),
    `${JSON.stringify(orderMessages(zhTW, en), null, 2)}\n`,
    'utf8'
  )
  console.log('Wrote zh-TW.json', Object.keys(zhTW).length, 'keys')
}

async function generateJa() {
  const en = JSON.parse(readFileSync(join(root, 'en.json'), 'utf8'))
  const { translate } = await import('@vitalets/google-translate-api')
  /** @type {Record<string, string>} */
  const ja = {}
  const entries = Object.entries(en)
  const batchSize = 40
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async ([key, value]) => {
        if (typeof value !== 'string') {
          ja[key] = value
          return
        }
        if (shouldSkipTranslate(value)) {
          ja[key] = value
          return
        }
        try {
          const res = await translate(value, { from: 'en', to: 'ja' })
          ja[key] = res.text
        } catch (err) {
          console.warn('translate failed', key, err.message)
          ja[key] = value
        }
      })
    )
    console.log(`ja progress ${Math.min(i + batchSize, entries.length)}/${entries.length}`)
    await new Promise((r) => setTimeout(r, 800))
  }
  ja['menu.view.languageZh'] = '简体中文'
  ja['menu.view.languageZhTW'] = '繁體中文'
  ja['menu.view.languageJa'] = '日本語'
  ja['menu.view.languageEn'] = 'English'
  ja['settings.languageZh'] = '简体中文'
  ja['settings.languageZhTW'] = '繁體中文'
  ja['settings.languageJa'] = '日本語'
  ja['settings.languageEn'] = 'English'
  writeFileSync(
    join(root, 'ja.json'),
    `${JSON.stringify(orderMessages(ja, en), null, 2)}\n`,
    'utf8'
  )
  console.log('Wrote ja.json', Object.keys(ja).length, 'keys')
}

if (!jaOnly) await generateZhTw()
if (!twOnly) await generateJa()
