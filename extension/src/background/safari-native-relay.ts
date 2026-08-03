export const SAFARI_NATIVE_RELAY_APPLICATION_ID = "com.interceptor.safari"
export const SAFARI_NATIVE_RELAY_MESSAGE_TYPE = "interceptor_safari_relay"
export const SAFARI_NATIVE_RELAY_QUEUE_CAP = 50

export type SafariNativeRelayRuntime = {
  lastError?: { message?: string }
  sendNativeMessage?: (
    applicationId: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ) => Promise<unknown> | void
}

type SafariNativeRelayReply = {
  connected?: boolean
  messages?: unknown[]
  error?: string
}

export type SafariNativeRelayClientOptions = {
  runtime: SafariNativeRelayRuntime
  contextId: string
  waitMilliseconds?: number
  onMessage: (message: unknown) => void | Promise<void>
  onConnectionChange?: (connected: boolean) => void
  onError?: (error: Error) => void
  sleep?: (milliseconds: number) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Safari's sanctioned JS -> native lane is one-shot sendNativeMessage. The
 * native appex keeps the daemon WebSocket alive; this client performs a bounded
 * long-poll exchange so daemon actions and extension responses remain duplex.
 */
export class SafariNativeRelayClient {
  private readonly runtime: SafariNativeRelayRuntime
  private readonly contextId: string
  private readonly waitMilliseconds: number
  private readonly onMessage: (message: unknown) => void | Promise<void>
  private readonly onConnectionChange: (connected: boolean) => void
  private readonly onError: (error: Error) => void
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly outbound: unknown[] = []
  private running = false

  constructor(options: SafariNativeRelayClientOptions) {
    this.runtime = options.runtime
    this.contextId = options.contextId
    this.waitMilliseconds = Math.max(100, Math.min(options.waitMilliseconds ?? 1_000, 5_000))
    this.onMessage = options.onMessage
    this.onConnectionChange = options.onConnectionChange ?? (() => {})
    this.onError = options.onError ?? (() => {})
    this.sleep = options.sleep ?? defaultSleep
  }

  enqueue(message: unknown): void {
    if (this.outbound.length >= SAFARI_NATIVE_RELAY_QUEUE_CAP) {
      this.outbound.shift()
      this.onError(new Error("Safari native relay outbound queue full; dropped oldest message"))
    }
    this.outbound.push(message)
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.runLoop()
  }

  stop(): void {
    this.running = false
  }

  async exchangeOnce(): Promise<{ connected: boolean; received: number }> {
    const outboundCount = this.outbound.length
    const response = await this.sendNativeMessage({
      type: SAFARI_NATIVE_RELAY_MESSAGE_TYPE,
      contextId: this.contextId,
      outbound: this.outbound.slice(0, outboundCount),
      waitMilliseconds: this.waitMilliseconds,
    })

    if (!isRecord(response)) throw new Error("Safari native relay returned an invalid response")
    const reply = response as SafariNativeRelayReply
    if (typeof reply.error === "string" && reply.error.length > 0) {
      throw new Error(reply.error)
    }

    // Remove only the messages represented by this successful exchange. New
    // messages can be queued while the native long poll is in flight.
    if (outboundCount > 0) this.outbound.splice(0, outboundCount)

    const messages = Array.isArray(reply.messages) ? reply.messages : []
    for (const message of messages) await this.onMessage(message)
    return { connected: reply.connected === true, received: messages.length }
  }

  private async runLoop(): Promise<void> {
    let retryDelay = 250
    while (this.running) {
      try {
        const result = await this.exchangeOnce()
        this.onConnectionChange(result.connected)
        retryDelay = 250
        if (!result.connected) await this.sleep(retryDelay)
      } catch (error) {
        const relayError = error instanceof Error ? error : new Error(String(error))
        this.onConnectionChange(false)
        this.onError(relayError)
        await this.sleep(retryDelay)
        retryDelay = Math.min(retryDelay * 2, 5_000)
      }
    }
  }

  private sendNativeMessage(message: unknown): Promise<unknown> {
    const sendNativeMessage = this.runtime.sendNativeMessage
    if (typeof sendNativeMessage !== "function") {
      return Promise.reject(new Error("Safari runtime.sendNativeMessage is unavailable"))
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const succeed = (value: unknown): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const callback = (response: unknown): void => {
        const lastError = this.runtime.lastError
        if (lastError?.message) fail(new Error(lastError.message))
        else succeed(response)
      }

      try {
        const maybePromise = sendNativeMessage.call(
          this.runtime,
          SAFARI_NATIVE_RELAY_APPLICATION_ID,
          message,
          callback,
        )
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
          ;(maybePromise as Promise<unknown>).then(succeed, fail)
        }
      } catch (error) {
        fail(error)
      }
    })
  }
}
