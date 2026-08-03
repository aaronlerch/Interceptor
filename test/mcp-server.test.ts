import { describe, expect, test } from "bun:test"

import { COMMAND_SPECS } from "../cli/manifest"
import { buildServer } from "../cli/mcp/server"

describe("buildServer", () => {
  test("constructs without throwing and registers tools", () => {
    const server = buildServer()
    expect(server).toBeTruthy()
    // McpServer keeps registered tools on an internal map; assert the five routers exist.
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
    if (tools) {
      for (const name of ["interceptor_browser", "interceptor_macos", "interceptor_read", "interceptor_local", "interceptor_raw"]) {
        expect(Object.keys(tools)).toContain(name)
      }
      // the iOS surface is removed from this fork — it must not come back silently.
      expect(Object.keys(tools)).not.toContain("interceptor_ios")
    }
  })

  test("browser verb menu is non-empty (enum source of truth)", () => {
    expect(COMMAND_SPECS.filter(c => c.surface === "browser").length).toBeGreaterThan(20)
  })
})
