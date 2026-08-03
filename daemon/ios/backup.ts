/**
 * daemon/ios/backup.ts — mobilebackup2 lane.
 *
 * `com.apple.mobilebackup2` (classic DeviceLink) is the full/partial backup
 * service. This client establishes the DeviceLink session and negotiates the
 * mobilebackup2 protocol version (the verifiable, non-destructive core):
 *
 *   version-exchange → DLMessageProcessMessage{Hello, SupportedProtocolVersions}
 *   ← device replies with ErrorCode 0 + ProtocolVersion
 *
 * A full snapshot is a large multi-file transfer loop (DLMessageDownloadFiles /
 * UploadFiles / MoveFiles / ContentsOfDirectory), sensitive and slow; it is
 * scaffolded on this handshake and tracked as a follow-up. We do
 * NOT crack backup encryption or extract the keychain (a non-goal).
 *
 * ponytail: DL framing mirrors screenshotr.ts; extract to a devicelink.ts module
 * if a third consumer appears.
 */

import { connectServiceSocket } from "./lockdown"
import { decodePlist, type PlistValue } from "./webinspector-plist"
import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"

type Sock = Socket | TLSSocket

const MB2_VERSIONS = [2.0, 2.1]

function xmlValue(v: unknown): string {
  if (typeof v === "string") return `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (Array.isArray(v)) return `<array>${v.map(xmlValue).join("")}</array>`
  if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).map(([k, val]) => `<key>${k}</key>${xmlValue(val)}`).join("")
    return `<dict>${e}</dict>`
  }
  return "<string></string>"
}

function encodeDl(items: unknown[]): Buffer {
  const body = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${items.map(xmlValue).join("")}</array></plist>`
  const b = Buffer.from(body, "utf8")
  const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0)
  return Buffer.concat([len, b])
}

class DlReader {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private waiters: Array<(v: PlistValue) => void> = []
  private queue: PlistValue[] = []
  constructor(sock: Sock) { sock.on("data", (c: Buffer) => this.feed(c)) }
  private feed(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk])
    for (;;) {
      if (this.acc.length < 4) return
      const len = this.acc.readUInt32BE(0)
      if (this.acc.length < 4 + len) return
      const body = this.acc.subarray(4, 4 + len)
      this.acc = this.acc.subarray(4 + len)
      let v: PlistValue
      try { v = decodePlist(Buffer.from(body)) } catch { continue }
      const w = this.waiters.shift()
      if (w) w(v); else this.queue.push(v)
    }
  }
  read(timeoutMs = 10000): Promise<PlistValue> {
    const q = this.queue.shift()
    if (q !== undefined) return Promise.resolve(q)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mobilebackup2: DL read timed out")), timeoutMs)
      this.waiters.push((v) => { clearTimeout(t); resolve(v) })
    })
  }
}

export type BackupInfo = { ready: boolean; protocolVersion?: number; errorCode?: number; raw?: unknown }

/** Open mobilebackup2, run the DeviceLink + Hello handshake, return negotiated info. */
export async function backupInfo(udid: string): Promise<BackupInfo> {
  const { sock } = await connectServiceSocket(udid, "com.apple.mobilebackup2")
  const reader = new DlReader(sock)
  try {
    // 1. version exchange
    const ver = await reader.read()
    if (Array.isArray(ver) && ver[0] === "DLMessageVersionExchange") {
      const major = typeof ver[1] === "number" ? ver[1] : 400
      sock.write(encodeDl(["DLMessageVersionExchange", "DLVersionsOk", major]))
    }
    // 2. device ready (tolerate builds that skip it)
    const ready = await reader.read().catch(() => null)
    void ready
    // 3. Hello with our supported protocol versions
    sock.write(encodeDl(["DLMessageProcessMessage", { MessageName: "Hello", SupportedProtocolVersions: MB2_VERSIONS }]))
    const reply = await reader.read()
    if (Array.isArray(reply) && reply[0] === "DLMessageProcessMessage") {
      const p = reply[1] as Record<string, PlistValue>
      const errorCode = typeof p?.ErrorCode === "number" ? p.ErrorCode : undefined
      const protocolVersion = typeof p?.ProtocolVersion === "number" ? p.ProtocolVersion : undefined
      return { ready: errorCode === 0, protocolVersion, errorCode, raw: p }
    }
    return { ready: false, raw: reply }
  } finally {
    try { sock.destroy() } catch {}
  }
}
