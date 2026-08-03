/**
 * daemon/ios/instruments.ts — the DTX / Instruments lane.
 *
 * `com.apple.instruments.dtservicehub` is a DIRECT RSD service (no `.shim.remote`
 * suffix), reached exactly like `com.apple.dt.testmanagerd.remote` which our
 * runner already drives on iOS 27. We ride the shared tunnel (tunnel-pool.ts),
 * open a DtxConnection, request per-capability channels, and call selectors:
 *
 *   deviceinfo.runningProcesses           → process list
 *   sysmontap.setConfig:+start            → per-process CPU/mem samples (stream)
 *   processcontrol.launch…/killPid:       → launch (env/args) / kill
 *   LocationSimulation.simulate…/stop…    → fake GPS
 *   graphics.opengl sampling              → FPS/GPU (stream)
 *   applicationListing.installedApps…     → fast app inventory
 *
 * Replies are NSKeyedArchiver-encoded → nskeyedUnarchive. Pure protocol glue over
 * the proven DtxConnection; no new dependencies.
 */

import { DtxConnection, type DtxMsg, type PlistNode } from "./usertunnel"
import { acquireTunnel, releaseTunnel } from "./tunnel-pool"
import { nskeyedUnarchive } from "./nskeyed"
import { DEFAULT_PLIST_LIMITS } from "./webinspector-plist"
import { IOS_DEV_SERVICE, INSTRUMENTS_CHANNEL } from "../../shared/ios-dev"

// A screenshot PNG is a genuine multi-MiB nskeyed <data> leaf; allow a leaf up to
// the frame cap (still bounded by maxBytes). Same class as the wallpaper.
const IMAGE_LIMITS = { ...DEFAULT_PLIST_LIMITS, maxLeafBytes: DEFAULT_PLIST_LIMITS.maxBytes }
const SCREENSHOT_CHANNEL = "com.apple.instruments.server.services.screenshot"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Decode a DTX reply's return value (nskeyed) from payload, else aux. */
function decodeReturn(m: DtxMsg | null): unknown {
  if (!m) return null
  if (m.payloadRaw && m.payloadRaw.length) {
    try { return nskeyedUnarchive(m.payloadRaw) } catch { /* fall through */ }
  }
  // Some selectors return the value as the first archived aux entry.
  for (const a of aux(m)) if (Buffer.isBuffer(a)) { try { return nskeyedUnarchive(a) } catch {} }
  return null
}

// Minimal aux byte-array extractor (parseAux lives in usertunnel; re-derive the
// byte entries we care about without exporting the whole primitive parser).
function aux(m: DtxMsg): Buffer[] {
  const out: Buffer[] = []
  const b = m.aux
  let o = 0
  while (o + 4 <= b.length) {
    const t = b.readUInt32LE(o); o += 4
    if (t === 0x0a) continue            // null
    if (t === 0x03) { o += 4; continue } // uint32
    if (t === 0x06) { o += 8; continue } // int64
    if (t === 0x02 || t === 0x01) { const l = b.readUInt32LE(o); o += 4; out.push(b.subarray(o, o + l)); o += l; continue }
    break
  }
  return out
}

export type IosProcess = { pid: number; name: string; realAppName?: string; startDate?: unknown; foregroundRunning?: boolean }

/** A live Instruments session over the shared tunnel. Reuse for multiple calls;
 *  hold open for streaming channels. */
export class InstrumentsClient {
  private constructor(private dtx: DtxConnection, private udid: string) {}

  static async open(udid: string, log: (m: string) => void = () => {}): Promise<InstrumentsClient> {
    const { tun, services } = await acquireTunnel(udid, log)
    try {
      const port = services[IOS_DEV_SERVICE.instruments]
      if (!port) throw new Error(`service ${IOS_DEV_SERVICE.instruments} not found (tunnel_unavailable)`)
      const chan = await tun.connect(port)
      const dtx = new DtxConnection(chan, "inst")
      await delay(400) // let the device push _notifyOfPublishedCapabilities (auto-acked)
      return new InstrumentsClient(dtx, udid)
    } catch (e) { releaseTunnel(udid); throw e }
  }

  /** Release the DTX channel AND the shared tunnel (so the runner can reclaim it). */
  close(): void { this.dtx.close(); releaseTunnel(this.udid) }

  private async channel(identifier: string): Promise<number> {
    try { return await this.dtx.requestChannelIdentifier(identifier) }
    catch (e) { throw new Error(`dtx channel ${identifier} failed: ${(e as Error).message}`) }
  }

