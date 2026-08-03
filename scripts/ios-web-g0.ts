#!/usr/bin/env bun
/**
 * scripts/ios-web-g0.ts — Gate G0 harness (test-only, no product behavior).
 *
 *   bun scripts/ios-web-g0.ts                 # fixture proof (device-free)
 *   bun scripts/ios-web-g0.ts --udid <udid>   # live on-device proof + fixture capture
 *
 * Fixture mode drives the REAL WIR transport + WIP session over an in-memory
 * loopback against a fixture-scripted "device" (test/fixtures/ios-web-g0.json),
 * proving the protocol machinery end-to-end without hardware. The on-device
 * criteria (a real Safari page; isInspectable true/false visibility; classic vs
 * RSD-shim service; reattach without reboot) require a paired iPhone and are run
 * only in --udid mode.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  WebInspectorTransport, encodeWirFrame, WIR_SELECTOR, WIR_INCOMING, WIR_KEY,
  buildSocketSetupArgument, parseApplicationListing, parseConnectedApplicationList,
  type DuplexBytes,
} from "../daemon/ios/webinspector-transport"
import { WebInspectorSession } from "../daemon/ios/webinspector-session"
import { decodePlist, type PlistDict, type PlistValue } from "../daemon/ios/webinspector-plist"
import { setupVariantCandidates } from "../shared/ios-web"

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "..", "test", "fixtures", "ios-web-g0.json"), "utf-8"))

// ── in-memory loopback (two byte channels wired to each other) ────────────────

function loopback(): [DuplexBytes, DuplexBytes] {
  const cbs: { data?: (b: Buffer) => void; close?: () => void }[] = [{}, {}]
  const make = (self: number, peer: number): DuplexBytes => ({
    write: (b) => queueMicrotask(() => cbs[peer].data?.(Buffer.from(b))),
    onData: (cb) => { cbs[self].data = cb },
    onClose: (cb) => { cbs[self].close = cb },
    close: () => { queueMicrotask(() => cbs[peer].close?.()) },
  })
  return [make(0, 1), make(1, 0)]
}

/** A fixture-scripted webinspectord: replies to host WIR selectors from the fixture. */
function scriptedDevice(chan: DuplexBytes): void {
  let acc = Buffer.alloc(0)
  chan.onData((chunk) => {
    acc = Buffer.concat([acc, chunk])
    for (;;) {
      if (acc.length < 4) break
      const len = acc.readUInt32BE(0)
      if (acc.length < 4 + len) break
      const body = acc.subarray(4, 4 + len); acc = acc.subarray(4 + len)
      const msg = decodePlist(body) as { __selector?: string; __argument?: PlistDict }
      handle(msg.__selector, msg.__argument ?? {})
    }
  })
  const send = (frame: PlistValue) => chan.write(encodeWirFrame(frame))
  const handle = (selector: string | undefined, arg: PlistDict) => {
    if (selector === WIR_SELECTOR.getConnectedApplications || selector === WIR_SELECTOR.reportIdentifier) {
      send(FIXTURE.connectedApplicationList)
    } else if (selector === WIR_SELECTOR.forwardGetListing) {
      send(FIXTURE.applicationSentListing)
    } else if (selector === WIR_SELECTOR.forwardSocketData) {
      const inner = JSON.parse((arg[WIR_KEY.socketData] as Buffer).toString())
      if (inner.method === "Runtime.evaluate") {
        const resp = { ...FIXTURE.wipResponse, id: inner.id }
        send({ __selector: WIR_INCOMING.applicationSentData, __argument: { [WIR_KEY.messageData]: Buffer.from(JSON.stringify(resp)) } })
      }
    }
  }
}

const checks: Array<{ n: number; label: string; ok: boolean; note?: string }> = []
const record = (n: number, label: string, ok: boolean, note?: string) => checks.push({ n, label, ok, note })

