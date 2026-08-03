import { describe, expect, test } from "bun:test"
import { IOS_ACTION_TYPES, IOS_VERB_TYPES } from "../shared/ios-device"
import {
  IOS_WEB_ACTION_TYPES, IOS_WEB_SESSION_ACTION_TYPES, IOS_WEB_NATIVE_LANE_ACTION_TYPES,
  isWebRef, isNativeRef, setupVariantCandidates, webError, redactHeaders, redactUrl,
} from "../shared/ios-web"

// Locks the routing contract: the web action set is DISJOINT from the native
// lifecycle/verb sets, so a web action can only reach the runner via the broad
// `ios:` context fallback — which daemon/index.ts tests these types BEFORE.
// Also: wN and eN refs can never cross-resolve.

describe("ios web action set", () => {
  test("has exactly the 19 normative action types", () => {
    expect(IOS_WEB_ACTION_TYPES.size).toBe(19)
    for (const t of [
      "ios_web_targets", "ios_web_attach", "ios_web_detach", "ios_web_status", "ios_web_explain",
      "ios_web_read", "ios_web_text", "ios_web_find", "ios_web_inspect", "ios_web_eval", "ios_web_call",
      "ios_web_click", "ios_web_type", "ios_web_keys", "ios_web_scroll", "ios_web_calibrate",
      "ios_web_console", "ios_web_network", "ios_web_screenshot",
    ]) expect(IOS_WEB_ACTION_TYPES.has(t)).toBe(true)
  })

  test("is disjoint from native lifecycle and verb sets", () => {
    for (const t of IOS_WEB_ACTION_TYPES) {
      expect(IOS_ACTION_TYPES.has(t)).toBe(false)   // not a native lifecycle action
      expect(IOS_VERB_TYPES.has(t)).toBe(false)     // not a native verb → cannot hit executeVerb by type
    }
  })

  test("session + native-lane subsets are contained in the full set", () => {
    for (const t of IOS_WEB_SESSION_ACTION_TYPES) expect(IOS_WEB_ACTION_TYPES.has(t)).toBe(true)
    for (const t of IOS_WEB_NATIVE_LANE_ACTION_TYPES) expect(IOS_WEB_ACTION_TYPES.has(t)).toBe(true)
    // targets/status/explain are lifecycle (NOT session-scoped) so they bypass the
    // runner entirely.
    expect(IOS_WEB_SESSION_ACTION_TYPES.has("ios_web_targets")).toBe(false)
    expect(IOS_WEB_SESSION_ACTION_TYPES.has("ios_web_status")).toBe(false)
    expect(IOS_WEB_SESSION_ACTION_TYPES.has("ios_web_explain")).toBe(false)
  })
})

describe("ref namespaces cannot cross-resolve", () => {
  test("wN is only a web ref; eN is only a native ref", () => {
    expect(isWebRef("w1")).toBe(true)
    expect(isWebRef("e1")).toBe(false)
    expect(isNativeRef("e1")).toBe(true)
    expect(isNativeRef("w1")).toBe(false)
    // neither accepts the other's shape or garbage
    expect(isWebRef("w")).toBe(false)
    expect(isWebRef("wax")).toBe(false)
    expect(isNativeRef("42")).toBe(false)
  })
})

describe("setup variant order", () => {
  test("finite page id → classic first; missing page id → no-chunks first", () => {
    expect(setupVariantCandidates(3)[0]).toBe("classic-page-id")
    expect(setupVariantCandidates(null)[0]).toBe("optional-page-id-no-chunks")
    expect(setupVariantCandidates(undefined)[0]).toBe("optional-page-id-no-chunks")
  })
})

describe("error payload contract", () => {
  test("webError carries a stable code + next-step guidance", () => {
    const e = webError("device_unpaired")
    expect(e.success).toBe(false)
    expect((e.data as { code: string }).code).toBe("device_unpaired")
    expect((e.data as { next: string }).next).toContain("Trust This Computer")
  })
})

describe("redaction contract (shared)", () => {
  test("sensitive headers and URL secrets are redacted; safe values pass", () => {
    const h = redactHeaders({ Authorization: "Bearer x", Cookie: "s=1", Accept: "text/html" })
    expect(h.Authorization).toBe("«redacted»")
    expect(h.Cookie).toBe("«redacted»")
    expect(h.Accept).toBe("text/html")
    const u = redactUrl("https://user:pass@ex.com/p?token=SECRET&page=2")
    expect(u).not.toContain("SECRET")
    expect(u).not.toContain("pass")
    expect(u).toContain("page=2")
  })
})
