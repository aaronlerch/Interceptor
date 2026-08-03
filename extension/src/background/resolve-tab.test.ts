import { describe, expect, test } from "bun:test"
import { resolveWorkingTabId } from "./resolve-tab"

// Pins the dispatcher's working-tab resolution contract:
// explicit well-formed action.tabId > --tab override (msg.tabId) > undefined
// (undefined falls through to the dispatcher's auto-target/active resolution).
describe("resolveWorkingTabId", () => {
  test("explicit action.tabId wins when no --tab override", () => {
    expect(resolveWorkingTabId(undefined, 42)).toBe(42)
  })

  test("--tab override used when action carries no target", () => {
    expect(resolveWorkingTabId(7, undefined)).toBe(7)
  })

  test("explicit action.tabId beats --tab when both are set", () => {
    // The tab handlers act on action.tabId when present; validation must
    // target the same tab the handler acts on.
    expect(resolveWorkingTabId(7, 42)).toBe(42)
  })

  test("neither set resolves undefined (auto-target path)", () => {
    expect(resolveWorkingTabId(undefined, undefined)).toBeUndefined()
  })

  test("NaN action.tabId (parseInt of missing arg) never counts as explicit", () => {
    expect(resolveWorkingTabId(7, NaN)).toBe(7)
    expect(resolveWorkingTabId(undefined, NaN)).toBeUndefined()
  })

  test("0 is a well-formed explicit id (number, not NaN)", () => {
    expect(resolveWorkingTabId(7, 0)).toBe(0)
  })

  test("non-number action.tabId shapes are ignored", () => {
    expect(resolveWorkingTabId(7, "42")).toBe(7)
    expect(resolveWorkingTabId(undefined, null)).toBeUndefined()
  })
})
