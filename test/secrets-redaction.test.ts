/**
 * test/secrets-redaction.test.ts — issue #244: the daemon's log line never
 * carries a credential. Covers the vault verbs, every --secret delivery,
 * the resolved `sensitive` deliveries, and the Apple ID login.
 */

import { describe, expect, test } from "bun:test"
import { actionLogSummary, inboundLogSummary, isSecretBearing, redactAction } from "../daemon/redact"

const VALUE = "hunter2-CORRECT-horse"

describe("actionLogSummary", () => {
  test("plain actions are unchanged (first 100 chars)", () => {
    expect(actionLogSummary({ type: "macos_type", text: "hello" })).toBe(JSON.stringify({ type: "macos_type", text: "hello" }))
    expect(actionLogSummary({ type: "click", ref: "e1" })).toContain('"ref":"e1"')
  })

  test("vault writes never show the value", () => {
    const line = actionLogSummary({ type: "macos_secret", sub: "set", name: "admin", value: VALUE, targets: ["sudo"] })
    expect(line).not.toContain(VALUE)
    expect(line).toContain('"name":"admin"')
    expect(line).toContain("<redacted>")
  })

  test("every --secret delivery logs the name only", () => {
    for (const a of [
      { type: "input_text", ref: "e3", secret: "site-pw" },
      // The fork's four delivery legs (FORK-DELTA §5/§6 removed sudo and
      // authdialog; §1 removed the iOS ones). Each carries an op:// reference.
      { type: "find_and_type", name: "Password", secret: "op://Private/Site/password" },
      { type: "os_type", secret: "op://Private/Site/password" },
      { type: "macos_type", secret: "op://Private/Admin/password" },
      { type: "input_text", ref: "e1", secret: "op://Private/Site/password" },
    ]) {
      const line = actionLogSummary(a)
      expect(line).toContain(`"secret":"${a.secret}"`)
      expect(line).not.toContain(VALUE)
    }
  })

  test("resolved deliveries (sensitive) hide text, inputText, and passcode", () => {
    expect(actionLogSummary({ type: "macos_type", text: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "find_and_type", inputText: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "ios_unlock", passcode: VALUE, sensitive: true })).not.toContain(VALUE)
    expect(actionLogSummary({ type: "os_type", text: VALUE, sensitive: true })).toContain("<redacted>")
  })

  // FORK-DELTA §7: a --secret value is now an op:// REFERENCE, which is a
  // location rather than a credential. It stays readable on purpose — that line
  // is what makes a release auditable. The value it resolves to still must not
  // appear anywhere.
  test("an op:// reference stays readable while the resolved value never appears", () => {
    const REF = "op://Private/Gmail/password"
    const line = actionLogSummary({ type: "input_text", ref: "e3", secret: REF })
    expect(line).toContain(REF)
    expect(line).not.toContain(VALUE)
    const delivered = actionLogSummary({ type: "input_text", ref: "e3", text: VALUE, sensitive: true })
    expect(delivered).not.toContain(VALUE)
    expect(delivered).toContain("<redacted>")
  })

  test("daemon_shutdown still redacts its token", () => {
    const line = actionLogSummary({ type: "daemon_shutdown", protocolVersion: 1, reason: "x", token: "shutdown-TOKEN-value" })
    expect(line).not.toContain("shutdown-TOKEN-value")
    expect(line).toContain('"token":"<redacted>"')
  })

  test("redaction leaves the original object untouched", () => {
    const a = { type: "macos_secret", sub: "set", name: "n", value: VALUE }
    redactAction(a)
    expect(a.value).toBe(VALUE)
    expect(isSecretBearing({ type: "click" })).toBe(false)
  })

  test("inbound frames carrying a sensitive action are summarized by shape", () => {
    const line = inboundLogSummary({ id: "1", action: { type: "os_type", text: VALUE, sensitive: true } })
    expect(line).not.toContain(VALUE)
    expect(inboundLogSummary({ id: "2", result: { success: true } })).toContain('"success":true')
  })
})

describe("outbound frames (daemon → extension) never carry the value", () => {
  test("input_text / find_and_type / os_type envelopes are redacted", async () => {
    const { outboundLogSummary } = await import("../daemon/redact")
    for (const action of [
      { type: "input_text", ref: "e1", text: VALUE, sensitive: true, clear: true },
      { type: "find_and_type", name: "Password", role: "textbox", inputText: VALUE, sensitive: true },
      { type: "os_type", ref: "e1", text: VALUE, sensitive: true },
    ]) {
      const line = outboundLogSummary({ id: "abc", action, tabId: 7 })
      expect(line).not.toContain(VALUE)
      expect(line).toContain('"id":"abc"')
      expect(line).toContain(`"type":"${action.type}"`)
    }
    expect(outboundLogSummary({ id: "x", action: { type: "click", ref: "e2" } })).toContain('"ref":"e2"')
  })
})

describe("content monitor masks secret-typed fields of every kind", () => {
  test("handleInput and handleChange check isSensitive before reading any value", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("../extension/src/content/monitor.ts", import.meta.url), "utf-8")
    for (const fn of ["function handleInput(", "function handleChange("]) {
      const start = src.indexOf(fn)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf("\n}\n", start))
      const sensitiveAt = body.indexOf("isSensitive(target)")
      const truncateAt = body.indexOf("truncate(")
      expect(sensitiveAt).toBeGreaterThan(-1)
      expect(truncateAt).toBeGreaterThan(sensitiveAt)
      expect(body.slice(sensitiveAt, truncateAt)).toContain("SECURE_MASK")
    }
  })
})
