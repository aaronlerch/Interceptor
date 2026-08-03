/**
 * daemon/ios/service-plist.ts — framing + stream helpers for the classic
 * Lockdown device-service lane.
 *
 * Everything here is a thin reuse of primitives we already ship:
 *   - lockdown.ts  : connectServiceSocket (StartService + TLS), the 4-byte-BE +
 *                    plist frame codec (encodeLockdownFrame / tryReadLockdownFrame)
 *   - webinspector-plist.ts : the BOUNDED binary+XML plist decoder (decodePlist),
 *                    which — unlike lockdown's plutil-shelling plistToObject —
 *                    handles <data> values safely.
 *
 * No new dependencies. Pure Bun/node sockets.
 */

import type net from "node:net"
import type { TLSSocket } from "node:tls"
import { connectServiceSocket, encodeLockdownFrame, tryReadLockdownFrame, type PlistDict } from "./lockdown"
import { decodePlist, DEFAULT_PLIST_LIMITS, PlistError, type PlistLimits, type PlistValue } from "./webinspector-plist"

type Sock = net.Socket | TLSSocket

// ── bounded buffer for streaming services (syslog / notifications) ────────────

export type BufferedItem = { at: string; [k: string]: unknown }

export class BoundedBuffer<T = BufferedItem> {
  private items: T[] = []
  private bytes = 0
  private dropped = 0
  private firstAt: string | undefined
  constructor(private maxItems = 2000, private maxBytes = 16 * 1024 * 1024) {}

  push(item: T): void {
    const size = Buffer.byteLength(JSON.stringify(item))
    this.items.push(item)
    this.bytes += size
    if (this.firstAt === undefined) this.firstAt = new Date().toISOString()
    while (this.items.length > this.maxItems || this.bytes > this.maxBytes) {
      const removed = this.items.shift()
      if (removed === undefined) break
      this.bytes -= Buffer.byteLength(JSON.stringify(removed))
      this.dropped++
    }
  }
  drain(): { items: T[]; dropped: number; retainedFrom?: string } {
    return { items: this.items.slice(), dropped: this.dropped, retainedFrom: this.firstAt }
  }
  clear(): void { this.items = []; this.bytes = 0; this.dropped = 0; this.firstAt = undefined }
  get size(): number { return this.items.length }
  get droppedCount(): number { return this.dropped }
}

// ── one-shot + streamed framed-plist exchanges ────────────────────────────────

/** Send one framed plist request, await one full framed reply, bounded-decode it. */
export function sendPlistAwaitReply(sock: Sock, request: PlistDict, timeoutMs = 15_000, limits: PlistLimits = DEFAULT_PLIST_LIMITS): Promise<PlistValue> {
  return new Promise((resolve, reject) => {
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let done = false
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); sock.removeAllListeners("data"); fn() } }
    const timer = setTimeout(() => finish(() => reject(new Error("plist service reply timed out"))), timeoutMs)
    sock.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      const frame = tryReadLockdownFrame(acc)
      if (!frame) return
      try {
        const value = decodePlist(frame.body, limits)
        finish(() => resolve(value))
      } catch (err) {
        finish(() => reject(err instanceof PlistError ? err : new Error(`plist decode failed: ${(err as Error).message}`)))
      }
    })
    sock.on("error", (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
    sock.on("close", () => finish(() => reject(new Error("service closed before reply"))))
    sock.write(encodeLockdownFrame(request))
  })
}

/**
 * Send a request, then collect framed plist replies until `isDone(reply)` returns
 * true (e.g. reply.Status === "Complete") or the timeout fires. Used by services
 * that stream multiple frames per request (installation_proxy-style).
 */
