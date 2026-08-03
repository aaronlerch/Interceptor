/**
 * daemon/ios/screenshotr.ts — runner-free one-shot screenshot.
 *
 * `com.apple.mobile.screenshotr` is DDI-gated (it only appears in the RSD service
 * map once the Developer Disk Image is mounted). On our iOS-27 test device the
 * DDI is NOT mounted, so this honestly reports `ddi_not_mounted`. When the DDI is
 * present, we run the DeviceLink handshake (version-exchange → device-ready →
 * ScreenShotRequest) and return the PNG/TIFF bytes.
 *
 * DeviceLink messages are 4-byte-BE-length + binary-plist ARRAYS. We decode with
 * the shared bounded `decodePlist`; requests are encoded as compact XML plist
 * arrays (lockdownd accepts either form).
 */

import { acquireTunnel, releaseTunnel } from "./tunnel-pool"
import type { RemoteXpcTunnel } from "./usertunnel"
import { decodePlist, type PlistValue } from "./webinspector-plist"
import { IOS_DEV_SERVICE } from "../../shared/ios-dev"

const SCREENSHOTR_NAMES = [
  "com.apple.mobile.screenshotr.shim.remote",
  IOS_DEV_SERVICE.screenshotr,
]

function xmlValue(v: unknown): string {
  if (typeof v === "string") return `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).map(([k, val]) => `<key>${k}</key>${xmlValue(val)}`).join("")
    return `<dict>${e}</dict>`
  }
  return "<string></string>"
}

/** Encode a DeviceLink message (array) as a 4-byte-BE-length + XML plist frame. */
function encodeDl(items: unknown[]): Buffer {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array>${items.map(xmlValue).join("")}</array></plist>`
  const b = Buffer.from(body, "utf8")
  const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0)
  return Buffer.concat([len, b])
}

type Chan = { write: (b: Buffer) => void; onData: (cb: (b: Buffer) => void) => void; onClose: (cb: () => void) => void; close: () => void }

/** Read one DL frame (4-byte-BE length + plist) from a channel with a timeout. */
function readDl(chan: Chan, acc: { buf: Buffer }, timeoutMs = 8000): Promise<PlistValue> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("screenshotr: DL read timed out")), timeoutMs)
    const tryParse = () => {
      if (acc.buf.length < 4) return false
      const len = acc.buf.readUInt32BE(0)
      if (acc.buf.length < 4 + len) return false
      const body = acc.buf.subarray(4, 4 + len)
      acc.buf = acc.buf.subarray(4 + len)
      clearTimeout(timer)
      try { resolve(decodePlist(Buffer.from(body))) } catch (e) { reject(e as Error) }
      return true
    }
    if (tryParse()) return
    chan.onData((c) => { acc.buf = Buffer.concat([acc.buf, c]); tryParse() })
  })
}

/** Capture a screenshot. Throws `ddi_not_mounted`-classified error if unavailable. */
export async function captureScreenshot(udid: string, log: (m: string) => void = () => {}): Promise<Buffer> {
  const { tun, services } = await acquireTunnel(udid, log)
  try {
    return await captureOverTunnel(tun, services)
  } finally {
    releaseTunnel(udid)
  }
}

async function captureOverTunnel(tun: RemoteXpcTunnel["tun"], services: Record<string, number>): Promise<Buffer> {
  const name = SCREENSHOTR_NAMES.find((n) => services[n])
  if (!name) throw new Error("screenshotr not available: Developer Disk Image not mounted (ImageNotMounted)")
  const chan = (await tun.connect(services[name])) as Chan
  const acc = { buf: Buffer.alloc(0) }
  // 1. version exchange
  const ver = await readDl(chan, acc)
  if (Array.isArray(ver) && ver[0] === "DLMessageVersionExchange") {
    const major = typeof ver[1] === "number" ? ver[1] : 400
    chan.write(encodeDl(["DLMessageVersionExchange", "DLVersionsOk", major]))
  }
  // 2. device ready
  const ready = await readDl(chan, acc)
  if (!(Array.isArray(ready) && ready[0] === "DLMessageDeviceReady")) {
    // some builds go straight to ready; tolerate
  }
  // 3. request screenshot
  chan.write(encodeDl(["DLMessageProcessMessage", { MessageType: "ScreenShotRequest" }]))
  const reply = await readDl(chan, acc, 15000)
  try { chan.close() } catch {}
  if (Array.isArray(reply) && reply[0] === "DLMessageProcessMessage") {
    const payload = reply[1] as Record<string, PlistValue>
    const data = payload?.ScreenShotData
    if (Buffer.isBuffer(data)) return data
  }
  throw new Error("screenshotr: no ScreenShotData in reply")
}
