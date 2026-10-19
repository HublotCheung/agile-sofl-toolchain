import { dialog, ipcMain, shell, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getLastDialogDir, rememberDialogPath } from './dialogState.js'
import { writeModuleArtifacts } from './dualSave.js'

const showOpenDialog=(win:BrowserWindow|null,options:OpenDialogOptions)=>win?dialog.showOpenDialog(win,options):dialog.showOpenDialog(options)
const showSaveDialog=(win:BrowserWindow|null,options:SaveDialogOptions)=>win?dialog.showSaveDialog(win,options):dialog.showSaveDialog(options)

export function registerFileHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('studio:file-read', async (_event, filePath: string) => {
    const content = await readFile(filePath, 'utf-8')
    return { filePath, content, title: basename(filePath) }
  })

  ipcMain.handle('studio:file-write', async (_event, filePath: string, content: string) => {
    await writeFile(filePath, content, 'utf-8')
    // final grammar G:36-38: each module is also saved as text + XML (never fails the save)
    let dualSave: ReturnType<typeof writeModuleArtifacts> | undefined
    try {
      dualSave = writeModuleArtifacts(filePath, content)
    } catch (e) {
      dualSave = { written: [], skipped: String(e) }
    }
    return { filePath, title: basename(filePath), dualSave }
  })

  ipcMain.handle('studio:file-open-dialog', async (_event, kind?: 'asfl' | 'aspec' | 'any' | 'json') => {
    const win = getWindow()
    const lastDir = await getLastDialogDir()
    const filters =
      kind === 'json' ? [{name:'JSON',extensions:['json']}] : kind === 'aspec'
        ? [{ name: 'Informal Spec', extensions: ['aspec'] }]
        : kind === 'asfl'
          ? [{ name: 'Hybrid Spec', extensions: ['asfl'] }]
          : [
              { name: 'Agile-SOFL Specs', extensions: ['asfl', 'aspec'] },
              { name: 'Hybrid (.asfl)', extensions: ['asfl'] },
              { name: 'Informal (.aspec)', extensions: ['aspec'] },
              { name: 'All files', extensions: ['*'] }
            ]
    const result = await showOpenDialog(win, {
      filters,
      properties: ['openFile'],
      defaultPath: lastDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    await rememberDialogPath(filePath)
    const content = await readFile(filePath, 'utf-8')
    return { filePath, content, title: basename(filePath) }
  })

  ipcMain.handle(
    'studio:file-save-dialog',
    async (_event, defaultName?: string, kind: 'asfl' | 'aspec' | 'json' = 'asfl') => {
      const win = getWindow()
      const lastDir = await getLastDialogDir()
      const ext = kind === 'json' ? 'json' : kind === 'aspec' ? 'aspec' : 'asfl'
      const defaultPath = defaultName ?? `untitled.${ext}`
      const result = await showSaveDialog(win, {
        filters: [{ name: kind === 'json' ? 'JSON' : kind === 'aspec' ? 'Informal Spec' : 'Hybrid Spec', extensions: [ext] }],
        defaultPath: lastDir ? joinLastDir(lastDir, defaultPath) : defaultPath
      })
      if (result.canceled || !result.filePath) return null
      await rememberDialogPath(result.filePath)
      return result.filePath
    }
  )

  ipcMain.handle('studio:open-project-folder', async () => {
    const win = getWindow()
    const lastDir = await getLastDialogDir()
    const result = await showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: lastDir
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    await rememberDialogPath(root)
    return root
  })

  ipcMain.handle('studio:reveal-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
}

function joinLastDir(dir: string, name: string): string {
  return join(dir, name)
}
