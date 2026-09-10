import { describe, expect, test } from "bun:test"

import {
  buildCspBypassRule,
  isCspEvalError,
  purgeCspBypassRules,
  removeCspBypassForTab
} from "../extension/src/background/capabilities/evaluate"

describe("evaluate CSP fallback helpers", () => {
  test("detects page CSP eval failures", () => {
    expect(isCspEvalError(
      `Evaluating a string as JavaScript violates the following Content Security Policy directive because neither 'unsafe-eval' nor the string's hash are an allowed source of script: script-src 'self'`
    )).toBe(true)
    expect(isCspEvalError("ReferenceError: foo is not defined")).toBe(false)
  })

  test("builds a tab-scoped session rule that strips CSP response headers", () => {
    const rule = buildCspBypassRule(321)
    expect(rule.id).toBe(910321)
    expect(rule.action.type).toBe("modifyHeaders")
    expect(rule.action.responseHeaders).toEqual([
      { header: "content-security-policy", operation: "remove" },
      { header: "content-security-policy-report-only", operation: "remove" }
    ])
    expect(rule.condition.tabIds).toEqual([321])
    expect(rule.condition.resourceTypes).toEqual(["main_frame", "sub_frame"])
  })

  test("scopes the rule to the host when one is known", () => {
    // Without this the strip follows the TAB: consent given for one site is
    // silently spent on wherever that tab navigates next.
    const rule = buildCspBypassRule(321, "example.com")
    expect(rule.condition.requestDomains).toEqual(["example.com"])
    expect(rule.condition.tabIds).toEqual([321])
  })

  test("omits requestDomains when the host is unknown, rather than failing", () => {
    expect(buildCspBypassRule(321).condition.requestDomains).toBeUndefined()
  })
})

/** Minimal declarativeNetRequest double: records what was asked of it. */
function fakeDnr(sessionRules: Array<{ id: number }>) {
  const calls: Array<{ removeRuleIds?: number[] }> = []
  return {
    calls,
    api: {
      getSessionRules: async () => sessionRules,
      updateSessionRules: async (arg: { removeRuleIds?: number[] }) => {
        calls.push(arg)
      }
    }
  }
}

describe("the CSP-strip rule is cleaned up", () => {
  const realChrome = (globalThis as { chrome?: unknown }).chrome
  const withDnr = (dnr: unknown) => {
    ;(globalThis as { chrome?: unknown }).chrome = { declarativeNetRequest: dnr }
  }
  const restore = () => {
    ;(globalThis as { chrome?: unknown }).chrome = realChrome
  }

  test("removes the rule for a closed tab, by its derived id", async () => {
    // Chrome reuses tab ids. A stripped tab that closes without this leaves its
    // id armed for whatever tab is given that id next.
    const { api, calls } = fakeDnr([])
    withDnr(api)
    await removeCspBypassForTab(321)
    restore()
    expect(calls).toEqual([{ removeRuleIds: [910321] }])
  })

  test("purges only rules in this feature's id range", async () => {
    const { api, calls } = fakeDnr([
      { id: 5 },
      { id: 910321 },
      { id: 910999 },
      { id: 1_500_000 }
    ])
    withDnr(api)
    await purgeCspBypassRules()
    restore()
    expect(calls).toEqual([{ removeRuleIds: [910321, 910999] }])
  })

  test("purging with nothing of ours installed writes nothing", async () => {
    const { api, calls } = fakeDnr([{ id: 5 }, { id: 1_500_000 }])
    withDnr(api)
    await purgeCspBypassRules()
    restore()
    expect(calls).toEqual([])
  })
})
