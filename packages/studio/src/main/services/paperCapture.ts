import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Opens a real project in English and light mode and writes window screenshots.
 * Enabled when STUDIO_CAPTURE=1 and STUDIO_CAPTURE_KIND=paper.
 * STUDIO_CAPTURE_PROJECT is the project folder. STUDIO_CAPTURE_DIR receives the PNGs.
 */
export async function runPaperCapture(win: BrowserWindow): Promise<void> {
  const outDir = process.env.STUDIO_CAPTURE_DIR
  const projectPath = process.env.STUDIO_CAPTURE_PROJECT
  if (!outDir || !projectPath) {
    throw new Error('STUDIO_CAPTURE_DIR and STUDIO_CAPTURE_PROJECT are required')
  }
  mkdirSync(outDir, { recursive: true })
  const log: string[] = []
  const note = (message: string) => {
    log.push(message)
    console.log(`[paper-capture] ${message}`)
  }
  const ev = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>

  const scrubPaths = () =>
    ev<void>(`(() => {
      const reps = [
        ['D:\\\\asfl\\\\DAM', 'Project-DAM'],
        ['D:/asfl/DAM', 'Project-DAM']
      ]
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        let value = node.nodeValue || ''
        for (const pair of reps) {
          if (value.includes(pair[0])) value = value.split(pair[0]).join(pair[1])
        }
        if (value !== node.nodeValue) node.nodeValue = value
      }
    })()`)

  const shot = async (name: string) => {
    win.show()
    win.focus()
    await sleep(900)
    await scrubPaths()
    await sleep(200)
    const image = await win.capturePage()
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, image.toPNG())
    note(`saved ${file}`)
  }

  const waitFor = async (label: string, timeoutMs = 30000) => {
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

  const clickIncludes = (fragment: string) =>
    ev<boolean>(`(() => {
      const nodes = [...document.querySelectorAll('button, [role="menuitem"], a')]
      const el = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, ' ').includes(${JSON.stringify(fragment)}))
      if (!el) return false
      el.click()
      return true
    })()`)

  const pinia = (call: string) =>
    ev<void>(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const pinia = app.config.globalProperties.$pinia
      ${call}
    })()`)

  try {
    note(`project ${projectPath}`)
    await waitFor('Agile-SOFL Studio', 40000)
    await pinia(`pinia._s.get('app').setLanguage('en'); pinia._s.get('app').setTheme('light')`)
    await sleep(600)
    if (await clickIncludes('Continue without AI setup')) {
      note('skipped AI setup')
    } else if (await clickIncludes('暂不配置')) {
      note('skipped AI setup from the Chinese label')
      await pinia(`pinia._s.get('app').setLanguage('en'); pinia._s.get('app').setTheme('light')`)
    } else {
      note('no onboarding skip button; continuing')
    }
    await waitFor('New from Template', 25000).catch(async () => {
      const text = await ev<string>(`(document.body.innerText || '').slice(0, 240)`)
      note(`home not shown; visible text: ${text.replace(/\s+/g, ' ')}`)
    })

    const opened = await ev<string>(`(async () => {
      const opened = await window.studio.projectOpenPath(${JSON.stringify(projectPath)})
      if (!opened) return 'open-failed'
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const ws = pinia._s.get('workspace')
      await ws.refreshProjects()
      const project = ws.projects.find((p) => p.rootPath === opened.root) || opened.project
      await ws.activateProject(project, { skipConfirm: true })
      ws.setInformalCollapsed(false)
      ws.setStructureCollapsed(false)
      ws.setColumnWidths([0.2, 0.58, 0.22])
      ws.setFullscreenPanel(null)
      const moduleName = (ws.modules || []).find((m) => m && !m.isGui && !String(m.name || '').startsWith('GUI'))
      if (moduleName) ws.selectModule(moduleName.name)
      ws.hybridMode = 'refine'
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)
      const main = document.querySelector('main')
      return 'hasWorkspace=' + ws.hasWorkspace
        + ' modules=' + (ws.modules || []).length
        + ' mainLen=' + ((main && main.innerHTML) || '').length
        + ' informal=' + (document.body.textContent || '').includes('Informal Specification')
        + ' text=' + text
    })()`)
    note(`after open: ${opened.replace(/\s+/g, ' ').slice(0, 500)}`)
    if (opened === 'open-failed') throw new Error('projectOpenPath returned null')
    const imported = await ev<string>(`(async () => {
      const started = Date.now()
      try {
        await Promise.race([
          import('/components/workspace/WorkspaceLayout.vue'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('import timeout')), 120000))
        ])
        return 'imported ' + (Date.now() - started) + 'ms'
      } catch (err) {
        const message = err && err.message ? err.message : String(err)
        return 'import failed ' + (Date.now() - started) + 'ms ' + message.slice(0, 400)
      }
    })()`)
    note(imported)
    await waitFor('Informal Specification', 180000)
    await waitFor('Process refinement', 20000)
    await pinia(`
      const settings = pinia._s.get('settings')
      const ws = pinia._s.get('workspace')
      settings.setWorkspaceSplitRatio([], 0.22)
      ws.setStructureCollapsed(false)
      ws.setInformalCollapsed(false)
      ws.setColumnWidths([0.18, 0.6, 0.22])
      ws.hybridMode = 'refine'
    `)
    await sleep(900)
    await shot('01-refinement')

    await pinia(`
      const settings = pinia._s.get('settings')
      const ws = pinia._s.get('workspace')
      settings.setWorkspaceSplitRatio([], 0.78)
      settings.setWorkspaceSplitRatio([0], 0.16)
      ws.setStructureCollapsed(true)
      ws.setInformalCollapsed(true)
      ws.setColumnWidths([0.14, 0.72, 0.14])
    `)
    await sleep(600)

    const expandCard = (fragment: string) =>
      ev<boolean>(`(() => {
        const buttons = [...document.querySelectorAll('button.agent-clarify-header')]
        const el = buttons.find((n) => (n.textContent || '').includes(${JSON.stringify(fragment)}))
        if (!el) return false
        el.scrollIntoView({ block: 'center' })
        if (el.getAttribute('aria-expanded') !== 'true') el.click()
        return true
      })()`)

    const focusedAgent = await clickIncludes('digital asset')
    if (!focusedAgent) note('initial session button not found')
    await waitFor('How should roles', 20000)
    const expandedRoles = await expandCard('How should roles')
    if (!expandedRoles) note('roles clarification header not found')
    await sleep(700)
    await shot('02-agent-clarification')

    const clickedExtension = await clickIncludes('permission managemen')
    if (!clickedExtension) note('extension session button not found')
    await waitFor('Viewer', 20000)
    const expandedViewer = await expandCard('Viewer')
    if (!expandedViewer) note('viewer clarification header not found')
    await sleep(700)
    await shot('03-agent-extension')

    writeFileSync(join(outDir, 'capture-log.txt'), log.join('\n'), 'utf8')
    note('done')
    app.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    try {
      const text = await ev<string>(`(document.body && document.body.innerText || '').slice(0, 800)`)
      note(`visible: ${text.replace(/\s+/g, ' ')}`)
    } catch {
      note('could not read visible text')
    }
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
