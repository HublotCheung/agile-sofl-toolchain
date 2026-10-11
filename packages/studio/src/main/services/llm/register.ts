import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { hasEcnuKey } from './chatEcnu'
import { loadStudioEnv } from './env'
import {
  deleteLlmProfile,
  exportLlmProfiles,
  getEcnuConfig,
  importLlmProfiles,
  listLlmProfiles,
  saveLlmProfile,
  setActiveLlmProfile,
  testLlmProfile,
  type LlmProfileDraft,
  type LlmTestRequest
} from './profiles'
import { runAgentTurn, resumeWithToolResult, type AgentTurnContext } from './agentLoop'
import type { AgentSession } from './agentTypes'
import {
  createSession,
  deleteSession,
  duplicateSession,
  forkSession,
  listSessions,
  loadSession,
  renameSession,
  rewindSession,
  sessionForRenderer,
  setSessionFlag
} from './sessionStore'
import { AGENT_SKILLS } from './skills'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function publish(session: AgentSession | null): AgentSession | null {
  return session ? sessionForRenderer(session) : null
}

function emitDelta(event: IpcMainInvokeEvent, payload: unknown): void {
  if (
    payload &&
    typeof payload === 'object' &&
    (payload as { kind?: string }).kind === 'session' &&
    (payload as { session?: AgentSession }).session
  ) {
    const sessionPayload = payload as { session: AgentSession }
    event.sender.send('studio:agent-delta', {
      ...sessionPayload,
      session: sessionForRenderer(sessionPayload.session)
    })
    return
  }
  event.sender.send('studio:agent-delta', payload)
}

const agentTurns = new Map<string, AbortController>()

function startAgentTurn(sessionId: string): AbortSignal {
  agentTurns.get(sessionId)?.abort()
  const controller = new AbortController()
  agentTurns.set(sessionId, controller)
  return controller.signal
}

function finishAgentTurn(sessionId: string, signal: AbortSignal): void {
  if (agentTurns.get(sessionId)?.signal === signal) agentTurns.delete(sessionId)
}

export function registerAgentHandlers(): void {
  loadStudioEnv()

  ipcMain.handle('studio:llm-status', () => {
    const cfg = getEcnuConfig()
    return {
      configured: hasEcnuKey(),
      model: cfg.model,
      baseUrl: cfg.baseUrl
    }
  })

  ipcMain.handle('studio:llm-list-profiles', () => clone(listLlmProfiles()))

  ipcMain.handle('studio:llm-save-profile', (_e, draft: LlmProfileDraft) =>
    clone(saveLlmProfile(draft ?? {}))
  )

  ipcMain.handle('studio:llm-delete-profile', (_e, id: string) => clone(deleteLlmProfile(String(id))))

  ipcMain.handle('studio:llm-set-active-profile', (_e, id: string) =>
    clone(setActiveLlmProfile(String(id)))
  )

  ipcMain.handle('studio:llm-export-profiles', () => exportLlmProfiles())

  ipcMain.handle('studio:llm-import-profiles', (_e, raw: unknown) => clone(importLlmProfiles(raw)))

  ipcMain.handle('studio:llm-test-profile', (_e, request: LlmTestRequest) => testLlmProfile(request))

  ipcMain.handle('studio:agent-skills', () =>
    AGENT_SKILLS.map((s) => ({ id: s.id, name: s.name }))
  )

  ipcMain.handle('studio:agent-list-sessions', (_e, projectRoot: string) => listSessions(projectRoot))

  ipcMain.handle(
    'studio:agent-create-session',
    (_e, payload: {
      projectRoot: string
      moduleId?: string
      title?: string
      skillId?: string
      permissions?: AgentTurnContext['permissions']
      promptExtras?: string
    }) =>
      publish(
        createSession(payload.projectRoot, payload.moduleId || 'project', payload.title, {
          skillId: payload.skillId,
          permissions: payload.permissions,
          promptExtras: payload.promptExtras
        })
      )
  )

  ipcMain.handle(
    'studio:agent-rename-session',
    (_e, payload: { projectRoot: string; id: string; title: string }) =>
      publish(renameSession(payload.projectRoot, payload.id, payload.title))
  )

  ipcMain.handle(
    'studio:agent-duplicate-session',
    (_e, payload: { projectRoot: string; id: string }) =>
      publish(duplicateSession(payload.projectRoot, payload.id))
  )

  ipcMain.handle(
    'studio:agent-fork-session',
    (
      _e,
      payload: {
        projectRoot: string
        id: string
        throughMessageId: string
        mode?: 'keep' | 'reset'
        title?: string
      }
    ) =>
      publish(
        forkSession(payload.projectRoot, payload.id, payload.throughMessageId, {
          mode: payload.mode,
          title: payload.title
        })
      )
  )

  ipcMain.handle(
    'studio:agent-rewind-session',
    (
      _e,
      payload: {
        projectRoot: string
        id: string
        throughMessageId: string
        mode?: 'keep' | 'reset'
        exclusive?: boolean
      }
    ) =>
      publish(
        rewindSession(payload.projectRoot, payload.id, payload.throughMessageId, {
          mode: payload.mode,
          exclusive: payload.exclusive
        })
      )
  )

  ipcMain.handle(
    'studio:agent-flag-session',
    (_e, payload: { projectRoot: string; id: string; flag: 'pinned' | 'archived'; value: boolean }) =>
      publish(setSessionFlag(payload.projectRoot, payload.id, payload.flag, payload.value))
  )

  ipcMain.handle(
    'studio:agent-delete-session',
    (_e, payload: { projectRoot: string; id: string }) => deleteSession(payload.projectRoot, payload.id)
  )

  ipcMain.handle(
    'studio:agent-load-session',
    (_e, payload: { projectRoot: string; id: string }) =>
      publish(loadSession(payload.projectRoot, payload.id))
  )

  ipcMain.handle(
    'studio:agent-chat',
    async (
      event,
      payload: {
        projectRoot: string
        sessionId: string
        text: string
        context: AgentTurnContext
      }
    ) => {
      let session = loadSession(payload.projectRoot, payload.sessionId)
      if (!session) session = createSession(payload.projectRoot, payload.context.moduleId || 'project')
      const signal = startAgentTurn(session.id)
      try {
        const next = await runAgentTurn(
          session,
          payload.projectRoot,
          payload.context,
          payload.text,
          (delta) => {
            emitDelta(event, { sessionId: session!.id, ...delta })
          },
          signal
        )
        return publish(next)
      } finally {
        finishAgentTurn(session.id, signal)
      }
    }
  )

  ipcMain.handle(
    'studio:agent-resume',
    async (
      event,
      payload: {
        projectRoot: string
        sessionId: string
        toolCallId: string
        result: string
        context: AgentTurnContext
        continueTurn?: boolean
      }
    ) => {
      const session = loadSession(payload.projectRoot, payload.sessionId)
      if (!session) return null
      const signal = startAgentTurn(session.id)
      try {
        const next = await resumeWithToolResult(
          session,
          payload.projectRoot,
          payload.context,
          payload.toolCallId,
          payload.result,
          (delta) => emitDelta(event, { sessionId: session.id, ...delta }),
          payload.continueTurn !== false,
          signal
        )
        return publish(next)
      } finally {
        finishAgentTurn(session.id, signal)
      }
    }
  )

  ipcMain.handle('studio:agent-abort', (_e, sessionId: string) => {
    const id = String(sessionId || '')
    agentTurns.get(id)?.abort()
    return { ok: true }
  })
}
