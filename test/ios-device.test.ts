import { describe, expect, test } from "bun:test"
import {
  IOS_CONTEXT_PREFIX, IOS_ACTION_TYPES, IOS_VERB_TYPES, IOS_WAY_IN_RUNG,
  classifyIosWayIn, describeIosWayIn, describeIosDevice,
  isIosContextId, iosContextId, udidFromContextId,
  iosMajorVersion, deviceNeedsTunnel,
} from "../shared/ios-device"
import { validateContextRouting } from "../daemon/outbound-routing"

describe("ios-device classifier", () => {
  test("simulator is always rung 0, no signing/dev-mode needed", () => {
    expect(classifyIosWayIn({ kind: "simulator" })).toBe("simulator")
    expect(IOS_WAY_IN_RUNG.simulator).toBe(0)
  })

  test("physical device needs pairing AND Developer Mode for rung 1", () => {
    expect(classifyIosWayIn({ kind: "device", paired: true, developerMode: true })).toBe("dev-provisioned")
    expect(classifyIosWayIn({ kind: "device", paired: true, developerMode: false })).toBe("unsupported")
    expect(classifyIosWayIn({ kind: "device", paired: false, developerMode: true })).toBe("unsupported")
  })

  test("supervised paired+devmode device bumps to rung 2", () => {
    expect(classifyIosWayIn({ kind: "device", paired: true, developerMode: true, supervised: true })).toBe("supervised")
  })

  test("describeIosWayIn returns a non-empty hint for every rung", () => {
    for (const w of ["simulator", "dev-provisioned", "supervised", "unsupported"] as const) {
      expect(describeIosWayIn(w).length).toBeGreaterThan(0)
    }
  })
})

describe("ios-device context-id helpers", () => {
  test("iosContextId / isIosContextId / udidFromContextId round-trip", () => {
    const udid = "00008110-001A2B3C4D5E6F00"
    const ctx = iosContextId(udid)
    expect(ctx.startsWith(IOS_CONTEXT_PREFIX)).toBe(true)
    expect(isIosContextId(ctx)).toBe(true)
    expect(isIosContextId("cdp:foo")).toBe(false)
    expect(isIosContextId(undefined)).toBe(false)
    expect(udidFromContextId(ctx)).toBe(udid.toLowerCase())
  })
})

describe("ios version / tunnel logic", () => {
  test("iosMajorVersion parses the major", () => {
    expect(iosMajorVersion("17.4.1")).toBe(17)
    expect(iosMajorVersion("16.0")).toBe(16)
    expect(iosMajorVersion(undefined)).toBeUndefined()
    expect(iosMajorVersion("garbage")).toBeUndefined()
  })

  test("iOS 17+ needs a tunnel; 16 and below do not", () => {
    expect(deviceNeedsTunnel("17.0")).toBe(true)
    expect(deviceNeedsTunnel("18.2")).toBe(true)
    expect(deviceNeedsTunnel("16.7")).toBe(false)
    expect(deviceNeedsTunnel(undefined)).toBe(false)
  })

  test("describeIosDevice marks a 17+ physical device as needsTunnel and a sim as not", () => {
    const dev = describeIosDevice({ udid: "u1", name: "iPhone", kind: "device", productVersion: "17.4", paired: true, developerMode: true })
    expect(dev.needsTunnel).toBe(true)
    expect(dev.wayIn).toBe("dev-provisioned")
    const sim = describeIosDevice({ udid: "u2", name: "iPhone 15", kind: "simulator", productVersion: "17.4" })
    expect(sim.needsTunnel).toBe(false)
    expect(sim.wayIn).toBe("simulator")
    expect(sim.developerMode).toBe(true) // sim is always "on"
  })
})

describe("ios action-type sets are disjoint and complete", () => {
  test("lifecycle vs verb sets do not overlap", () => {
    for (const t of IOS_ACTION_TYPES) expect(IOS_VERB_TYPES.has(t)).toBe(false)
  })
  test("expected verbs present", () => {
    for (const v of ["ios_tree", "ios_click", "ios_type", "ios_screenshot", "ios_app", "ios_press", "ios_eval"]) {
      expect(IOS_VERB_TYPES.has(v)).toBe(true)
    }
  })
})

describe("validateContextRouting honors iosContexts", () => {
  const iosCtx = "ios:00008110-aaa"
  test("accepts a known ios context", () => {
    expect(validateContextRouting({ contextId: iosCtx, connectedContexts: [], nativeRelayAvailable: false, iosContexts: [iosCtx] }))
      .toEqual({ ok: true })
  })
  test("rejects an unknown ios context with a helpful hint", () => {
    const r = validateContextRouting({ contextId: "ios:nope", connectedContexts: [], nativeRelayAvailable: false, iosContexts: [iosCtx] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(iosCtx)
  })
  test("with no extensions but an ios context present, disambiguation names it", () => {
    const r = validateContextRouting({ connectedContexts: [], nativeRelayAvailable: false, iosContexts: [iosCtx] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("iOS device")
      expect(r.error).toContain(iosCtx)
    }
  })
  test("does not regress cdp-only behavior", () => {
    const r = validateContextRouting({ connectedContexts: [], nativeRelayAvailable: false, cdpContexts: ["cdp:slack"] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("cdp:slack")
  })
})
