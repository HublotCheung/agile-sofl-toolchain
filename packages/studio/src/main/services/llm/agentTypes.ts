export type AgentRole = 'user' | 'assistant' | 'system' | 'tool'

export type ClarificationOption = { id: string; label: string }

export type ClarificationPrompt = {
  id: string
  question: string
  options?: ClarificationOption[]
  allowCustom: boolean
  multiSelect?: boolean
  pendingToolCallId?: string
  answer?: string
}

export type ReviewIssue = {
  dimension: string
  message: string
  nodeId?: string
}

export type InformalPatchPayload = {
  target?: 'informal' | 'hybrid' | 'gui'
  mode?: 'crud' | 'source'
  explanation?: string
  operations: Array<Record<string, unknown>>
}

export type AgentFailedWrite = {
  fingerprint: string
  error: string
  count: number
  mode?: string
}

export type SpecAccess = { read: boolean; write: boolean }

export type AgentSpecPermissions = {
  informal: SpecAccess
  hybrid: SpecAccess
}

export type SpecPatchPayload = InformalPatchPayload

export type AgentToolCallStatus = 'streaming' | 'running' | 'done' | 'error'

export type AgentToolCall = {
  id: string
  name: string
  arguments: string
  status?: AgentToolCallStatus
}

export type AgentMessage = {
  id: string
  role: AgentRole
  content: string
  timestamp: string
  skillId?: string
  thinking?: string
  streaming?: boolean
  toolCalls?: AgentToolCall[]
  proposedChanges?: InformalPatchPayload
  clarification?: ClarificationPrompt
  review?: { issues: ReviewIssue[] }
  pending?: boolean
  resolution?: 'applied' | 'rejected' | 'answered' | 'error'
  toolError?: string
}

export type AgentSession = {
  id: string
  moduleId: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  archived?: boolean
  messages: AgentMessage[]
  context: {
    skillId?: string
    selectedNodeId?: string
    pendingToolCallId?: string
    permissions?: AgentSpecPermissions
    promptExtras?: string
    lastFailedWrite?: AgentFailedWrite
    /** Fair post-clarify read budget (agentLoop). Pre-clarify uncapped; no force-propose. */
    postClarifyReadBudget?: {
      answeredClarifications: number
      proposalsEmitted: number
      consecutiveSpecReads: number
    }
  }
}

export function defaultAgentPermissions(): AgentSpecPermissions {
  return {
    informal: { read: true, write: true },
    hybrid: { read: true, write: true }
  }
}

export function generationAgentPermissions(): AgentSpecPermissions {
  return {
    informal: { read: true, write: false },
    hybrid: { read: true, write: true }
  }
}

export function normalizePermissions(raw?: Partial<AgentSpecPermissions> | null): AgentSpecPermissions {
  const base = defaultAgentPermissions()
  const informal = { ...base.informal, ...raw?.informal }
  const hybrid = { ...base.hybrid, ...raw?.hybrid }
  if (informal.write) informal.read = true
  if (hybrid.write) hybrid.read = true
  if (!informal.read) informal.write = false
  if (!hybrid.read) hybrid.write = false
  return { informal, hybrid }
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
