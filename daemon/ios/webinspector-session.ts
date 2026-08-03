/**
 * daemon/ios/webinspector-session.ts — inner WebKit Inspector Protocol (WIP).
 *
 * The forwarded WIR socket carries JSON WIP requests/responses/events. Modern
 * WebKit inserts a `Target` multiplexing layer; older builds speak WIP directly.
 * This session models BOTH envelopes explicitly, correlates numeric request IDs,
 * demuxes events by domain, arms every timeout BEFORE the request is written (so
 * no request can hang the multi-minute failure the 2026 Appium issue hit), caps a
 * single message at 16 MiB, and rejects all pending on detach/close/timeout.
 *
 *
 * It is byte-transport agnostic: `sendBytes` writes inner WIP bytes (the manager
 * wires it to WebInspectorTransport.forwardSocketData) and `feed` ingests inner
 * bytes (from onSocketData). This keeps it unit-testable without a device.
 */

import type { WipEnvelopeMode } from "../../shared/ios-web"

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024 //
const DEFAULT_MAX_INFLIGHT = 16
const HARD_MAX_INFLIGHT = 32               //

export type WipResponse = { id: number; result?: unknown; error?: { code?: number; message?: string } | unknown }
export type WipEvent = { method: string; params?: Record<string, unknown> }

export type WipError = Error & { code: "wip_timeout" | "wip_method_unavailable" | "wip_protocol_error" | "wip_detached"; wip?: unknown }

function wipError(code: WipError["code"], message: string, wip?: unknown): WipError {
  const e = new Error(message) as WipError
  e.code = code
  e.wip = wip
  return e
}

type Pending = {
  innerId: number
  method: string
  mutating: boolean
  resolve: (result: unknown) => void
  reject: (err: WipError) => void
  timer: ReturnType<typeof setTimeout>
}

export type WipTargetCandidate = { targetId: string; type?: string }

export type WebInspectorSessionOptions = {
  sendBytes: (b: Buffer) => void
  maxInFlight?: number
  defaultTimeoutMs?: number
  onEvent?: (evt: WipEvent) => void
  /** Target-multiplexed lifecycle notifications for the manager to react to. */
  onTargetCreated?: (c: WipTargetCandidate) => void
  onTargetDestroyed?: (targetId: string) => void
  onProvisionalCommit?: (oldTargetId: string, newTargetId: string) => void
  onError?: (err: Error) => void
}

export class WebInspectorSession {
  private acc = ""
  private nextInnerId = 1
  private nextOuterId = 1
  private pending = new Map<number, Pending>()
  private outerToInner = new Map<number, number>()
  private disposed = false
  private envelope: WipEnvelopeMode = "direct"
  private innerTargetId: string | undefined
  private readonly candidates: WipTargetCandidate[] = []
  private readonly maxInFlight: number
  private readonly defaultTimeoutMs: number

