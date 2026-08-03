/**
 * daemon/ios/installer.ts — pure-Bun app install over lockdown.
 *
 * Replaces `xcrun devicectl device install app`. Path: AFC-upload the re-signed
 * `*-Runner.app` into the device's PublicStaging, then drive `installation_proxy`
 * to Install/Upgrade it. Also reads Developer-Mode state (the chicken-and-egg
 * prompt in Part 1.2). installation_proxy speaks the same 4-byte-BE + plist
 * framing as lockdown; AFC has its own header (magic + 4×u64 LE).
 *
 * REAL + offline-testable: the AFC header codec + installation_proxy request
 * builders. LIVE-GATED: the actual transfer/install runs over a lockdown service
 * connection whose TLS upgrade lands in the M0/M1 spike; those throw an explicit
 * error rather than fake success.
 */

import { connectServiceSocket, getValue, encodeLockdownFrame, tryReadLockdownFrame, plistToObject, plistToXml, type PlistDict } from "./lockdown"
import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { basename, join, relative } from "node:path"
import { lstatSync, readdirSync, readFileSync } from "node:fs"

// ── AFC header codec (REAL) ───────────────────────────────────────────────────

export const AFC_MAGIC = "CFA6LPAA"
export const AFC_OP = {
  Status: 0x01, Data: 0x02, ReadDir: 0x03, MakeDir: 0x09,
  FileOpen: 0x0d, FileRead: 0x0f, FileWrite: 0x10, FileClose: 0x14, RemovePath: 0x08,
  FileOpenResult: 0x0e, GetFileInfo: 0x0a,
} as const
/** AFC file-open modes (libimobiledevice afc_file_mode_t). */
export const AFC_MODE = { RdOnly: 1, WrOnly: 3 } as const

const AFC_STATUS = {
  Success: 0,
  ObjectNotFound: 8,
  ObjectExists: 16,
} as const

/** AFC packet header: magic(8) + entire_len(u64) + this_len(u64) + packet_num(u64) + op(u64), all LE. */
export function encodeAfcHeader(op: number, thisLen: number, entireLen: number, packetNum: number): Buffer {
  const h = Buffer.alloc(40)
  h.write(AFC_MAGIC, 0, "ascii")
  h.writeBigUInt64LE(BigInt(entireLen), 8)
  h.writeBigUInt64LE(BigInt(thisLen), 16)
  h.writeBigUInt64LE(BigInt(packetNum), 24)
  h.writeBigUInt64LE(BigInt(op), 32)
  return h
}

export function decodeAfcHeader(buf: Buffer): { op: number; thisLen: number; entireLen: number; packetNum: number } | undefined {
  if (buf.length < 40 || buf.toString("ascii", 0, 8) !== AFC_MAGIC) return undefined
  return {
    entireLen: Number(buf.readBigUInt64LE(8)),
    thisLen: Number(buf.readBigUInt64LE(16)),
    packetNum: Number(buf.readBigUInt64LE(24)),
    op: Number(buf.readBigUInt64LE(32)),
  }
}

// ── installation_proxy requests (REAL builders) ───────────────────────────────

export function installProxyInstallRequest(stagedPath: string, bundleId: string): PlistDict {
  return {
    Command: "Install",
    PackagePath: stagedPath,
    ClientOptions: { PackageType: "Developer", CFBundleIdentifier: bundleId },
  }
}
export function installProxyUpgradeRequest(stagedPath: string, bundleId: string): PlistDict {
  return {
    Command: "Upgrade",
    PackagePath: stagedPath,
    ClientOptions: { PackageType: "Developer", CFBundleIdentifier: bundleId },
  }
}
export function installProxyBrowseRequest(): PlistDict {
  return { Command: "Browse", ClientOptions: { ReturnAttributes: ["CFBundleIdentifier"], ApplicationType: "Any" } }
}
export function installProxyLookupRequest(bundleId: string): PlistDict {
  return { Command: "Lookup", ClientOptions: { BundleIDs: [bundleId] } }
}

