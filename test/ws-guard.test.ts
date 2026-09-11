import { describe, expect, test } from "bun:test"
import { wsUpgradeAllowed } from "../daemon/ws-guard"

// FORK-DELTA: the daemon WebSocket routes `delegate` frames to the bridge as
// arbitrary macos_* actions. This gate is what stops a web page or a LAN host
// from reaching that path. See daemon/ws-guard.ts.
describe("wsUpgradeAllowed", () => {
  const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"]

  test("allows loopback with no Origin (CLI, injected native agent)", () => {
    for (const a of LOOPBACK) expect(wsUpgradeAllowed(a, "")).toBe(true)
  })

  test("allows loopback with a browser-extension Origin", () => {
    expect(wsUpgradeAllowed("::1", "chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng")).toBe(true)
    expect(wsUpgradeAllowed("127.0.0.1", "moz-extension://abc")).toBe(true)
    expect(wsUpgradeAllowed("::ffff:127.0.0.1", "safari-web-extension://xyz")).toBe(true)
  })

  test("REFUSES a web page Origin even from loopback (the web-page RCE vector)", () => {
    for (const a of LOOPBACK) {
      expect(wsUpgradeAllowed(a, "https://evil.example")).toBe(false)
      expect(wsUpgradeAllowed(a, "http://localhost:3000")).toBe(false)
      expect(wsUpgradeAllowed(a, "https://accounts.google.com")).toBe(false)
    }
  })

  test("REFUSES any non-loopback peer regardless of Origin (the LAN vector)", () => {
    for (const o of ["", "chrome-extension://abc", "https://evil.example"]) {
      expect(wsUpgradeAllowed("::ffff:192.168.1.50", o)).toBe(false)
      expect(wsUpgradeAllowed("192.168.1.50", o)).toBe(false)
      expect(wsUpgradeAllowed("10.0.0.5", o)).toBe(false)
      expect(wsUpgradeAllowed("::ffff:10.0.0.5", o)).toBe(false)
    }
  })

  test("fails closed on an empty or unknown peer address", () => {
    expect(wsUpgradeAllowed("", "")).toBe(false)
    expect(wsUpgradeAllowed("", "chrome-extension://abc")).toBe(false)
  })

  test("does not confuse a hostile origin substring for an allowed prefix", () => {
    // must be a real prefix, not merely contain the token
    expect(wsUpgradeAllowed("::1", "https://chrome-extension.evil.example")).toBe(false)
    expect(wsUpgradeAllowed("::1", "https://evil.example/chrome-extension://x")).toBe(false)
  })
})