  /** Instruments screenshot service → a full-screen PNG. Runner-free; needs the DDI
   *  mounted (same tier as dtservicehub itself). Returns the raw PNG bytes. */
  async screenshot(): Promise<Buffer> {
    const code = await this.channel(SCREENSHOT_CHANNEL)
    const reply = await this.dtx.channelCall(code, "takeScreenshot", [])
    const raw = reply?.payloadRaw
    if (!raw || !raw.length) throw new Error("instruments screenshot: empty reply")
    const v = nskeyedUnarchive(raw, IMAGE_LIMITS)
    if (Buffer.isBuffer(v)) return v
    if (v && typeof v === "object" && Buffer.isBuffer((v as { $data?: Buffer }).$data)) return (v as { $data: Buffer }).$data
    throw new Error("instruments screenshot: reply was not image data")
  }

  /** deviceinfo.runningProcesses → live process list. */
  async runningProcesses(): Promise<IosProcess[]> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.deviceinfo)
    const reply = await this.dtx.channelCall(code, "runningProcesses", [])
    const arr = decodeReturn(reply)
    return Array.isArray(arr) ? (arr as IosProcess[]) : []
  }

  /** processcontrol.launch… → pid of the launched (running) process. */
  async launch(bundleId: string, opts: { env?: Record<string, string>; args?: string[]; suspended?: boolean } = {}): Promise<number> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.processcontrol)
    const env: Record<string, PlistNode> = {}
    for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = { str: v }
    const args: PlistNode[] = (opts.args ?? []).map((a) => ({ str: a }))
    const reply = await this.dtx.channelCall(code, "launchSuspendedProcessWithDevicePath:bundleIdentifier:environment:arguments:options:", [
      { str: "" },
      { str: bundleId },
      { dict: env },
      { arr: args },
      { dict: { StartSuspendedKey: { int: opts.suspended ? 1 : 0 }, KillExisting: { int: 1 } } },
    ])
    const pid = decodeReturn(reply)
    return typeof pid === "number" ? pid : Number(pid) || 0
  }

  /** processcontrol.killPid: */
  async kill(pid: number): Promise<void> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.processcontrol)
    await this.dtx.channelCall(code, "killPid:", [{ int: pid }], false)
  }

  /** LocationSimulation.simulateLocationWithLatitude:longitude: */
  async setLocation(lat: number, lon: number): Promise<void> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.location)
    await this.dtx.channelCall(code, "simulateLocationWithLatitude:longitude:", [{ real: lat }, { real: lon }], false)
  }

  /** LocationSimulation.stopLocationSimulation */
  async clearLocation(): Promise<void> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.location)
    await this.dtx.channelCall(code, "stopLocationSimulation", [], false)
  }

  /**
   * sysmontap: per-process CPU/mem samples. Opens the channel, pushes a config,
   * starts sampling, and delivers each sample to `onSample` until `stop()` is
   * called (returned). Samples arrive as unsolicited channel frames.
   */
  async startSysmontap(onSample: (sample: unknown) => void, intervalMs = 1000): Promise<() => void> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.sysmontap)
    const config: Record<string, PlistNode> = {
      ur: { int: intervalMs },
      bm: { int: 0 },
      cpuUsage: { int: 1 },
      sampleInterval: { int: intervalMs * 1_000_000 },
      procAttrs: { arr: ["pid", "name", "cpuUsage", "physFootprint", "memResidentSize"].map((s) => ({ str: s })) },
      sysAttrs: { arr: ["physMemSize", "vmFreeCount"].map((s) => ({ str: s })) },
    }
    await this.dtx.channelCall(code, "setConfig:", [{ dict: config }])
    // sysmontap pushes samples on the device's OWN channel (-1), not `code`, so a
    // per-channel listener misses them. Use a broadcast that decodes any non-global
    // frame; emit the per-process sample arrays (skip the tiny {k,tv} control taps).
    this.dtx.onBroadcast((m) => {
      const v = decodeReturn(m)
      if (v == null) return false
      if (Array.isArray(v)) { onSample(v); return true }        // per-process + system sample
      onSample(v); return true                                   // control tap ({k,tv}) — still consumed
    })
    await this.dtx.channelCall(code, "start", [], false)
    return () => { this.dtx.offBroadcast(); this.dtx.channelCall(code, "stop", [], false).catch(() => {}) }
  }

  /** graphics.opengl FPS/GPU sampling stream. */
  async startGraphics(onSample: (sample: unknown) => void, intervalMs = 1000): Promise<() => void> {
    const code = await this.channel(INSTRUMENTS_CHANNEL.graphics)
    await this.dtx.channelCall(code, "setSamplingRate:", [{ real: intervalMs / 1000 }])
    this.dtx.onBroadcast((m) => { const v = decodeReturn(m); if (v != null && typeof v === "object") { onSample(v); return true } return false })
    await this.dtx.channelCall(code, "startSamplingAtTimeInterval:", [{ real: 0 }], false)
    return () => { this.dtx.offBroadcast(); this.dtx.channelCall(code, "stopSampling", [], false).catch(() => {}) }
  }
}

export { decodeReturn as _decodeReturn }