  constructor(private opts: WebInspectorSessionOptions) {
    this.maxInFlight = Math.min(opts.maxInFlight ?? DEFAULT_MAX_INFLIGHT, HARD_MAX_INFLIGHT)
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // ── envelope configuration (driven by the attach probe) ─────────────────────

  get envelopeMode(): WipEnvelopeMode { return this.envelope }
  get targetCandidates(): readonly WipTargetCandidate[] { return this.candidates }
  get innerTarget(): string | undefined { return this.innerTargetId }
  get inFlight(): number { return this.pending.size }

  setEnvelopeMode(mode: WipEnvelopeMode): void { this.envelope = mode }
  setInnerTarget(targetId: string): void { this.innerTargetId = targetId }

  // ── request/response ────────────────────────────────────────────────────────

  /**
   * Send a WIP method and await its result. The timeout is armed BEFORE the write.
   * `mutating` marks methods known to alter target state (never auto-retried).
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    opts: { timeoutMs?: number; mutating?: boolean } = {},
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(wipError("wip_detached", "session detached"))
    if (this.pending.size >= this.maxInFlight) {
      return Promise.reject(wipError("wip_protocol_error", `too many in-flight requests (cap ${this.maxInFlight})`))
    }
    if (this.envelope === "target-multiplexed" && !method.startsWith("Target.") && !this.innerTargetId) {
      return Promise.reject(wipError("wip_protocol_error", "no inner target selected for multiplexed session"))
    }

    const innerId = this.nextInnerId++
    const inner = { id: innerId, method, params: params ?? {} }
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs

    return new Promise<unknown>((resolve, reject) => {
      // Arm the timeout FIRST, then write.
      const timer = setTimeout(() => {
        const p = this.pending.get(innerId)
        if (!p) return
        this.pending.delete(innerId)
        reject(wipError("wip_timeout", `WIP ${method} (id ${innerId}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(innerId, { innerId, method, mutating: !!opts.mutating, resolve, reject, timer })

      try {
        if (this.envelope === "direct" || method.startsWith("Target.")) {
          this.write(inner)
        } else {
          const outerId = this.nextOuterId++
          this.outerToInner.set(outerId, innerId)
          this.write({
            id: outerId,
            method: "Target.sendMessageToTarget",
            params: { targetId: this.innerTargetId, message: JSON.stringify(inner) },
          })
        }
      } catch (err) {
        const p = this.pending.get(innerId)
        if (p) { clearTimeout(p.timer); this.pending.delete(innerId) }
        reject(wipError("wip_protocol_error", `failed to write WIP ${method}: ${(err as Error).message}`))
      }
    })
  }

  private write(obj: unknown): void {
    this.opts.sendBytes(Buffer.from(JSON.stringify(obj), "utf-8"))
  }

  // ── incoming ─────────────────────────────────────────────────────────────────

  /** Ingest inner WIP bytes (one or more concatenated/partial JSON messages). */
  feed(bytes: Buffer | string): void {
    if (this.disposed) return
    this.acc += typeof bytes === "string" ? bytes : bytes.toString("utf-8")
    let messages: string[]
    try {
      const scanned = scanJsonMessages(this.acc, MAX_MESSAGE_BYTES)
      messages = scanned.messages
      this.acc = scanned.rest
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.acc = ""
      return
    }
    for (const raw of messages) {
      let msg: unknown
      try { msg = JSON.parse(raw) } catch { continue }
      this.dispatchOuter(msg)
    }
  }

  private dispatchOuter(msg: unknown): void {
    if (!isObj(msg)) return

    const method = typeof msg.method === "string" ? msg.method : undefined

    // Target multiplexing control messages are meaningful in BOTH envelope modes.
    // A session that announces a Target IS multiplexed, so observing targetCreated
    // auto-promotes the envelope and adopts a page target — otherwise a first
    // request would be sent unwrapped and the device answers "domain not found".
    if (method === "Target.targetCreated") {
      const info = isObj(msg.params) && isObj(msg.params.targetInfo) ? msg.params.targetInfo : undefined
      const targetId = info && typeof info.targetId === "string" ? info.targetId : undefined
      if (targetId) {
        const type = info && typeof info.type === "string" ? (info.type as string) : undefined
        const c = { targetId, type }
        this.candidates.push(c)
        if (this.envelope === "direct") this.envelope = "target-multiplexed"
        if (!this.innerTargetId && (type === undefined || type === "page")) this.innerTargetId = targetId
        this.opts.onTargetCreated?.(c)
      }
      return
    }
    if (method === "Target.dispatchMessageFromTarget") {
      const inner = parseInnerMessage(msg.params)
      if (inner) this.dispatchInner(inner)
      return
    }
    if (this.envelope === "direct") { this.dispatchInner(msg); return }
    if (method === "Target.didCommitProvisionalTarget") {
      const p = isObj(msg.params) ? msg.params : {}
      const oldId = typeof p.oldTargetId === "string" ? p.oldTargetId : undefined
      const newId = typeof p.newTargetId === "string" ? p.newTargetId : undefined
      if (oldId && newId) {
        if (this.innerTargetId === oldId) this.innerTargetId = newId
        this.opts.onProvisionalCommit?.(oldId, newId)
      }
      return
    }
    if (method === "Target.targetDestroyed") {
      const p = isObj(msg.params) ? msg.params : {}
      const targetId = typeof p.targetId === "string" ? p.targetId : undefined
      if (targetId) {
        if (this.innerTargetId === targetId) this.innerTargetId = undefined
        this.opts.onTargetDestroyed?.(targetId)
      }
      return
    }
    // An outer ack/response for our Target.sendMessageToTarget wrapper. Empty
    // result = transport ack only; an error means the inner request never landed.
    if (typeof msg.id === "number") {
      const innerId = this.outerToInner.get(msg.id)
      this.outerToInner.delete(msg.id)
      if (innerId !== undefined && isObj(msg.error)) {
        this.rejectPending(innerId, wipError("wip_protocol_error", outerErrText(msg.error), msg.error))
      }
      return
    }
    // Any other Target.* event.
    if (method) this.opts.onEvent?.({ method, params: isObj(msg.params) ? (msg.params as Record<string, unknown>) : undefined })
  }

  private dispatchInner(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error !== undefined && msg.error !== null) {
        p.reject(protocolErrorToWip(msg.error))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === "string") {
      this.opts.onEvent?.({ method: msg.method, params: isObj(msg.params) ? (msg.params as Record<string, unknown>) : undefined })
    }
  }

