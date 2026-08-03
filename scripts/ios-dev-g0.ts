#!/usr/bin/env bun
/**
 * scripts/ios-dev-g0.ts — Gate G0 harness (test-only, no product behavior).
 *
 *   bun scripts/ios-dev-g0.ts                 # fixture proof (device-free)
 *   bun scripts/ios-dev-g0.ts --udid <udid>   # live proof of each dev/telemetry lane
 *
 * Fixture mode drives the nskeyed / pcap / os_trace codecs over in-memory data,
 * proving the framing without hardware. The live criteria (each lane opening over
 * the tunnel or classic Lockdown on this iOS build) require --udid.
 */

import { nskeyedArchive } from "../daemon/ios/usertunnel"
import { nskeyedUnarchive } from "../daemon/ios/nskeyed"
import { pcapGlobalHeader, pcapPacketRecord, parseIosPacket } from "../daemon/ios/pcapd"
import { _decodeEntry } from "../daemon/ios/ostrace"
import { screenCapability, annexBStream } from "../daemon/ios/screenstream"

const checks: Array<{ n: number; label: string; ok: boolean; note?: string }> = []
const rec = (n: number, label: string, ok: boolean, note?: string) => checks.push({ n, label, ok, note })

function fixtureProof(): void {
  // G0.1 nskeyed round-trip (Instruments reply shape)
  const round = nskeyedUnarchive(nskeyedArchive({ arr: [{ dict: { pid: { int: 501 }, name: { str: "SpringBoard" } } }] }))
  rec(1, "nskeyed archive→unarchive (process record)", Array.isArray(round) && (round as any)[0]?.name === "SpringBoard", JSON.stringify(round))

  // G0.2 pcap file framing
  const gh = pcapGlobalHeader()
  const rc = pcapPacketRecord(1, 2, Buffer.from([0x45, 0, 0, 0]))
  rec(2, "pcap global header + record framing", gh.readUInt32LE(0) === 0xa1b2c3d4 && rc.length === 20, `linktype=${gh.readUInt32LE(20)}`)

  // G0.3 IOSPacketHeader parse (hdr_length + timeval)
  const hdr = Buffer.alloc(24); hdr.writeUInt32BE(24, 0); hdr.writeUInt32BE(1699, 16); hdr.writeUInt32BE(42, 20)
  const p = parseIosPacket(Buffer.concat([hdr, Buffer.from([0x45])]))
  rec(3, "IOSPacketHeader parse (frame + timeval)", p.tsSec === 1699 && p.tsUsec === 42 && p.frame.length === 1)

  // G0.4 os_trace entry decode
  const e = _decodeEntry(Buffer.concat([Buffer.alloc(4), Buffer.from("dasd\0evaluating activity\0", "utf8")]))
  rec(4, "os_trace entry decode (message extraction)", e.message === "evaluating activity", e.message)

  // G0.5 Annex-B stream writer + honest screen gate
  const ab = annexBStream({ nals: [Buffer.from([0x67, 0x42]), Buffer.from([0x68, 0xce])] })
  const cap = screenCapability()
  rec(5, "Annex-B writer + honest screen capability gate", ab.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])) && cap.available === false, cap.code)
}

async function deviceProof(udid: string): Promise<void> {
  console.log(`\n── live dev/telemetry proof (udid ${udid.slice(0, 8)}…) ──`)
  const { InstrumentsClient } = await import("../daemon/ios/instruments")
  const { openOsTrace } = await import("../daemon/ios/ostrace")
  const { openPcap } = await import("../daemon/ios/pcapd")
  const { backupInfo } = await import("../daemon/ios/backup")
  const { captureScreenshot } = await import("../daemon/ios/screenshotr")
  const { axAuditProbe } = await import("../daemon/ios/axaudit")
  const { BoundedBuffer } = await import("../daemon/ios/service-plist")
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { const r = await fn(); console.log(`  ✓ ${label}: ${JSON.stringify(r).slice(0, 200)}`) }
    catch (e) { console.log(`  ✗ ${label}: ${(e as Error).message}`) }
  }
  await step("instruments deviceinfo.runningProcesses", async () => {
    const inst = await InstrumentsClient.open(udid)
    try { const ps = await inst.runningProcesses(); return `${ps.length} processes, e.g. ${ps.slice(0, 3).map((p) => p.name).join(", ")}` }
    finally { inst.close() }
  })
  await step("instruments sysmontap (1 sample)", async () => {
    const inst = await InstrumentsClient.open(udid)
    try {
      let sample: unknown = null
      const stop = await inst.startSysmontap((s) => { sample ??= s })
      await new Promise((r) => setTimeout(r, 2500)); stop()
      return sample ? "got a sysmontap sample" : "opened, no sample in 2.5s"
    } finally { inst.close() }
  })
  await step("os_trace_relay (2s)", async () => {
    const buf = new BoundedBuffer()
    const s = await openOsTrace(udid, buf as any)
    await new Promise((r) => setTimeout(r, 2000)); s.close()
    const d = buf.drain(); return `${d.items.length} log entries`
  })
  await step("pcapd (2s)", async () => {
    const buf = new BoundedBuffer()
    const s = await openPcap(udid, buf as any)
    await new Promise((r) => setTimeout(r, 2000)); s.close()
    const d = buf.drain(); return `${d.items.length} packets captured`
  })
  await step("screenshotr", () => captureScreenshot(udid).then((b) => `${b.length} bytes PNG`))
  await step("mobilebackup2 handshake", () => backupInfo(udid))
  await step("axAuditDaemon probe", () => axAuditProbe(udid))
  console.log("  (sanitize any output before committing a fixture)")
}

async function main(): Promise<void> {
  const udid = process.argv.includes("--udid") ? process.argv[process.argv.indexOf("--udid") + 1] : undefined
  fixtureProof()
  console.log("\n═══ Gate G0 ═══")
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} G0.${c.n} ${c.label}${c.note ? `  — ${c.note}` : ""}`)
  const passed = checks.filter((c) => c.ok).length
  console.log(`\nfixture machinery: ${passed}/${checks.length} satisfied in-memory.`)
  console.log("Live criteria (each lane opening over the tunnel / classic Lockdown) require --udid on a paired iPhone.")
  if (udid) await deviceProof(udid)
  if (passed < checks.length && !udid) process.exitCode = 1
}

if (import.meta.main) main().catch((e) => { console.error("G0 FATAL:", e); process.exit(1) })
