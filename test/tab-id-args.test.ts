import { describe, expect, mock, spyOn, test } from "bun:test"
import { parseTabsCommand } from "../cli/commands/tabs"

// Pins the tab close/switch id-argument contract: the id is the first
// non-flag argument (so `tab close --json` stays a valid no-arg close),
// and a present-but-non-numeric id is a hard CLI error, never a
// partial-parse or a silent fall-through to the active tab.
describe("tab close/switch id parsing", () => {
  test("close with no id is a bare tab_close", async () => {
    expect(await parseTabsCommand(["tab", "close"])).toEqual({ type: "tab_close" })
  })

  test("close with only flags is a bare tab_close (--json form)", async () => {
    expect(await parseTabsCommand(["tab", "close", "--json"])).toEqual({ type: "tab_close" })
  })

  test("close finds the id around flags", async () => {
    expect(await parseTabsCommand(["tab", "close", "123", "--json"])).toEqual({ type: "tab_close", tabId: 123 })
    expect(await parseTabsCommand(["tab", "close", "--json", "123"])).toEqual({ type: "tab_close", tabId: 123 })
  })

  test("switch takes the first non-flag id", async () => {
    expect(await parseTabsCommand(["tab", "switch", "456", "--json"])).toEqual({ type: "tab_switch", tabId: 456 })
  })

  test("non-numeric ids are a hard error, not a partial parse", async () => {
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const err = spyOn(console, "error").mockImplementation(mock(() => {}))
    try {
      await expect(parseTabsCommand(["tab", "close", "12abc"])).rejects.toThrow("exit 1")
      await expect(parseTabsCommand(["tab", "close", "abc", "--json"])).rejects.toThrow("exit 1")
      await expect(parseTabsCommand(["tab", "switch", "--json"])).rejects.toThrow("exit 1")
    } finally {
      exit.mockRestore()
      err.mockRestore()
    }
  })
})
