import { describe, expect, test } from "bun:test"
import { buildWindowResizeAction, parseTabsCommand } from "../cli/commands/tabs"

describe("window resize parser", () => {
  test("keeps positional width and height compatibility", async () => {
    const action = await parseTabsCommand(["window", "resize", "42", "1200", "800"])
    expect(action).toEqual({
      type: "window_resize",
      windowId: 42,
      width: 1200,
      height: 800,
    })
  })

  test("parses absolute positioning flags for an explicit window", async () => {
    const action = await parseTabsCommand([
      "window",
      "resize",
      "42",
      "--left",
      "-1920",
      "--top",
      "0",
      "--width",
      "960",
      "--height",
      "1080",
    ])
    expect(action).toEqual({
      type: "window_resize",
      windowId: 42,
      left: -1920,
      top: 0,
      width: 960,
      height: 1080,
    })
  })

  test("allows current-window resize when only flags are supplied", async () => {
    const action = await parseTabsCommand(["window", "resize", "--width", "1280", "--height", "720"])
    expect(action).toEqual({
      type: "window_resize",
      width: 1280,
      height: 720,
    })
  })

  test("allows normal state with geometry", () => {
    expect(buildWindowResizeAction(["42", "--state", "normal", "--width", "1280"])).toEqual({
      type: "window_resize",
      windowId: 42,
      state: "normal",
      width: 1280,
    })
  })

  test("rejects non-integer window ids", () => {
    expect(() => buildWindowResizeAction(["abc", "1200", "800"])).toThrow("window id must be an integer")
  })

  test("rejects non-integer dimensions instead of forwarding NaN", () => {
    expect(() => buildWindowResizeAction(["42", "--width", "wide"])).toThrow("--width must be an integer")
  })

  test("rejects unsupported state values", () => {
    expect(() => buildWindowResizeAction(["42", "--state", "floating"])).toThrow("invalid window state: floating")
  })

  test("rejects geometry combined with maximized-like states", () => {
    expect(() => buildWindowResizeAction(["42", "--state", "maximized", "--width", "1280"])).toThrow(
      "maximized cannot be combined with left, top, width, or height"
    )
  })

  test("rejects no-op resize requests", () => {
    expect(() => buildWindowResizeAction(["42"])).toThrow(
      "window resize requires --state or at least one geometry field"
    )
  })
})
