import { collectHybridAgentDiagnostics } from '@agile-sofl/editor-api'
import { check } from '@agile-sofl/parser'
import { setHybridWriteDiagnosticCollector } from '../shared/asflRepair'
import { conditionNotice, getExperimentConfig } from './services/llm/experiment'

setHybridWriteDiagnosticCollector((source) => {
  const fromModel = collectHybridAgentDiagnostics(source)
  const fromParse = check(source, { fsfL1: false }).diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => ({ severity: d.severity, code: d.code, message: d.message }))
  return [...fromModel, ...fromParse]
})
import { app, ipcMain, BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runCopyrightCapture } from './services/copyrightCapture'
import { runPaperCapture } from './services/paperCapture'

if (process.env.STUDIO_CAPTURE === '1' && process.env.STUDIO_CAPTURE_USER_DATA) {
  mkdirSync(process.env.STUDIO_CAPTURE_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.STUDIO_CAPTURE_USER_DATA)
}
import { registerFileHandlers } from './services/fileService'
import { registerTextSearchHandlers } from './services/textSearchService'
import { registerWindowHandlers } from './services/windowService'
import { registerParseHandlers } from './services/parseService'
import { registerAgentHandlers } from './services/llm/register'
import { loadStudioEnv } from './services/llm/env'
import { initProjectIndex, registerProjectHandlers } from './services/projectService'
import { registerGitHandlers } from './services/gitService'
import { attachDevToolsShortcuts, attachRendererDiagnostics, openDevTools } from './services/devToolsService'
import {
  isLspRunning,
  getLspStatusMessage,
  sendToLanguageServer,
  setLspWindow,
  startLanguageServer,
  stopLanguageServer
} from './lspBridge'

let mainWindow: BrowserWindow | null = null
let allowClose = false
let resolveBackendReady: () => void = () => {}
const backendReady = new Promise<void>((resolve) => {
  resolveBackendReady = resolve
})

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(__dirname, '../../build/icons/256x256.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function getWindow(): BrowserWindow | null {
  return mainWindow
}

function createWindow(): void {
  const capture = process.env.STUDIO_CAPTURE === '1'
  const paper = process.env.STUDIO_CAPTURE_KIND === 'paper'
  mainWindow = new BrowserWindow({
    width: paper ? 1680 : capture ? 1440 : 1280,
    height: paper ? 1050 : capture ? 900 : 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    icon: resolveAppIcon(),
    backgroundColor: '#0e1418',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Agile-SOFL Studio'
  })

  setLspWindow(mainWindow)

  attachDevToolsShortcuts(mainWindow)
  attachRendererDiagnostics(mainWindow)

  mainWindow.on('closed', () => {
    setLspWindow(null)
    mainWindow = null
  })

  mainWindow.on('close', (e) => {
    if (allowClose) return
    e.preventDefault()
    mainWindow?.webContents.send('studio:request-close')
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('studio:window-maximized-changed', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('studio:window-maximized-changed', false)
  })

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) startLanguageServer()
    }, 2000)
    if (process.env.STUDIO_CAPTURE === '1' && mainWindow) {
      const win = mainWindow
      const run = process.env.STUDIO_CAPTURE_KIND === 'paper' ? runPaperCapture : runCopyrightCapture
      void run(win).catch((err) => {
        console.error('[studio-capture]', err)
        app.exit(1)
      })
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  loadStudioEnv()
  // experiment condition at startup (project-level experiment.json is re-read per agent session)
  console.warn(conditionNotice(getExperimentConfig()))
  registerFileHandlers(getWindow)
  registerTextSearchHandlers()
  registerWindowHandlers(getWindow)
  registerProjectHandlers(getWindow)
  registerAgentHandlers()
  registerGitHandlers()
  ipcMain.handle('studio:backend-ready', () => backendReady)

  ipcMain.on('studio:lsp-send', (_event, jsonBody: string) => {
    sendToLanguageServer(jsonBody)
  })

  ipcMain.handle('studio:lsp-status', () => ({
    running: isLspRunning(),
    message: isLspRunning()
      ? getLspStatusMessage() || 'Language server connected'
      : getLspStatusMessage() ||
        'Language server not available — run npm run bundle --workspace @agile-sofl/language-server'
  }))

  ipcMain.handle('studio:open-devtools', () => {
    openDevTools(mainWindow)
  })

  ipcMain.on('studio:confirm-close', () => {
    allowClose = true
    stopLanguageServer()
    setLspWindow(null)
    mainWindow?.close()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  setTimeout(() => {
    void (async () => {
      try {
        await initProjectIndex()
      } catch (err) {
        console.error('[studio] Failed to open project index:', err)
      }
      try {
        registerParseHandlers()
      } catch (err) {
        console.error('[studio] Failed to register parse handlers:', err)
      } finally {
        resolveBackendReady()
      }
    })()
  }, 0)
})

app.on('window-all-closed', () => {
  stopLanguageServer()
  if (process.platform !== 'darwin') app.quit()
})
