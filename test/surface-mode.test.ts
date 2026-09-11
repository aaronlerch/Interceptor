import { describe, expect, test } from "bun:test"
import { macosEnabled, isTruthyEnv, readSurfaceMarker, surfaceMarkerPath } from "../shared/surface-mode"

// FORK-DELTA: browser-only vs full is a soft, persisted, enforced choice.
describe("macosEnabled precedence", () => {
  test("force-off wins over everything (including force-on)", () => {
    expect(macosEnabled({ forceOff: true, forceOn: true, marker: "full", detected: true })).toBe(false)
    expect(macosEnabled({ forceOff: true, forceOn: false, marker: "full", detected: true })).toBe(false)
  })
  test("force-on wins when force-off is absent", () => {
    expect(macosEnabled({ forceOff: false, forceOn: true, marker: "browser-only", detected: false })).toBe(true)
  })
  test("a browser-only marker disables even with a bridge present", () => {
    expect(macosEnabled({ forceOff: false, forceOn: false, marker: "browser-only", detected: true })).toBe(false)
  })
  test("a full marker falls through to detection (cannot conjure a bridge)", () => {
    expect(macosEnabled({ forceOff: false, forceOn: false, marker: "full", detected: true })).toBe(true)
    expect(macosEnabled({ forceOff: false, forceOn: false, marker: "full", detected: false })).toBe(false)
  })
  test("no marker → detection decides", () => {
    expect(macosEnabled({ forceOff: false, forceOn: false, marker: null, detected: true })).toBe(true)
    expect(macosEnabled({ forceOff: false, forceOn: false, marker: null, detected: false })).toBe(false)
  })
})

describe("isTruthyEnv", () => {
  test("only 1/true/yes/on are truthy", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(isTruthyEnv(v)).toBe(true)
    for (const v of ["0", "false", "", "off", "no", undefined]) expect(isTruthyEnv(v as any)).toBe(false)
  })
})

describe("marker IO", () => {
  test("marker path honors HOME; a missing marker reads null", () => {
    const env = { HOME: "/nonexistent-home-xyz" }
    expect(surfaceMarkerPath(env)).toBe("/nonexistent-home-xyz/.interceptor/mode")
    expect(readSurfaceMarker(env)).toBeNull()
  })
})
