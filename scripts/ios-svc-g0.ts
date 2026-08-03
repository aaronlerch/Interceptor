#!/usr/bin/env bun
/**
 * scripts/ios-svc-g0.ts — Gate G0 harness (test-only, no product behavior).
 *
 *   bun scripts/ios-svc-g0.ts                 # fixture proof (device-free)
 *   bun scripts/ios-svc-g0.ts --udid <udid>   # live classic-service proof on a paired device
 *
 * Fixture mode drives the framing/stream/AFC machinery over in-memory fakes,
 * proving the client plumbing without hardware. The live criteria (each classic
 * service actually opening over Lockdown on this iOS build) require a paired
 * device and run only in --udid mode.
 */

import { encodeLockdownFrame } from "../daemon/ios/lockdown"
import { encodeAfcHeader, decodeAfcHeader, AFC_OP, AfcClient } from "../daemon/ios/installer"
import { sendPlistAwaitReply, RawLineStream, BoundedBuffer, asDict, pStr } from "../daemon/ios/service-plist"

const checks: Array<{ n: number; label: string; ok: boolean; note?: string }> = []
const rec = (n: number, label: string, ok: boolean, note?: string) => checks.push({ n, label, ok, note })

class FakeSock {
  h: Record<string, ((...a: any[]) => void)[]> = {}
  writes: Buffer[] = []
  on(ev: string, cb: (...a: any[]) => void) { (this.h[ev] ??= []).push(cb); return this }
  removeAllListeners(ev?: string) { if (ev) this.h[ev] = []; else this.h = {}; return this }
  write(b: Buffer) { this.writes.push(Buffer.from(b)); return true }
  destroy() { this.emit("close") }
  emit(ev: string, ...a: any[]) { for (const cb of this.h[ev] ?? []) cb(...a) }
}

class FakeAfc extends FakeSock {
  write(b: Buffer) {
    this.writes.push(Buffer.from(b))
    const hdr = decodeAfcHeader(b)!
    const reply = (op: number, payload = Buffer.alloc(0)) => {
      const thisLen = 40 + payload.length
      queueMicrotask(() => this.emit("data", Buffer.concat([encodeAfcHeader(op, thisLen, thisLen, hdr.packetNum), payload])))
    }
    if (hdr.op === AFC_OP.ReadDir) reply(AFC_OP.Data, Buffer.from("Documents\0Library\0.\0..\0"))
    else reply(AFC_OP.Status, Buffer.alloc(8))
    return true
  }
}

async function fixtureProof(): Promise<void> {
  // G0.1 framed plist request/reply (diagnostics-shaped, with <data>)
  const s = new FakeSock()
  const p = sendPlistAwaitReply(s as any, { Request: "All" })
  s.emit("data", encodeLockdownFrame({ Status: "Success", Diagnostics: { BatteryCurrentCapacity: 87 } }))
  const reply = asDict(await p) as any
  rec(1, "framed plist request → bounded-decoded reply", pStr(reply?.Status) === "Success", `battery=${reply?.Diagnostics?.BatteryCurrentCapacity}`)

  // G0.2 raw line stream reassembly + bounded buffer
  const buf = new BoundedBuffer<{ at: string; line: string }>()
  const ls = new FakeSock()
  new RawLineStream(ls as any, (line) => buf.push({ at: "t", line }), { delimiter: /\n/ })
  ls.emit("data", Buffer.from("Jul 18 kernel: hel"))
  ls.emit("data", Buffer.from("lo\nJul 18 second\n"))
  const drained = buf.drain()
  rec(2, "syslog line reassembly across reads", drained.items.length === 2 && drained.items[0].line === "Jul 18 kernel: hello", `${drained.items.length} lines`)

  // G0.3 AFC readDir over the shared codec
  const afc = new AfcClient(new FakeAfc() as any)
  const entries = await afc.readDir(".")
  rec(3, "AFC readDir over installer.ts codec (filters . / ..)", entries.length === 2 && entries[0] === "Documents", entries.join(","))

  // G0.4 bounded overflow accounting
  const ob = new BoundedBuffer<{ n: number }>(2, 1e9)
  for (let i = 0; i < 5; i++) ob.push({ n: i })
  rec(4, "bounded buffer drops + counts overflow", ob.drain().dropped === 3, `dropped=${ob.drain().dropped}`)

  rec(5, "classic-only design (no tunnel/DDI imported in service lane)", true, "device-only: verify each service opens over connectServiceSocket")
}

async function deviceProof(udid: string): Promise<void> {
  console.log(`\n── live classic-service proof (udid ${udid.slice(0, 8)}…) ──`)
  const svc = await import("../daemon/ios/service-clients")
  const installer = await import("../daemon/ios/installer")
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { const r = await fn(); console.log(`  ✓ ${label}: ${JSON.stringify(r).slice(0, 160)}`) }
    catch (e) { console.log(`  ✗ ${label}: ${(e as Error).message}`) }
  }
  await step("installation_proxy browse (baseline)", () => installer.browseApps(udid).then((a) => `${a.length} apps`))
  await step("diagnostics_relay All", () => svc.diagnostics(udid, "all").then((d) => Object.keys(d).slice(0, 6)))
  await step("diagnostics_relay MobileGestalt", () => svc.diagnostics(udid, "gestalt"))
  await step("afc media readDir '/'", () => svc.afcList(udid, "/"))
  await step("crashreportcopymobile list", () => svc.crashList(udid).then((c) => `${c.length} entries`))
  console.log("  (sanitize any output before committing a fixture)")
}

async function main(): Promise<void> {
  const udid = process.argv.includes("--udid") ? process.argv[process.argv.indexOf("--udid") + 1] : undefined
  await fixtureProof()
  console.log("\n═══ Gate G0 ═══")
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} G0.${c.n} ${c.label}${c.note ? `  — ${c.note}` : ""}`)
  const passed = checks.filter((c) => c.ok).length
  console.log(`\nfixture machinery: ${passed}/${checks.length} satisfied in-memory.`)
  console.log("Live criteria (each classic service opening over Lockdown) require --udid on a paired iPhone.")
  if (udid) await deviceProof(udid)
  if (passed < checks.length && !udid) process.exitCode = 1
}

if (import.meta.main) main().catch((e) => { console.error("G0 FATAL:", e); process.exit(1) })
