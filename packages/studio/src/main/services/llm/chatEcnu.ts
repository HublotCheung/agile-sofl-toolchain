import { getEcnuConfig } from './profiles'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
  reasoning_content?: string
}

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ChatCompletion = {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string
  /** token usage reported by the provider (null fields when not reported) */
  usage?: { promptTokens: number | null; completionTokens: number | null }
  /** model name actually used for the call */
  model?: string
}

export type ChatStreamToolCall = {
  index: number
  id: string
  name: string
  arguments: string
}

export type ChatStreamDelta = {
  reasoning?: string
  content?: string
  toolCalls?: ChatStreamToolCall[]
}

export class ChatAbortedError extends Error {
  constructor(message = 'Stopped by user.') {
    super(message)
    this.name = 'ChatAbortedError'
  }
}

export function isChatAborted(error: unknown): boolean {
  return error instanceof ChatAbortedError || (error instanceof Error && error.name === 'ChatAbortedError')
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/** Wall-clock timeout for one chat/completions call (headers + body stream). Lab models with long agent contexts often exceed 90s. Override with ECNU_CHAT_TIMEOUT_MS (ms, min 30000). */
const CHAT_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.ECNU_CHAT_TIMEOUT_MS)
  if (Number.isFinite(fromEnv) && fromEnv >= 30_000) return Math.floor(fromEnv)
  return 300_000
})()

async function postChat(body: Record<string, unknown>, userSignal?: AbortSignal): Promise<Response> {
  const cfg = getEcnuConfig()
  if (!cfg.apiKey) {
    throw new Error('No LLM API key. Add a profile in Settings, or set ECNU_API_KEY in packages/studio/.env.')
  }
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS)
  const signal = userSignal ? combineAbortSignals([timeout, userSignal]) : timeout
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({ model: cfg.model, ...body }),
    signal
  }).catch((e: unknown) => {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      if (userSignal?.aborted) throw new ChatAbortedError()
      throw new Error(`ChatECNU timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s. Send again to continue.`)
    }
    throw e
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ChatECNU ${res.status}: ${text.slice(0, 400)}`)
  }
  return res
}

export async function chatEcnu(options: {
  messages: ChatMessage[]
  tools?: ChatTool[]
  temperature?: number
  json?: boolean
  signal?: AbortSignal
}): Promise<ChatCompletion> {
  const body: Record<string, unknown> = {
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    stream: false,
    thinking: { type: 'disabled' }
  }
  if (options.tools?.length) body.tools = options.tools
  if (options.json) body.response_format = { type: 'json_object' }

  const res = await postChat(body, options.signal)
  const json = (await res.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    model?: string
    choices?: Array<{
      finish_reason?: string
      message?: {
        content?: string | null
        reasoning_content?: string | null
        tool_calls?: ToolCall[]
      }
    }>
  }
  const choice = json.choices?.[0]
  return {
    content: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? '',
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? 'stop',
    usage: { promptTokens: json.usage?.prompt_tokens ?? null, completionTokens: json.usage?.completion_tokens ?? null },
    model: json.model ?? getEcnuConfig().model
  }
}

/** reasoning_effort actually sent for a streaming request ('off' = thinking disabled, field omitted). */
export function reasoningEffortFor(thinking?: boolean): 'low' | 'off' {
  return thinking === false ? 'off' : 'low'
}

/** Default completion budget for agent streaming calls (GUI/tool JSON can be large). Override with options.maxTokens or ECNU_MAX_TOKENS. */
export const DEFAULT_STREAM_MAX_TOKENS = 8192

/** Resolve max_tokens for a streaming request. Explicit option wins, then ECNU_MAX_TOKENS, else DEFAULT_STREAM_MAX_TOKENS. */
export function resolveStreamMaxTokens(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  const fromEnv = Number(process.env.ECNU_MAX_TOKENS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_STREAM_MAX_TOKENS
}

/** Request body of a streaming chat call (pure; exported for tests). Always sets max_tokens so length truncations are explicit and detectable. */
export function buildStreamBody(options: {
  messages: ChatMessage[]
  tools?: ChatTool[]
  temperature?: number
  thinking?: boolean
  maxTokens?: number
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: options.messages,
    temperature: options.temperature ?? 0.35,
    stream: true,
    thinking: { type: options.thinking === false ? 'disabled' : 'enabled' },
    max_tokens: resolveStreamMaxTokens(options.maxTokens)
  }
  const effort = reasoningEffortFor(options.thinking)
  if (effort !== 'off') body.reasoning_effort = effort
  if (options.tools?.length) body.tools = options.tools
  // ask OpenAI-compatible providers to send token usage in the final chunk (telemetry)
  body.stream_options = { include_usage: true }

  return body
}

export async function chatEcnuStream(options: {
  messages: ChatMessage[]
  tools?: ChatTool[]
  temperature?: number
  thinking?: boolean
  maxTokens?: number
  signal?: AbortSignal
  onDelta?: (delta: ChatStreamDelta) => void
}): Promise<ChatCompletion> {
  const body = buildStreamBody(options)
  const res = await postChat(body, options.signal)
  if (!res.body) throw new Error('ChatECNU stream has no body.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  const tools: Array<{ id: string; name: string; arguments: string }> = []
  let finishReason = 'stop'
  let usage: { promptTokens: number | null; completionTokens: number | null } = { promptTokens: null, completionTokens: null }
  let model: string | undefined

  const flushLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    let parsed: {
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null
      model?: string
      choices?: Array<{
        finish_reason?: string | null
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    try {
      parsed = JSON.parse(data) as typeof parsed
    } catch {
      return
    }
    if (parsed.usage) usage = { promptTokens: parsed.usage.prompt_tokens ?? null, completionTokens: parsed.usage.completion_tokens ?? null }
    if (parsed.model) model = parsed.model
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (!delta) return
    const reasonChunk = delta.reasoning_content ?? delta.reasoning ?? ''
    const contentChunk = delta.content ?? ''
    if (reasonChunk) {
      reasoning += reasonChunk
      options.onDelta?.({ reasoning })
    }
    if (contentChunk) {
      content += contentChunk
      options.onDelta?.({ content })
    }
    let toolsChanged = false
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? tools.length
      const current = tools[index] ?? { id: '', name: '', arguments: '' }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.arguments += call.function.arguments
      tools[index] = current
      toolsChanged = true
    }
    if (toolsChanged) {
      options.onDelta?.({
        toolCalls: tools.flatMap((t, index) =>
          t
            ? [
                {
                  index,
                  id: t.id,
                  name: t.name,
                  arguments: t.arguments
                }
              ]
            : []
        )
      })
    }
  }

  while (true) {
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => undefined)
      throw new ChatAbortedError()
    }
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e) {
      if (options.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
        throw new ChatAbortedError()
      }
      throw e
    }
    const { done, value } = chunk
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) flushLine(line)
  }
  if (buffer.trim()) flushLine(buffer)

  return {
    content,
    reasoning,
    toolCalls: tools
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id || `call-${t.name}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.arguments || '{}' }
      })),
    finishReason,
    usage,
    model: model ?? getEcnuConfig().model
  }
}

export function hasEcnuKey(): boolean {
  return Boolean(getEcnuConfig().apiKey)
}