export function sendPlistCollect(
  sock: Sock,
  request: PlistDict,
  isDone: (v: PlistValue) => boolean,
  timeoutMs = 20_000,
): Promise<PlistValue[]> {
  return new Promise((resolve, reject) => {
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const out: PlistValue[] = []
    let done = false
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); sock.removeAllListeners("data"); fn() } }
    const timer = setTimeout(() => finish(() => resolve(out)), timeoutMs) // return what we have on timeout
    sock.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      try {
        let frame = tryReadLockdownFrame(acc)
        while (frame) {
          acc = frame.rest
          const v = decodePlist(frame.body, DEFAULT_PLIST_LIMITS)
          out.push(v)
          if (isDone(v)) { finish(() => resolve(out)); return }
          frame = tryReadLockdownFrame(acc)
        }
      } catch (err) {
        finish(() => reject(err instanceof PlistError ? err : new Error(`plist decode failed: ${(err as Error).message}`)))
      }
    })
    sock.on("error", (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
    sock.on("close", () => finish(() => resolve(out)))
    sock.write(encodeLockdownFrame(request))
  })
}

/** Open a classic service, run a one-shot request/reply, close. */
export async function plistOneShot(udid: string, service: string, request: PlistDict, timeoutMs?: number, limits?: PlistLimits): Promise<PlistValue> {
  const { sock } = await connectServiceSocket(udid, service)
  try {
    return await sendPlistAwaitReply(sock, request, timeoutMs, limits ?? DEFAULT_PLIST_LIMITS)
  } finally {
    try { sock.destroy() } catch {}
  }
}

// ── raw line stream (syslog_relay) ────────────────────────────────────────────

/**
 * Wrap a socket that emits an unframed byte stream, split into lines on a
 * delimiter, and push each into a bounded buffer. Handles a partial line split
 * across reads. Reusable for syslog_relay (\n or \0 delimited).
 */
export class RawLineStream {
  private partial = ""
  private closed = false
  constructor(
    private sock: Sock,
    private onLine: (line: string) => void,
    private opts: { delimiter?: RegExp; onClose?: () => void } = {},
  ) {
    const delim = opts.delimiter ?? /\n|\0/
    sock.on("data", (chunk: Buffer) => {
      if (this.closed) return
      this.partial += chunk.toString("utf-8")
      const parts = this.partial.split(delim)
      this.partial = parts.pop() ?? "" // last piece may be incomplete
      for (const p of parts) if (p.length) this.onLine(p)
    })
    sock.on("close", () => this.markClosed())
    sock.on("error", () => this.markClosed())
  }
  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    if (this.partial.length) { this.onLine(this.partial); this.partial = "" }
    this.opts.onClose?.()
  }
  get isClosed(): boolean { return this.closed }
  close(): void { try { this.sock.destroy() } catch {}; this.markClosed() }
}

// ── framed-plist stream (notification_proxy) ──────────────────────────────────

/** Wrap a socket that emits framed plist notifications; decode + dispatch each. */
export class PlistFrameStream {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false
  constructor(
    private sock: Sock,
    private onFrame: (v: PlistValue) => void,
    private opts: { onError?: (e: Error) => void; onClose?: () => void; maxBytes?: number } = {},
  ) {
    const max = opts.maxBytes ?? DEFAULT_PLIST_LIMITS.maxBytes
    sock.on("data", (chunk: Buffer) => {
      if (this.closed) return
      this.acc = Buffer.concat([this.acc, chunk])
      try {
        let frame = tryReadLockdownFrame(this.acc)
        while (frame) {
          this.acc = frame.rest
          this.onFrame(decodePlist(frame.body, { ...DEFAULT_PLIST_LIMITS, maxBytes: max }))
          frame = tryReadLockdownFrame(this.acc)
        }
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
        this.close()
      }
    })
    sock.on("close", () => { this.closed = true; this.opts.onClose?.() })
    sock.on("error", (e) => { this.opts.onError?.(e instanceof Error ? e : new Error(String(e))); this.close() })
  }
  send(dict: PlistDict): void { if (!this.closed) this.sock.write(encodeLockdownFrame(dict)) }
  get isClosed(): boolean { return this.closed }
  close(): void { if (this.closed) return; this.closed = true; try { this.sock.destroy() } catch {} }
}

// ── typed plist accessors ─────────────────────────────────────────────────────

export function asDict(v: PlistValue | undefined): Record<string, PlistValue> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, PlistValue>) : undefined
}
export function pStr(v: PlistValue | undefined): string | undefined { return typeof v === "string" ? v : undefined }
export function pNum(v: PlistValue | undefined): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined }
