import { describe, expect, test } from "bun:test"
import {
  handleWindowActions,
  WindowOperationTimeoutError,
  withWindowTimeout,
} from "../extension/src/background/capabilities/windows"

describe("window action timeout handling", () => {
  test("rejects hung window operations with a structured timeout error", async () => {
    try {
      await withWindowTimeout("window_focus", new Promise(() => {}), 5)
      throw new Error("expected timeout")
    } catch (err) {
      expect(err).toBeInstanceOf(WindowOperationTimeoutError)
      expect((err as WindowOperationTimeoutError).operation).toBe("window_focus")
      expect((err as WindowOperationTimeoutError).timeoutMs).toBe(5)
      expect((err as Error).message).toContain("window_focus timed out after 5ms")
    }
  })

  test("clears timeout handles after a successful operation", async () => {
    const originalClearTimeout = globalThis.clearTimeout
    const cleared: unknown[] = []
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: ((timer: Parameters<typeof clearTimeout>[0]) => {
        cleared.push(timer)
        return originalClearTimeout(timer)
      }) as typeof clearTimeout,
    })

    try {
      const value = await withWindowTimeout("window_list", Promise.resolve("ok"), 1000)
      expect(value).toBe("ok")
      expect(cleared.length).toBe(1)
    } finally {
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        writable: true,
        value: originalClearTimeout,
      })
    }
  })

  test("handler converts rejected chrome window calls into ActionResult errors", async () => {
    const globals = globalThis as any
    const originalChrome = globals.chrome
    globals.chrome = {
      windows: {
        update: async () => {
          throw new Error("window update failed")
        },
      },
    } as unknown

    try {
      const result = await handleWindowActions({ type: "window_focus", windowId: 7 }, 0)
      expect(result).toEqual({ success: false, error: "window update failed" })
    } finally {
      globals.chrome = originalChrome
    }
  })
})
