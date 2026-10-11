import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/main/services/llm/agentTypes'
import { createSession, listSessions, saveSession, sessionForRenderer } from '../src/main/services/llm/sessionStore'

describe('session list', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('lists sessions from an index without returning message bodies', async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-sessions-'))
    const alpha = createSession(root, 'project', 'Alpha')
    alpha.messages.push({
      id: 'tool-1',
      role: 'tool',
      content: 'x'.repeat(5000),
      timestamp: alpha.createdAt
    })
    saveSession(root, alpha)
    createSession(root, 'project', 'Beta')

    const listed = await listSessions(root)
    expect(listed.map((session) => session.title).sort()).toEqual(['Alpha', 'Beta'])
    expect(listed.every((session) => session.messages.length === 0)).toBe(true)

    const again = await listSessions(root)
    expect(again).toHaveLength(2)

    const raw = readFileSync(join(root, '.agile-sofl', 'agent', 'sessions', `${alpha.id}.json`), 'utf8')
    expect(raw).toContain('x'.repeat(100))
    expect(raw.includes('\n')).toBe(false)
  })

  it('strips tool bodies for the renderer and keeps assistant text', () => {
    const session = {
      id: 's',
      moduleId: 'm',
      title: 't',
      createdAt: '',
      updatedAt: '',
      messages: [
        { id: 'a', role: 'assistant', content: 'hello', timestamp: '' },
        { id: 't1', role: 'tool', content: 'huge', timestamp: '' }
      ],
      context: {}
    } as AgentSession
    const view = sessionForRenderer(session)
    expect(view.messages[0]?.content).toBe('hello')
    expect(view.messages[1]?.content).toBe('')
    expect(session.messages[1]?.content).toBe('huge')
  })
})
