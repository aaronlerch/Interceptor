import { describe, expect, test } from "bun:test"
import { NO_TAB_ACTIONS, needsTab } from "../extension/src/background/no-tab-actions"

describe("window action tab routing", () => {
  test("all window management actions bypass active-tab discovery", () => {
    for (const action of [
      "window_create",
      "window_close",
      "window_focus",
      "window_resize",
      "window_list",
      "window_get_all",
    ]) {
      expect(NO_TAB_ACTIONS.has(action)).toBe(true)
      expect(needsTab(action)).toBe(false)
    }
  })

  test("page actions still require a tab", () => {
    expect(needsTab("click")).toBe(true)
    expect(needsTab("evaluate")).toBe(true)
  })
})
