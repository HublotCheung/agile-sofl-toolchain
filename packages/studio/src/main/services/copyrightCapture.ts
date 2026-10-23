import { app, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drives a fresh Studio window and writes PNG screenshots for the copyright manual.
 * Enabled only when STUDIO_CAPTURE=1.
 */
export async function runCopyrightCapture(win: BrowserWindow): Promise<void> {
  const outDir = process.env.STUDIO_CAPTURE_DIR
  const samplePath = process.env.STUDIO_CAPTURE_SAMPLE
  if (!outDir || !samplePath) {
    throw new Error('STUDIO_CAPTURE_DIR and STUDIO_CAPTURE_SAMPLE are required')
  }
  mkdirSync(outDir, { recursive: true })
  const source = readFileSync(samplePath, 'utf8')
  const log: string[] = []
  const note = (message: string) => {
    log.push(message)
    console.log(`[copyright-capture] ${message}`)
  }

  const ev = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>

  const shot = async (name: string) => {
    win.show()
    win.focus()
    await sleep(900)
    const image = await win.capturePage()
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, image.toPNG())
    note(`saved ${file}`)
  }

  const clickExact = (label: string) =>
    ev<boolean>(`(() => {
      const nodes = [...document.querySelectorAll('button, [role="menuitem"], a')]
      const el = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})
      if (!el) return false
      el.click()
      return true
    })()`)

  const waitFor = async (label: string, timeoutMs = 25000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const found = await ev<boolean>(
        `document.body && document.body.innerText.includes(${JSON.stringify(label)})`
      )
      if (found) return
      await sleep(300)
    }
    throw new Error(`timed out waiting for: ${label}`)
  }

  try {
    note('waiting for first-run dialog')
    await waitFor('Agile-SOFL Studio', 30000)
    await ev<void>(`(() => {
      const sel = document.querySelector('select')
      if (!sel) return
      sel.value = 'zh-CN'
      sel.dispatchEvent(new Event('change'))
    })()`)
    await sleep(400)
    if (!(await clickExact('浅色'))) note('light theme button not found, continuing')
    await sleep(300)
    await shot('01-first-run')
    if (!(await clickExact('暂不配置 AI'))) {
      throw new Error('could not skip onboarding')
    }
    await waitFor('最近打开', 20000)
    await ev<void>(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const pinia = app.config.globalProperties.$pinia
      const ui = pinia._s.get('app')
      ui.setLanguage('zh-CN')
      ui.setTheme('light')
    })()`)
    await sleep(600)
    await shot('02-home')

    if (await clickExact('从模板新建')) {
      const dialogStart = Date.now()
      let dialogOpen = false
      while (Date.now() - dialogStart < 8000) {
        dialogOpen = await ev<boolean>(`!!document.querySelector('[role="dialog"]')`)
        if (dialogOpen) break
        await sleep(200)
      }
      if (dialogOpen) {
        await sleep(700)
        await shot('03-template-dialog')
        const closed = await ev<boolean>(`(() => {
          const dialog = document.querySelector('[role="dialog"]')
          const btn = dialog && [...dialog.querySelectorAll('button')].find((n) => (n.textContent || '').trim() === '取消')
          if (!btn) return false
          btn.click()
          return true
        })()`)
        if (!closed) note('template cancel not found')
        await sleep(400)
      } else {
        note('template dialog did not open')
      }
    } else {
      note('template button not found')
    }

    await ev<void>(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const pinia = app.config.globalProperties.$pinia
      const doc = pinia._s.get('document')
      const editorUi = pinia._s.get('editorUi')
      doc.openFromFile(${JSON.stringify(samplePath)}, ${JSON.stringify(source)}, 'library-system.asfl')
      editorUi.setViewMode('split')
    })()`)
    await waitFor('library-system.asfl', 15000)
    const monacoStart = Date.now()
    while (Date.now() - monacoStart < 20000) {
      const ready = await ev<boolean>(`!!document.querySelector('.monaco-editor')`)
      if (ready) break
      await sleep(300)
    }
    await sleep(2200)
    await shot('04-split-editor')

    await ev<void>(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editorUi').setViewMode('code')`)
    await sleep(800)
    await shot('05-code-editor')

    await ev<void>(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editorUi').setViewMode('visual')`)
    await sleep(1500)
    await shot('06-visual-editor')

    if (await clickExact('关系图')) {
      await sleep(1800)
      await shot('07-module-graph')
    } else {
      note('graph button not found')
    }

    await ev<void>(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').show()`)
    await waitFor('外观', 10000)
    await sleep(400)
    await shot('08-settings')
    await ev<boolean>(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-label') === '设置')
      const close = dialog?.querySelector('button[aria-label="关闭"]')
      if (close) close.click()
      const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')
      settings.hide()
      settings.open = false
      return true
    })()`)
    const settingsGone = Date.now()
    while (Date.now() - settingsGone < 5000) {
      const stillOpen = await ev<boolean>(
        `!![...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-label') === '设置')`
      )
      if (!stillOpen) break
      await sleep(200)
    }

    await ev<void>(`(() => {
      const modal = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('modal')
      void modal.show({
        title: '关于 Agile-SOFL Studio',
        message: 'Agile-SOFL Studio v0.1.0\\n用于 .asfl 规格的 Electron 可视化编辑器。',
        buttons: ['确定']
      })
    })()`)
    await waitFor('Electron 可视化编辑器', 8000)
    await shot('09-about')
    await ev<void>(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('modal').respond(0)`)

    writeFileSync(join(outDir, 'capture-log.txt'), log.join('\n'), 'utf8')
    note('done')
    app.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    try {
      await shot('99-capture-failed')
    } catch {
      /* window may already be gone */
    }
    writeFileSync(join(outDir, 'capture-error.txt'), `${message}\n\n${log.join('\n')}`, 'utf8')
    console.error(message)
    app.exit(1)
  }
}
