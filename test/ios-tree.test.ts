import { describe, expect, test } from "bun:test"
import {
  IosRefRegistry, formatWdaTree, findInTree, frameCenter, displayRole, type WdaSourceNode,
} from "../daemon/ios/tree"
import { resizePngToBudget } from "../daemon/ios/tools"

// A small WDA /source?format=json snapshot fixture (XCUIElement serialization).
const SNAPSHOT: WdaSourceNode = {
  type: "XCUIElementTypeApplication",
  label: "Settings",
  rect: { x: 0, y: 0, width: 390, height: 844 },
  children: [
    {
      type: "XCUIElementTypeNavigationBar",
      label: "Settings",
      rect: { x: 0, y: 44, width: 390, height: 96 },
      children: [
        {
          type: "XCUIElementTypeButton",
          label: "Edit",
          name: "edit-btn",
          isEnabled: true,
          rect: { x: 320, y: 60, width: 60, height: 44 },
          children: [],
        },
      ],
    },
    {
      type: "XCUIElementTypeTable",
      rect: { x: 0, y: 140, width: 390, height: 700 },
      children: [
        {
          type: "XCUIElementTypeCell",
          label: "General",
          isEnabled: true,
          rect: { x: 0, y: 140, width: 390, height: 60 },
          children: [
            {
              type: "XCUIElementTypeStaticText",
              label: "General",
              value: "",
              rect: { x: 16, y: 158, width: 100, height: 24 },
            },
          ],
        },
        {
          type: "XCUIElementTypeTextField",
          label: "Search",
          value: "",
          isEnabled: false,
          rect: { x: 16, y: 210, width: 358, height: 36 },
        },
      ],
    },
  ],
}

describe("formatWdaTree", () => {
  test("mints sequential refs and resolves them back to frames", () => {
    const reg = new IosRefRegistry()
    const text = formatWdaTree(SNAPSHOT, reg, { filter: "full" })
    expect(text).toContain("[e1]")
    const all = reg.all()
    expect(all.length).toBeGreaterThan(3)
    // e1 is the root application
    const e1 = reg.resolve("e1")
    expect(e1?.type).toBe("Application")
    expect(e1?.frame).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  })

  test("output lines mirror the macOS AX format: [ref] role \"label\"", () => {
    const reg = new IosRefRegistry()
    const text = formatWdaTree(SNAPSHOT, reg, { filter: "full" })
    expect(text).toMatch(/\[e\d+\] button "Edit"/)
    expect(text).toMatch(/\[e\d+\] cell "General"/)
    // disabled element is annotated
    expect(text).toMatch(/textfield "Search".*\(disabled\)/)
  })

  test("interactive filter keeps only interactive elements", () => {
    const reg = new IosRefRegistry()
    const text = formatWdaTree(SNAPSHOT, reg, { filter: "interactive" })
    expect(text).toContain("button")
    expect(text).toContain("cell")
    expect(text).toContain("textfield")
    expect(text).not.toContain("navigationbar")
  })

  test("clear() resets the counter so a re-read starts at e1", () => {
    const reg = new IosRefRegistry()
    formatWdaTree(SNAPSHOT, reg, { filter: "full" })
    reg.clear()
    const text = formatWdaTree(SNAPSHOT, reg, { filter: "full" })
    expect(text).toContain("[e1]")
    expect(reg.resolve("e1")?.type).toBe("Application")
  })
})

describe("displayRole / frameCenter", () => {
  test("strips XCUIElementType and lowercases", () => {
    expect(displayRole("XCUIElementTypeButton")).toBe("button")
    expect(displayRole(undefined)).toBe("other")
  })
  test("frameCenter computes the rect center", () => {
    const reg = new IosRefRegistry()
    const el = reg.register({ type: "Button", label: "Edit", enabled: true, frame: { x: 320, y: 60, width: 60, height: 44 } })
    expect(frameCenter(el)).toEqual({ x: 350, y: 82 })
  })
})

describe("findInTree", () => {
  test("finds by label substring, optionally filtered by role", () => {
    const reg = new IosRefRegistry()
    formatWdaTree(SNAPSHOT, reg, { filter: "full" })
    const all = findInTree(reg, "general")
    expect(all.length).toBeGreaterThanOrEqual(1)
    const buttons = findInTree(reg, "edit", "button")
    expect(buttons.length).toBe(1)
    expect(buttons[0].role).toBe("button")
    expect(buttons[0].name).toBe("Edit")
  })
})

describe("resizePngToBudget (sips passthrough contract)", () => {
  test("maxLongEdge <= 0 returns the PNG unchanged as a data URL", () => {
    const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")
    const r = resizePngToBudget(tiny, 0)
    expect(r.format).toBe("png")
    expect(r.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
  })
})
