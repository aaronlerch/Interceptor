/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// screenshot-cors refcount.
//
// The CORS DNR rule id is keyed on tabId, so two concurrent screenshots of the
// SAME tab share one rule. Without refcounting, whichever finishes first tears
// the rule down while the other is still fetching subresources → that render
// loses ACAO:* and taints/fails. These tests verify install/uninstall
// refcount so the rule is added once per tab and removed only when the last
// concurrent operation on that tab releases it.

type SessionRuleCall = { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }

let calls: SessionRuleCall[]
let originalChrome: unknown

const RULE_ID_BASE = 920_000

beforeEach(() => {
  calls = []
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome: unknown }).chrome = {
    declarativeNetRequest: {
      updateSessionRules: async (opts: SessionRuleCall) => { calls.push(opts) },
    },
  }
})

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
})

async function load() {
  // Fresh import so the module-level refcount Map starts clean per test.
  return await import("../extension/src/background/capabilities/screenshot-cors")
}

const addsFor = (tabId: number) =>
  calls.filter((c) => c.addRules?.some((r) => r.id === RULE_ID_BASE + tabId)).length
const removesFor = (tabId: number) =>
  calls.filter((c) => (c.removeRuleIds ?? []).includes(RULE_ID_BASE + tabId) && !c.addRules).length

describe("screenshot CORS rule refcount", () => {
  test("single install/uninstall installs once and removes once", async () => {
    const { installScreenshotCorsRule, uninstallScreenshotCorsRule } = await load()
    await installScreenshotCorsRule(7)
    await uninstallScreenshotCorsRule(7)
    expect(addsFor(7)).toBe(1)
    expect(removesFor(7)).toBe(1)
  })

  test("concurrent same-tab operations keep the rule until the LAST release", async () => {
    const { installScreenshotCorsRule, uninstallScreenshotCorsRule } = await load()
    // Two overlapping operations on tab 7.
    await installScreenshotCorsRule(7) // A acquires — installs
    await installScreenshotCorsRule(7) // B acquires — no second install
    expect(addsFor(7)).toBe(1)

    await uninstallScreenshotCorsRule(7) // A releases — MUST NOT remove (B still needs it)
    expect(removesFor(7)).toBe(0)

    await uninstallScreenshotCorsRule(7) // B releases — last one out, removes
    expect(removesFor(7)).toBe(1)
  })

  test("different tabs are independent", async () => {
    const { installScreenshotCorsRule, uninstallScreenshotCorsRule } = await load()
    await installScreenshotCorsRule(1)
    await installScreenshotCorsRule(2)
    await uninstallScreenshotCorsRule(1) // releasing tab 1 must not affect tab 2
    expect(addsFor(1)).toBe(1)
    expect(addsFor(2)).toBe(1)
    expect(removesFor(1)).toBe(1)
    expect(removesFor(2)).toBe(0)
    await uninstallScreenshotCorsRule(2)
    expect(removesFor(2)).toBe(1)
  })

  test("re-acquire after full release installs again", async () => {
    const { installScreenshotCorsRule, uninstallScreenshotCorsRule } = await load()
    await installScreenshotCorsRule(3)
    await uninstallScreenshotCorsRule(3)
    await installScreenshotCorsRule(3) // count fell to 0, so this re-installs
    expect(addsFor(3)).toBe(2)
    await uninstallScreenshotCorsRule(3)
    expect(removesFor(3)).toBe(2)
  })

  test("a failed install rolls back the refcount (no phantom reference)", async () => {
    const { installScreenshotCorsRule } = await load()
    // Make the DNR call throw for the first (installing) acquire.
    const chromeUnderTest = (globalThis as { chrome: { declarativeNetRequest: { updateSessionRules: (o: SessionRuleCall) => Promise<void> } } }).chrome
    const original = chromeUnderTest.declarativeNetRequest.updateSessionRules
    chromeUnderTest.declarativeNetRequest.updateSessionRules = async () => { throw new Error("DNR quota") }
    await expect(installScreenshotCorsRule(9)).rejects.toThrow("DNR quota")
    // Refcount must be back to 0 — a subsequent successful acquire installs
    // (prev===0 branch), proving no phantom reference was left behind.
    chromeUnderTest.declarativeNetRequest.updateSessionRules = original
    await installScreenshotCorsRule(9)
    expect(addsFor(9)).toBe(1)
  })

  test("a failed install does NOT strand a concurrent same-tab acquire", async () => {
    // Interleaving CodeRabbit flagged: A starts installing (0→1) and suspends
    // on the DNR call; B acquires (1→2) while A is in flight and returns without
    // touching DNR; then A's install FAILS. A's rollback must undo only its own
    // increment (2→1), NOT wipe the whole entry — otherwise B is left believing
    // the rule is live with no refcount, and a later uninstall accounting goes
    // wrong. After the dust settles, B's single release must remove the rule.
    const { installScreenshotCorsRule, uninstallScreenshotCorsRule } = await load()
    const chromeUnderTest = (globalThis as { chrome: { declarativeNetRequest: { updateSessionRules: (o: SessionRuleCall) => Promise<void> } } }).chrome
    const original = chromeUnderTest.declarativeNetRequest.updateSessionRules

    // First DNR call (A's install) hangs until we release it, then rejects.
    let releaseA: () => void
    const aInstallGate = new Promise<void>((r) => { releaseA = r })
    chromeUnderTest.declarativeNetRequest.updateSessionRules = async () => {
      await aInstallGate
      throw new Error("DNR quota")
    }

    const aDone = installScreenshotCorsRule(5).then(() => "ok", (e) => (e as Error).message)
    // B acquires while A is still suspended in updateSessionRules.
    await installScreenshotCorsRule(5) // 1→2, no DNR touch (prev !== 0)
    // Let A's install fail now.
    releaseA!()
    expect(await aDone).toBe("DNR quota")

    // B's reference must survive: a fresh install must NOT re-install DNR
    // (count is still 1, so prev !== 0), and B's single uninstall must remove.
    chromeUnderTest.declarativeNetRequest.updateSessionRules = original
    await installScreenshotCorsRule(5) // if B were stranded (count 0), this would re-add
    expect(addsFor(5)).toBe(0) // original was replaced with a no-op stub during A; real adds only counted post-restore
    // Now release both remaining references (B + the last acquire) → one remove.
    await uninstallScreenshotCorsRule(5)
    expect(removesFor(5)).toBe(0) // still one ref alive
    await uninstallScreenshotCorsRule(5)
    expect(removesFor(5)).toBe(1) // last one out removes exactly once
  })
})
