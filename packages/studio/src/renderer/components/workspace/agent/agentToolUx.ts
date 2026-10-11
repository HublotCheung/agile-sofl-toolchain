export type AgentToolCallStatus = 'streaming' | 'running' | 'done' | 'error'

export type AgentToolCallView = {
  id: string
  name: string
  arguments: string
  status?: AgentToolCallStatus
}

export const AGENT_TOOL_LABEL_KEYS: Record<string, string> = {
  ask_clarification: 'agent.tool.askClarification',
  read_specification: 'agent.tool.readInformal',
  read_hybrid_specification: 'agent.tool.readHybrid',
  read_gui_specification: 'agent.tool.readGui',
  propose_changes: 'agent.tool.proposeInformal',
  propose_hybrid_changes: 'agent.tool.proposeHybrid',
  propose_refinement_step: 'agent.tool.proposeRefine',
  propose_gui_changes: 'agent.tool.proposeGui',
  propose_source_edit: 'agent.tool.proposeSource',
  read_refinement_state: 'agent.tool.readRefine',
  review_specification: 'agent.tool.reviewInformal',
  review_hybrid: 'agent.tool.reviewHybrid'
}

export function toolLabelKey(name: string): string {
  return AGENT_TOOL_LABEL_KEYS[name] || 'agent.tool.generic'
}

function utf8ByteLength(value: string): number {
  let bytes = value.length
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) continue
    if (code < 0x800) bytes += 1
    else if (code < 0xd800 || code >= 0xe000) bytes += 2
    else {
      bytes += 2
      i += 1
    }
  }
  return bytes
}

export function formatToolArgsSize(args: string): string {
  const n = utf8ByteLength(args ?? '')
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

const PARTIAL_ARGS_PARSE_LIMIT = 64 * 1024

function countOpKeys(text: string): number {
  let count = 0
  let from = 0
  while (from < text.length) {
    const at = text.indexOf('"op"', from)
    if (at < 0) break
    count += 1
    from = at + 4
    if (count >= 500) break
  }
  return count
}

export function parsePartialToolArgs(raw: string): { view?: string; operationCount?: number } {
  const text = raw?.trim() ?? ''
  if (!text) return {}
  if (text.length <= PARTIAL_ARGS_PARSE_LIMIT && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      return {
        view: typeof parsed.view === 'string' ? parsed.view : undefined,
        operationCount: Array.isArray(parsed.operations) ? parsed.operations.length : undefined
      }
    } catch {
      /* incomplete JSON */
    }
  }
  const head = text.length > 4096 ? text.slice(0, 4096) : text
  const viewMatch = head.match(/"view"\s*:\s*"([^"]+)"/)
  const operationCount = text.includes('"operations"') ? countOpKeys(text) : undefined
  return {
    view: viewMatch?.[1],
    operationCount
  }
}

export function toolCallSubtitle(args: string): string | null {
  const parsed = parsePartialToolArgs(args)
  const bits: string[] = []
  if (parsed.view) bits.push(parsed.view)
  if (parsed.operationCount != null) bits.push(String(parsed.operationCount))
  return bits.length ? bits.join(' · ') : null
}

export function resolvedToolStatus(
  call: AgentToolCallView,
  options?: { messageStreaming?: boolean; busy?: boolean }
): AgentToolCallStatus {
  const raw = call.status ?? 'done'
  if (raw === 'error') return 'error'
  const live = Boolean(options?.messageStreaming) && options?.busy !== false
  if (!live && (raw === 'streaming' || raw === 'running')) return 'done'
  return raw
}

export function isThinkingLive(msg: {
  content?: string
  streaming?: boolean
  toolCalls?: unknown[]
}): boolean {
  return Boolean(msg.streaming) && !String(msg.content ?? '').trim() && !msg.toolCalls?.length
}

export function shouldShowThinkingPlaceholder(msg: {
  content?: string
  thinking?: string
  streaming?: boolean
  toolCalls?: unknown[]
}): boolean {
  return isThinkingLive(msg) && !String(msg.thinking ?? '').trim()
}

export function activeToolCall(
  calls: AgentToolCallView[] | undefined,
  options?: { messageStreaming?: boolean; busy?: boolean }
): AgentToolCallView | null {
  if (!calls?.length) return null
  return (
    [...calls].reverse().find((c) => {
      const status = resolvedToolStatus(c, options)
      return status === 'streaming' || status === 'running'
    }) ?? null
  )
}

export function upsertToolCall(
  calls: AgentToolCallView[] | undefined,
  index: number,
  patch: Partial<AgentToolCallView> & Pick<AgentToolCallView, 'id' | 'name' | 'arguments'>
): AgentToolCallView[] {
  const next = calls ? [...calls] : []
  const prev = next[index]
  next[index] = {
    id: patch.id || prev?.id || `pending-${index}`,
    name: patch.name || prev?.name || '',
    arguments: patch.arguments ?? prev?.arguments ?? '',
    status: patch.status ?? prev?.status ?? 'streaming'
  }
  return next
}
