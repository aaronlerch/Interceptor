/**
 * daemon/ios/ostrace.ts — live unified-log stream via os_trace_relay.
 *
 * The modern replacement for the classic `syslog_relay`, which opens but streams
 * NOTHING on iOS 27 (recorded in live findings). `os_trace_relay` carries
 * the real unified log. Classic Lockdown service (connectServiceSocket), so it
 * avoids the iOS-27 `.shim.remote` handshake regression.
 *
 * Wire protocol: a framed-plist `StartActivity` handshake, then a raw binary
 * stream of entries, each prefixed by a `0x02` sentinel + little-endian uint32
 * length. Each entry is a packed kernel log struct; we frame it exactly and
 * extract the human-readable fields (printable NUL-terminated strings: process,
 * message, subsystem/category) robustly — structured offsets are refined live.
 */

import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { connectServiceSocket, encodeLockdownFrame, tryReadLockdownFrame } from "./lockdown"
import { BoundedBuffer } from "./service-plist"
import type { BufferedItem } from "./service-plist"

type Sock = Socket | TLSSocket

const SENTINEL = 0x02

export type OsTraceEntry = {
  at: string
  pid?: number
  process?: string
  message: string
  strings: string[]
}

/** Pull the printable NUL-terminated ASCII/UTF-8 runs out of an entry body. */
function printableRuns(buf: Buffer, min = 2): string[] {
  const out: string[] = []
  let start = -1
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0
    const printable = b >= 0x20 && b < 0x7f
    if (printable) { if (start < 0) start = i }
    else { if (start >= 0 && i - start >= min) out.push(buf.subarray(start, i).toString("utf8")); start = -1 }
  }
  return out
}

function decodeEntry(body: Buffer): OsTraceEntry {
  const strings = printableRuns(body)
  // Heuristic: the process/image name is usually a short path-like run; the
  // message is the longest run. Refined against the live device.
  let process: string | undefined
  const proc = strings.find((s) => s.startsWith("/") || /^[\w.-]+$/.test(s))
  if (proc) process = proc.split("/").pop()
  const message = strings.reduce((a, b) => (b.length > a.length ? b : a), "")
  // A plausible pid sits in the first 8 bytes as a little-endian int on most builds.
  const pid = body.length >= 4 ? body.readUInt32LE(0) : undefined
  return { at: new Date().toISOString(), pid: pid && pid < 1_000_000 ? pid : undefined, process, message, strings }
}

/** Frame the 0x02 + LE-u32-length + body stream, emitting one entry at a time. */
class OsTraceFramer {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false
  constructor(sock: Sock, private onEntry: (e: OsTraceEntry) => void) {
    sock.on("data", (c: Buffer) => this.feed(c))
    sock.on("close", () => { this.closed = true })
    sock.on("error", () => { this.closed = true })
  }
  private feed(chunk: Buffer): void {
    this.acc = this.acc.length ? Buffer.concat([this.acc, chunk]) : chunk
    // skip any leading framed-plist status the device may still be flushing
    for (;;) {
      // find the next sentinel
      const s = this.acc.indexOf(SENTINEL)
      if (s < 0) { if (this.acc.length > 1 << 20) this.acc = Buffer.alloc(0); return }
      if (this.acc.length < s + 5) { this.acc = this.acc.subarray(s); return }
      const len = this.acc.readUInt32LE(s + 1)
      if (len > 8 * 1024 * 1024) { this.acc = this.acc.subarray(s + 1); continue } // bogus, resync
      if (this.acc.length < s + 5 + len) { this.acc = this.acc.subarray(s); return }
      const body = this.acc.subarray(s + 5, s + 5 + len)
      this.acc = this.acc.subarray(s + 5 + len)
      try { this.onEntry(decodeEntry(Buffer.from(body))) } catch { /* skip bad entry */ }
    }
  }
  get isClosed(): boolean { return this.closed }
}

export type OsTraceStream = { buffer: BoundedBuffer<BufferedItem>; close: () => void; isClosed: () => boolean }

/** Open a live os_trace_relay stream into a bounded buffer. Optional regex filter. */
export async function openOsTrace(udid: string, buffer: BoundedBuffer<BufferedItem>, filter?: RegExp, pid = -1): Promise<OsTraceStream> {
  const { sock } = await connectServiceSocket(udid, "com.apple.os_trace_relay")
  // Handshake: framed-plist StartActivity, then consume the status reply if present.
  const handshakeDone = new Promise<void>((resolve) => {
    let acc = Buffer.alloc(0)
    const onData = (c: Buffer) => {
      acc = Buffer.concat([acc, c])
      const frame = tryReadLockdownFrame(acc)
      if (frame) { sock.removeListener("data", onData); resolve() }
      else if (acc.indexOf(SENTINEL) >= 0) { sock.removeListener("data", onData); sock.unshift(acc); resolve() }
    }
    sock.on("data", onData)
    // some builds stream immediately with no status frame
    setTimeout(() => { sock.removeListener("data", onData); resolve() }, 600)
  })
  sock.write(encodeLockdownFrame({ Request: "StartActivity", MessageFilter: 65535, Pid: pid, StreamFlags: 60 }))
  await handshakeDone
  const framer = new OsTraceFramer(sock, (e) => {
    if (filter && !(filter.test(e.message) || (e.process && filter.test(e.process)))) return
    buffer.push(e as unknown as BufferedItem)
  })
  return { buffer, close: () => { try { sock.destroy() } catch {} }, isClosed: () => framer.isClosed }
}

export { decodeEntry as _decodeEntry, printableRuns as _printableRuns }
