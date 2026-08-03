export type ContextSocket = {
  send: (data: string) => void
  __contextId?: string
  __native?: boolean
}

export type ContextConflictMessage = {
  type: "context_conflict"
  contextId: string
  error: string
}

export type ContextRegisteredMessage = {
  type: "context_registered"
  contextId: string
}

export type ContextClaimResult =
  | {
      status: "registered"
      contextId: string
      previousContextId?: string
      message: ContextRegisteredMessage
    }
  | {
      status: "conflict"
      contextId: string
      message: ContextConflictMessage
    }

export function contextConflictMessage(contextId: string): ContextConflictMessage {
  return {
    type: "context_conflict",
    contextId,
    error: `context '${contextId}' is already in use`,
  }
}

export function contextRegisteredMessage(contextId: string): ContextRegisteredMessage {
  return {
    type: "context_registered",
    contextId,
  }
}

export function claimContextId(
  contextMap: Map<string, ContextSocket>,
  ws: ContextSocket,
  contextId: string,
): ContextClaimResult {
  const existing = contextMap.get(contextId)
  if (existing && existing !== ws) {
    return {
      status: "conflict",
      contextId,
      message: contextConflictMessage(contextId),
    }
  }

  const previousContextId = ws.__contextId
  if (previousContextId && previousContextId !== contextId && contextMap.get(previousContextId) === ws) {
    contextMap.delete(previousContextId)
  }

  ws.__contextId = contextId
  contextMap.set(contextId, ws)

  return {
    status: "registered",
    contextId,
    previousContextId: previousContextId && previousContextId !== contextId ? previousContextId : undefined,
    message: contextRegisteredMessage(contextId),
  }
}
