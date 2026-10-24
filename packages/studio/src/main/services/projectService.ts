import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rememberDialogPath } from './dialogState.js'
import {
  cachedModules,
  getUiState,
  listProjects,
  openProjectIndex,
  removeProject,
  replaceProjectModules,
  saveUiState,
  touchProject,
  upsertProject
} from './projectIndexDb.js'
import { createProjectTemplate, loadOrCreateManifest, readManifest, writeManifest, slugifyProjectName } from './projectManifest.js'
import { createProjectFromTemplate } from './projectTemplate.js'
import type { ProjectUiState } from '../../shared/projectTypes.js'

export async function initProjectIndex(): Promise<void> {
  const file = join(app.getPath('userData'), 'studio-index.sqlite')
  await openProjectIndex(file)
}

export function registerProjectHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('studio:project-list', () => listProjects())

  ipcMain.handle('studio:project-ui-state', (_event, projectId: string) => getUiState(projectId))

  ipcMain.handle(
    'studio:project-save-ui-state',
    (_event, projectId: string, state: ProjectUiState) => {
      saveUiState(projectId, state)
      return true
    }
  )

  ipcMain.handle('studio:project-cached-modules', (_event, projectId: string) =>
    cachedModules(projectId)
  )

  ipcMain.handle('studio:project-remove', (_event, projectId: string) => {
    removeProject(projectId)
    return true
  })

  ipcMain.handle('studio:project-rename', (_event, projectId: string, name: string) => {
    const project = listProjects().find((p) => p.id === projectId)
    if (!project) return null
    const trimmed = name.trim()
    if (!trimmed) return null
    const manifest = readManifest(project.rootPath)
    if (manifest) {
      writeManifest(project.rootPath, { ...manifest, name: trimmed })
    }
    return upsertProject({ name: trimmed, rootPath: project.rootPath })
  })

  ipcMain.handle('studio:project-create', async (_event, name: string) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Select folder for new project',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const parent = result.filePaths[0]!
    await rememberDialogPath(parent)
    const folderName = slugifyProjectName(name)
    const root = join(parent, folderName)
    const manifest = createProjectTemplate(root, name.trim() || folderName)
    const project = upsertProject({ name: manifest.name, rootPath: root })
    return { project, root }
  })

  ipcMain.handle(
    'studio:project-create-from-template',
    async (_event, name: string, templateId: string) => {
      const win = getWindow()
      const result = await dialog.showOpenDialog(win ?? undefined, {
        title: 'Select folder for new project',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const parent = result.filePaths[0]!
      await rememberDialogPath(parent)
      const folderName = slugifyProjectName(name)
      const root = join(parent, folderName)
      const manifest = createProjectFromTemplate(root, name.trim() || folderName, templateId)
      const project = upsertProject({ name: manifest.name, rootPath: root })
      return { project, root }
    }
  )

  ipcMain.handle('studio:project-open-folder', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Open project folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]!
    await rememberDialogPath(root)
    if (!existsSync(root)) return null
    const manifest = await loadOrCreateManifest(root)
    const project = upsertProject({ name: manifest.name, rootPath: root })
    return { project, root }
  })

  ipcMain.handle('studio:project-open-path', async (_event, root: string) => {
    if (!root || !existsSync(root)) return null
    const manifest = await loadOrCreateManifest(root)
    const project = upsertProject({ name: manifest.name, rootPath: root })
    return { project, root }
  })

  ipcMain.handle('studio:project-touch', (_event, projectId: string) => {
    touchProject(projectId)
    return true
  })

  ipcMain.handle(
    'studio:project-cache-modules',
    (_event, projectId: string, modules: Parameters<typeof replaceProjectModules>[1]) => {
      replaceProjectModules(projectId, modules)
      return true
    }
  )
}
