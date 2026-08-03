import { describe, expect, test } from "bun:test"

import { CSP_STRIP_REFUSED, runWithCspStripBypass } from "../extension/src/background/capabilities/evaluate"
import { parseEvalCommand } from "../cli/commands/eval"
import { parseSaveCommand } from "../cli/commands/save"

// The CSP-strip bypass removes `content-security-policy` (and, with it,
// `require-trusted-types-for`) from a page's response for the whole tab — a
// logged-in site loses its own XSS defenses. Upstream reaches it automatically
// on any CSP/Trusted-Types eval failure; this fork requires an explicit
// operator opt-in. These tests pin that gate.

const CSP_ERROR = "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: script-src 'self'"
const TT_ERROR = "This document requires 'TrustedScript' assignment: require-trusted-types-for 'script'"

/** A `run` callback that always fails with `error`, counting its invocations. */
function alwaysFails(error: string) {
  const calls: Array<"MAIN" | "ISOLATED"> = []
  const run = async (_tabId: number, world: "MAIN" | "ISOLATED") => {
    calls.push(world)
    return { success: false, error }
  }
  return { run, calls }
}

describe("CSP-strip bypass is gated behind an explicit opt-in", () => {
  test("refuses the header strip by default on an unsafe-eval CSP failure", async () => {
    const { run, calls } = alwaysFails(CSP_ERROR)
    const r = await runWithCspStripBypass(1, "MAIN", run)

    expect(r.success).toBe(false)
    expect(r.error).toBe(CSP_STRIP_REFUSED)
    expect((r.data as { cspBypassApplied: boolean }).cspBypassApplied).toBe(false)
    // discoverable: the caller is told the capability exists behind a flag
    expect((r.data as { cspStripAvailable: boolean }).cspStripAvailable).toBe(true)
    // never reloaded/retried — exactly one in-page attempt
    expect(calls).toEqual(["MAIN"])
  })

  test("refuses by default on a Trusted-Types failure too, after trying ISOLATED", async () => {
    const { run, calls } = alwaysFails(TT_ERROR)
    const r = await runWithCspStripBypass(1, "MAIN", run)

    expect(r.success).toBe(false)
    expect(r.error).toBe(CSP_STRIP_REFUSED)
    // step 2 (ISOLATED retry) still runs — it works inside the page policy and
    // takes nothing away from it. Only the header strip is gated.
    expect(calls).toEqual(["MAIN", "ISOLATED"])
  })

  test("a non-CSP failure is returned verbatim, not converted into the gate error", async () => {
    const { run } = alwaysFails("ReferenceError: foo is not defined")
    const r = await runWithCspStripBypass(1, "MAIN", run)

    expect(r.success).toBe(false)
    expect(r.error).toBe("ReferenceError: foo is not defined")
  })

  test("ISOLATED-world callers never reach the gate", async () => {
    const { run, calls } = alwaysFails(CSP_ERROR)
    const r = await runWithCspStripBypass(1, "ISOLATED", run)

    expect(r.error).toBe(CSP_ERROR)
    expect(calls).toEqual(["ISOLATED"])
  })
})

describe("CLI threads the opt-in flag", () => {
  test("eval omits allowCspStrip unless --allow-csp-strip is passed", () => {
    expect(parseEvalCommand(["eval", "1+1", "--main"]).allowCspStrip).toBeUndefined()
  })

  test("eval sets allowCspStrip and keeps the flag out of the evaluated code", () => {
    const a = parseEvalCommand(["eval", "1+1", "--main", "--allow-csp-strip"])
    expect(a.allowCspStrip).toBe(true)
    expect(a.code).toBe("1+1")
  })

  test("save omits allowCspStrip unless asked, and never folds it into the expression", () => {
    const off = parseSaveCommand(["save", "--out", "/tmp/x.bin", "blob"])
    expect(off.allowCspStrip).toBeUndefined()
    expect(off.code).toBe("blob")

    const on = parseSaveCommand(["save", "--out", "/tmp/x.bin", "blob", "--allow-csp-strip"])
    expect(on.allowCspStrip).toBe(true)
    expect(on.code).toBe("blob")
  })
})
