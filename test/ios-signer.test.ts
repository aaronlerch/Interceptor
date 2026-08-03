import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEntitlementsPlist, findInnerXctest, RUNNER_BUNDLE_ID } from "../daemon/ios/signer"

// The re-sign machinery. The live Apple-auth half is gated; these
// lock the offline-verifiable parts: get-task-allow must be present (testmanagerd
// won't attach without it), and the inner-.xctest discovery must find PlugIns.

describe("signer entitlements", () => {
  test("entitlements carry get-task-allow=true and the app id + team", () => {
    const xml = buildEntitlementsPlist({ applicationIdentifier: "ABCDE12345.com.x", teamId: "ABCDE12345" })
    expect(xml).toContain("<key>get-task-allow</key><true/>")
    expect(xml).toContain("<key>application-identifier</key><string>ABCDE12345.com.x</string>")
    expect(xml).toContain("<key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>")
    expect(xml.startsWith("<?xml")).toBe(true)
  })

  test("preserves the runner bundle id constant the profile must match", () => {
    expect(RUNNER_BUNDLE_ID).toBe("com.interceptor.InterceptorRunner.xctrunner")
  })

  test("findInnerXctest locates the PlugIns/*.xctest bundle", () => {
    const app = join(mkdtempSync(join(tmpdir(), "signer-")), "InterceptorRunner-Runner.app")
    mkdirSync(join(app, "PlugIns", "InterceptorRunner.xctest"), { recursive: true })
    writeFileSync(join(app, "PlugIns", "InterceptorRunner.xctest", "Info.plist"), "x")
    expect(findInnerXctest(app)).toBe(join(app, "PlugIns", "InterceptorRunner.xctest"))
  })

  test("findInnerXctest returns undefined when there is no PlugIns dir", () => {
    const app = join(mkdtempSync(join(tmpdir(), "signer-")), "Bare.app")
    mkdirSync(app, { recursive: true })
    expect(findInnerXctest(app)).toBeUndefined()
  })
})