  private rejectPending(innerId: number, err: WipError): void {
    const p = this.pending.get(innerId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(innerId)
    p.reject(err)
  }

  // ── teardown ─────────────────────────────────────────────────────────────────

  /** Reject every pending request. Idempotent. */
  dispose(reason = "session detached"): void {
    if (this.disposed) return
    this.disposed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(wipError("wip_detached", reason))
    }
    this.pending.clear()
    this.outerToInner.clear()
    this.acc = ""
  }

  get isDisposed(): boolean { return this.disposed }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** An unknown-method protocol error maps to capability absence. */
function protocolErrorToWip(err: unknown): WipError {
  const msg = isObj(err) && typeof err.message === "string" ? err.message : String(err)
  const code = isObj(err) && typeof err.code === "number" ? err.code : undefined
  const unavailable = /not (found|implemented|supported)|unknown method|no such method|does not support/i.test(msg)
  return wipError(unavailable ? "wip_method_unavailable" : "wip_protocol_error", msg, err ?? { code })
}

function outerErrText(err: unknown): string {
  return isObj(err) && typeof err.message === "string" ? err.message : "Target.sendMessageToTarget failed"
}

function parseInnerMessage(params: unknown): Record<string, unknown> | undefined {
  if (!isObj(params)) return undefined
  const message = params.message
  if (typeof message !== "string") return undefined
  try {
    const inner = JSON.parse(message)
    return isObj(inner) ? inner : undefined
  } catch { return undefined }
}

/**
 * Extract complete top-level JSON values from a stream buffer, respecting string
 * literals/escapes. Returns finished messages and the unparsed remainder. Throws
 * if a single in-progress message exceeds the cap.
 */
export function scanJsonMessages(buf: string, cap: number): { messages: string[]; rest: string } {
  const messages: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  let consumed = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === "{" || c === "[") { if (depth === 0) start = i; depth++ }
    else if (c === "}" || c === "]") {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) { messages.push(buf.slice(start, i + 1)); consumed = i + 1; start = -1 }
      }
    }
  }
  const rest = buf.slice(consumed)
  if (rest.length > cap) throw new Error(`WIP message exceeds ${cap}-byte cap`)
  return { messages, rest }
}