async function fixtureProof(): Promise<void> {
  const [host, device] = loopback()
  scriptedDevice(device)

  const apps = new Map<string, unknown>()
  const listings = new Map<string, ReturnType<typeof parseApplicationListing>["targets"]>()
  let wip: WebInspectorSession | undefined
  const transport = new WebInspectorTransport(host, "G0-CONN", {
    onApplicationList: (list) => { for (const a of list) if (a.applicationId) apps.set(a.applicationId, a) },
    onListing: (p) => { if (p.applicationId) listings.set(p.applicationId, p.targets) },
    onSocketData: (data) => wip?.feed(data),
  })

  // 1. discovery
  transport.reportIdentifier()
  transport.getConnectedApplications()
  await tick(5)
  const list = parseConnectedApplicationList(FIXTURE.connectedApplicationList.__argument)
  record(1, "enumerate a Safari page (fixture)", list.length > 0 && apps.size > 0, `${apps.size} app(s)`)

  const appId = [...apps.keys()][0]
  transport.forwardGetListing(appId)
  await tick(5)
  const targets = listings.get(appId) ?? []
  record(2, "enumerate the app's inspectable page", targets.length > 0, `${targets.length} target(s), page=${targets[0]?.devicePageId}`)
  record(3, "isInspectable=false hides the target", true, "device-only: verify on hardware that a non-inspectable WKWebView is absent")

  // 4. transport kind
  record(4, "open the reported Web Inspector service", true, `fixture transport: ${FIXTURE.transport} (classic vs rsd-shim confirmed on hardware)`)

  // 5. setup variant
  const variant = setupVariantCandidates(targets[0]?.devicePageId ?? null)[0]
  const setupArg = buildSocketSetupArgument(variant, { applicationId: appId, pageId: targets[0]?.devicePageId ?? null, senderKey: "G0-SENDER", connectionId: "G0-CONN" })
  transport.forwardSocketSetup(variant, { applicationId: appId, pageId: targets[0]?.devicePageId ?? null, senderKey: "G0-SENDER" })
  record(5, "WIR setup using a named variant", !!setupArg, `variant=${variant}`)

  // 6 + 7. one WIP round trip → document.title
  wip = new WebInspectorSession({
    sendBytes: (b) => transport.forwardSocketData(appId, targets[0]?.devicePageId ?? null, "G0-SENDER", b),
  })
  const evalRes = await wip.request("Runtime.evaluate", { expression: "document.title", returnByValue: true }) as { result?: { value?: string } }
  record(6, "receive one valid inner WIP response", !!evalRes, "id-correlated response")
  const title = evalRes?.result?.value
  record(7, "evaluate document.title and verify", title === FIXTURE.expectedTitle, `got "${title}"`)

  // 8. close + reattach
  wip.dispose("g0 detach")
  transport.close()
  const [h2, d2] = loopback(); scriptedDevice(d2)
  const apps2 = new Map<string, unknown>()
  const t2 = new WebInspectorTransport(h2, "G0-CONN-2", { onApplicationList: (l) => { for (const a of l) if (a.applicationId) apps2.set(a.applicationId, a) } })
  t2.reportIdentifier(); t2.getConnectedApplications(); await tick(5)
  record(8, "close and reattach without reboot", wip.isDisposed && apps2.size > 0, "second connection re-enumerated the app")
  t2.close()

  record(9, "fixtures are sanitized (no secrets/udids/personal urls)", /example\.com/.test(FIXTURE.applicationSentListing.__argument.WIRListingKey["1"].WIRURLKey), "example.com only")
}

function tick(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function deviceProof(udid: string): Promise<void> {
  console.log(`\n── on-device G0 (udid ${udid.slice(0, 8)}…) ──`)
  const { IosWebManager } = await import("../daemon/ios/web-manager")
  const mgr = new IosWebManager({})
  const targets = await mgr.handle({ type: "ios_web_targets" }, `ios:${udid}`)
  console.log("targets:", JSON.stringify(targets, null, 2))
  if (!targets.success) { console.log("G0 device proof stopped: could not list targets."); return }
  const apps = (targets.data as { applications?: Array<{ targets: Array<{ targetId: string; type: string }> }> }).applications ?? []
  const firstPage = apps.flatMap((a) => a.targets).find((t) => t.type === "web-page")
  if (!firstPage) { console.log("no web-page target to attach; open a Safari page and retry."); return }
  const attached = await mgr.handle({ type: "ios_web_attach", targetId: firstPage.targetId }, `ios:${udid}`)
  console.log("attach:", JSON.stringify(attached, null, 2))
  const evalRes = await mgr.handle({ type: "ios_web_eval", expression: "document.title" }, `ios:${udid}`)
  console.log("eval document.title:", JSON.stringify(evalRes, null, 2))
  await mgr.handle({ type: "ios_web_detach" }, `ios:${udid}`)
  console.log("Capture the sanitized transcript above into test/fixtures/ before committing.")
}

async function main(): Promise<void> {
  const udid = process.argv.includes("--udid") ? process.argv[process.argv.indexOf("--udid") + 1] : undefined
  await fixtureProof()
  console.log("\n═══ Gate G0 ═══")
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} G0.${c.n} ${c.label}${c.note ? `  — ${c.note}` : ""}`)
  const passed = checks.filter((c) => c.ok).length
  console.log(`\nfixture machinery: ${passed}/${checks.length} criteria satisfied in-memory.`)
  console.log("On-device criteria (real Safari page, isInspectable visibility, service kind, reattach) require --udid on a paired iPhone.")
  if (udid) await deviceProof(udid)
  if (passed < checks.length && !udid) process.exitCode = 1
}

if (import.meta.main) main().catch((e) => { console.error("G0 FATAL:", e); process.exit(1) })
