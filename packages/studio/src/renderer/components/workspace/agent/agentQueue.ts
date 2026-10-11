export type AgentQueuedMessage = {
  id: string
  text: string
}

export type ComposerAction = 'send' | 'stop' | 'enqueue'

export function composerAction(busy: boolean, input: string): ComposerAction {
  if (busy) return input.trim() ? 'enqueue' : 'stop'
  return 'send'
}

export function createQueuedMessage(text: string, id = crypto.randomUUID()): AgentQueuedMessage | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return { id, text: trimmed }
}

export function enqueueMessage(
  queue: AgentQueuedMessage[],
  text: string
): AgentQueuedMessage[] {
  const item = createQueuedMessage(text)
  if (!item) return queue
  return [...queue, item]
}

export function updateQueuedMessage(
  queue: AgentQueuedMessage[],
  id: string,
  text: string
): AgentQueuedMessage[] {
  const trimmed = text.trim()
  if (!trimmed) return queue.filter((item) => item.id !== id)
  return queue.map((item) => (item.id === id ? { ...item, text: trimmed } : item))
}

export function removeQueuedMessage(queue: AgentQueuedMessage[], id: string): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== id)
}

export function shiftQueuedMessage(queue: AgentQueuedMessage[]): {
  next: AgentQueuedMessage | null
  rest: AgentQueuedMessage[]
} {
  if (!queue.length) return { next: null, rest: queue }
  const [next, ...rest] = queue
  return { next, rest }
}

export function takeQueuedMessage(
  queue: AgentQueuedMessage[],
  id: string
): { item: AgentQueuedMessage | null; rest: AgentQueuedMessage[] } {
  const item = queue.find((entry) => entry.id === id) ?? null
  if (!item) return { item: null, rest: queue }
  return { item, rest: queue.filter((entry) => entry.id !== id) }
}

/** Pending tool work or a live stream means this turn will still produce output. */
export function sessionStillRunning(session: {
  context?: { pendingToolCallId?: string }
  messages?: Array<{ pending?: boolean; streaming?: boolean }>
} | null | undefined): boolean {
  if (!session) return false
  if (session.context?.pendingToolCallId) return true
  return Boolean(session.messages?.some((message) => message.pending || message.streaming))
}

/**
 * Auto-send only after this session's agent has fully stopped.
 * A user interrupt keeps the queue for a manual send.
 */
export function shouldAutoFlushQueue(state: {
  busy: boolean
  interrupted: boolean
  stillRunning: boolean
}): boolean {
  return !state.busy && !state.interrupted && !state.stillRunning
}