/** Frame an installation_proxy request (same 4-byte-BE + plist as lockdown). */
export function encodeInstallProxyFrame(req: PlistDict): Buffer {
  return encodeLockdownFrame(req)
}
export { tryReadLockdownFrame as tryReadInstallProxyFrame }

// ── live ops (M1/M2 transport PROVEN on iOS 26.6) ─────────────────────────────

const IP_SERVICE = "com.apple.mobile.installation_proxy"
const AFC_SERVICE = "com.apple.afc"
const AFC_WRITE_CHUNK = 64 * 1024

class AfcStatusError extends Error {
  constructor(public status: number, op: number) {
    super(`AFC op 0x${op.toString(16)} failed with status ${status}`)
  }
}

type AnyBuffer = Buffer<ArrayBufferLike>
type AfcResponse = { op: number; payload: AnyBuffer; data: AnyBuffer }

function nulString(s: string): AnyBuffer {
  return Buffer.from(`${s}\0`, "utf8")
}

function u64le(v: number | bigint): AnyBuffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v), 0)
  return b
}

function parseNulStrings(buf: AnyBuffer): string[] {
  return buf.toString("utf8").split("\0").filter(Boolean)
}

class AfcClient {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private packet = 1
  private waiters: Array<(r: AfcResponse) => void> = []

  constructor(private sock: Socket | TLSSocket) {
    sock.on("data", (chunk: Buffer) => this.onData(chunk))
  }

