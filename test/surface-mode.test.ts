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

import { macosDomainAllowed, macosDomainOf, ALWAYS_ALLOWED_DOMAINS } from "../shared/surface-mode"

describe("per-domain allowlist", () => {
  test("null allowlist (no file) allows everything", () => {
    expect(macosDomainAllowed("intent", null)).toBe(true)
    expect(macosDomainAllowed("screenshot", null)).toBe(true)
  })
  test("a present allowlist denies unlisted domains", () => {
    const allow = new Set(["screenshot", "tree"])
    expect(macosDomainAllowed("screenshot", allow)).toBe(true)
    expect(macosDomainAllowed("tree", allow)).toBe(true)
    expect(macosDomainAllowed("intent", allow)).toBe(false)
    expect(macosDomainAllowed("fs", allow)).toBe(false)
  })
  test("an empty allowlist denies all (except always-allowed)", () => {
    expect(macosDomainAllowed("screenshot", new Set())).toBe(false)
    expect(macosDomainAllowed("trust", new Set())).toBe(true)
  })
  test("'trust' is always allowed, even when not listed", () => {
    expect(ALWAYS_ALLOWED_DOMAINS.has("trust")).toBe(true)
    expect(macosDomainAllowed("trust", new Set(["screenshot"]))).toBe(true)
  })
  test("macosDomainOf extracts the domain from an action type", () => {
    expect(macosDomainOf("macos_tree")).toBe("tree")
    expect(macosDomainOf("macos_app_activate")).toBe("app")
    expect(macosDomainOf("macos_intent_dispatch")).toBe("intent")
    expect(macosDomainOf("input_text")).toBeNull()
    expect(macosDomainOf("macos")).toBeNull()
  })
})