  private onData(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk])
    let resp = this.tryRead()
    while (resp) {
      this.waiters.shift()?.(resp)
      resp = this.tryRead()
    }
  }

  private tryRead(): AfcResponse | undefined {
    const h = decodeAfcHeader(this.acc)
    if (!h) return undefined
    if (this.acc.length < h.entireLen) return undefined
    const payloadStart = 40
    const payloadEnd = Math.min(h.thisLen, h.entireLen)
    const resp: AfcResponse = {
      op: h.op,
      payload: Buffer.from(this.acc.subarray(payloadStart, payloadEnd)),
      data: Buffer.from(this.acc.subarray(payloadEnd, h.entireLen)),
    }
    this.acc = this.acc.subarray(h.entireLen)
    return resp
  }

  private request(op: number, payload: AnyBuffer = Buffer.alloc(0), data: AnyBuffer = Buffer.alloc(0), timeoutMs = 30_000): Promise<AfcResponse> {
    const packet = this.packet++
    const thisLen = 40 + payload.length
    const entireLen = thisLen + data.length
    const frame = Buffer.concat([encodeAfcHeader(op, thisLen, entireLen, packet), payload, data])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AFC op 0x${op.toString(16)} timed out`)), timeoutMs)
      this.waiters.push((resp) => {
        clearTimeout(timer)
        try {
          this.assertOk(resp, op)
          resolve(resp)
        } catch (err) {
          reject(err)
        }
      })
      this.sock.write(frame)
    })
  }

  private assertOk(resp: AfcResponse, op: number): void {
    if (resp.op !== AFC_OP.Status) return
    const status = resp.payload.length >= 8 ? Number(resp.payload.readBigUInt64LE(0)) : AFC_STATUS.Success
    if (status !== AFC_STATUS.Success) throw new AfcStatusError(status, op)
  }

  async makeDir(path: string): Promise<void> {
    await this.request(AFC_OP.MakeDir, nulString(path)).catch((err) => {
      if (err instanceof AfcStatusError && err.status === AFC_STATUS.ObjectExists) return
      throw err
    })
  }

  async removePath(path: string): Promise<void> {
    await this.request(AFC_OP.RemovePath, nulString(path)).catch((err) => {
      if (err instanceof AfcStatusError && err.status === AFC_STATUS.ObjectNotFound) return
      throw err
    })
  }

  async readDir(path: string): Promise<string[]> {
    const r = await this.request(AFC_OP.ReadDir, nulString(path))
    return parseNulStrings(Buffer.concat([r.payload, r.data])).filter((n) => n !== "." && n !== "..")
  }

  async removePathRecursive(path: string): Promise<void> {
    try {
      for (const name of await this.readDir(path)) {
        await this.removePathRecursive(`${path}/${name}`)
      }
    } catch (err) {
      if (!(err instanceof AfcStatusError) || err.status !== AFC_STATUS.ObjectNotFound) {
        // Not a directory is fine; the final RemovePath handles files.
      }
    }
    await this.removePath(path)
  }

  async openFile(path: string, fileMode: number = AFC_MODE.WrOnly): Promise<bigint> {
    // WrOnly (3) creates/truncates for staging; RdOnly (1) for pulls.
    const mode = u64le(fileMode)
    const candidates = [
      Buffer.concat([mode, nulString(path)]),
      Buffer.concat([nulString(path), mode]),
    ]
    let lastErr: unknown
    for (const payload of candidates) {
      try {
        const r = await this.request(AFC_OP.FileOpen, payload)
        if (r.op !== AFC_OP.FileOpenResult || r.payload.length < 8) {
          throw new Error(`AFC file open returned unexpected op 0x${r.op.toString(16)}`)
        }
        return r.payload.readBigUInt64LE(0)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`AFC file open failed for ${path}`)
  }

  async writeFile(path: string, data: AnyBuffer): Promise<void> {
    const handle = await this.openFile(path)
    try {
      const handlePayload = u64le(handle)
      for (let off = 0; off < data.length; off += AFC_WRITE_CHUNK) {
        await this.request(AFC_OP.FileWrite, handlePayload, data.subarray(off, off + AFC_WRITE_CHUNK), 60_000)
      }
    } finally {
      await this.request(AFC_OP.FileClose, u64le(handle)).catch(() => {})
    }
  }

  /** Read a whole file off the device (pull). RdOnly open → FileRead loop → close. */
  async readFile(path: string, maxBytes = 64 * 1024 * 1024): Promise<AnyBuffer> {
    const handle = await this.openFile(path, AFC_MODE.RdOnly)
    const chunks: AnyBuffer[] = []
    let total = 0
    try {
      for (;;) {
        const want = 1 << 20 // 1 MiB per read
        const r = await this.request(AFC_OP.FileRead, Buffer.concat([u64le(handle), u64le(want)]), Buffer.alloc(0), 60_000)
        const bytes = Buffer.concat([r.payload, r.data])
        if (bytes.length === 0) break
        total += bytes.length
        if (total > maxBytes) throw new Error(`AFC read exceeded ${maxBytes}-byte cap for ${path}`)
        chunks.push(bytes)
        if (bytes.length < want) break // short read ⇒ EOF
      }
    } finally {
      await this.request(AFC_OP.FileClose, u64le(handle)).catch(() => {})
    }
    return Buffer.concat(chunks)
  }

  close(): void {
    try { this.sock.destroy() } catch {}
  }
}

export { AfcClient, AfcStatusError }
export type { AfcResponse }

/** One framed installation_proxy exchange that streams responses until Status:Complete. */
function browseInstallProxy(sock: Socket | TLSSocket, req: PlistDict, timeoutMs = 20_000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const out: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error("installation_proxy timed out")), timeoutMs)
    sock.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      let f = tryReadLockdownFrame(acc)
      while (f) {
        acc = f.rest
        const obj = plistToObject(f.body)
        out.push(obj)
        if (obj.Error) { clearTimeout(timer); reject(new Error(`installation_proxy: ${String(obj.Error)}`)); return }
        if (obj.Status === "Complete") { clearTimeout(timer); resolve(out); return }
        f = tryReadLockdownFrame(acc)
      }
    })
    sock.on("error", (e) => { clearTimeout(timer); reject(e) })
    sock.write(encodeInstallProxyFrame(req))
  })
}

/** Browse installed bundle ids on the device (real, over TLS). */
export async function browseApps(udid: string): Promise<string[]> {
  const { sock } = await connectServiceSocket(udid, IP_SERVICE)
  try {
    const responses = await browseInstallProxy(sock, installProxyBrowseRequest())
    const ids: string[] = []
    for (const r of responses) {
      const list = r.CurrentList
      if (Array.isArray(list)) for (const a of list) {
        const b = (a as Record<string, unknown>).CFBundleIdentifier
        if (typeof b === "string") ids.push(b)
      }
    }
    return ids
  } finally { try { sock.destroy() } catch {} }
}

/** Is a bundle id installed? (real, over TLS.) */
export async function isAppInstalled(udid: string, bundleId: string): Promise<boolean> {
  return (await browseApps(udid)).includes(bundleId)
}

/** Look up an installed app's on-device Path via installation_proxy Lookup (over TLS). */
export async function lookupAppPath(udid: string, bundleId: string): Promise<string | undefined> {
  const { sock } = await connectServiceSocket(udid, IP_SERVICE)
  return await new Promise<string | undefined>((resolve) => {
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const done = (v: string | undefined) => { clearTimeout(timer); try { sock.destroy() } catch {} ; resolve(v) }
    const timer = setTimeout(() => done(undefined), 10_000)
    sock.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      let f = tryReadLockdownFrame(acc)
      while (f) {
        acc = f.rest
        const xml = plistToXml(f.body)
        const m = xml.match(/<key>Path<\/key>\s*<string>([^<]+)<\/string>/)
        if (m) { done(m[1]); return }
        if (/<key>Status<\/key>\s*<string>Complete<\/string>/.test(xml) || /<key>Error<\/key>/.test(xml)) { done(undefined); return }
        f = tryReadLockdownFrame(acc)
      }
    })
    sock.on("error", () => done(undefined))
    sock.write(encodeInstallProxyFrame({ Command: "Lookup", ClientOptions: { BundleIDs: [bundleId], ReturnAttributes: ["Path", "CFBundleIdentifier"] } }))
  })
}

/** Read whether Developer Mode is enabled — drives the Part 1.2 prompt (real). */
export async function readDeveloperMode(udid: string): Promise<{ enabled: boolean }> {
  const v = await getValue(udid, "com.apple.security.mac.amfi", "DeveloperModeStatus")
  return { enabled: v === true || v === "enabled" || v === 1 }
}

async function uploadAppBundle(udid: string, appPath: string): Promise<string> {
  const appName = basename(appPath)
  const remoteRoot = `PublicStaging/${appName}`
  const { sock } = await connectServiceSocket(udid, AFC_SERVICE)
  const afc = new AfcClient(sock)
  try {
    await afc.makeDir("PublicStaging")
    await afc.removePathRecursive(remoteRoot)
    await afc.makeDir(remoteRoot)

    const walk = async (localDir: string): Promise<void> => {
      for (const name of readdirSync(localDir)) {
        const local = join(localDir, name)
        const rel = relative(appPath, local).split("/").filter(Boolean).join("/")
        const remote = `${remoteRoot}/${rel}`
        const st = lstatSync(local)
        if (st.isDirectory()) {
          await afc.makeDir(remote)
          await walk(local)
        } else if (st.isFile()) {
          await afc.writeFile(remote, readFileSync(local))
        }
      }
    }
    await walk(appPath)
    return remoteRoot
  } finally {
    afc.close()
  }
}

/**
 * Install/upgrade a re-signed `*-Runner.app` on the device: AFC-upload into
 * PublicStaging, then drive installation_proxy Install/Upgrade over lockdown.
 */
export async function installApp(udid: string, appPath: string, bundleId: string): Promise<void> {
  const already = await isAppInstalled(udid, bundleId)
  const stagedPath = await uploadAppBundle(udid, appPath)
  const { sock } = await connectServiceSocket(udid, IP_SERVICE)
  try {
    const req = already ? installProxyUpgradeRequest(stagedPath, bundleId) : installProxyInstallRequest(stagedPath, bundleId)
    await browseInstallProxy(sock, req, 180_000)
  } finally {
    try { sock.destroy() } catch {}
  }
}
