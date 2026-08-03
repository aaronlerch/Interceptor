import { describe, expect, test } from "bun:test"
import { IOS_ACTION_TYPES, IOS_VERB_TYPES } from "../shared/ios-device"
import { IOS_WEB_ACTION_TYPES } from "../shared/ios-web"
import { IOS_SVC_ACTION_TYPES, IOS_SVC_STREAM_ACTION_TYPES } from "../shared/ios-service"
import { IosDeviceServiceManager } from "../daemon/ios/service-manager"
import type { WebLaneDevice } from "../daemon/ios/device-services"

// Locks the routing contract: the ios_svc_* set is DISJOINT from the native
// lifecycle/verb sets and the web set, so a service action can only reach the
// runner via the broad `ios:` fallback — which daemon/index.ts tests AFTER the
// ios_svc check. Plus device resolution + stream lifecycle.

describe("ios_svc action set", () => {
  test("has exactly the 7 normative action types", () => {
    expect(IOS_SVC_ACTION_TYPES.size).toBe(7)
    for (const t of ["ios_diag", "ios_logs", "ios_fs", "ios_crash", "ios_profiles", "ios_notify", "ios_springboard"]) {
      expect(IOS_SVC_ACTION_TYPES.has(t)).toBe(true)
    }
  })

  test("is disjoint from native lifecycle, native verb, and web action sets", () => {
    for (const t of IOS_SVC_ACTION_TYPES) {
      expect(IOS_ACTION_TYPES.has(t)).toBe(false)
      expect(IOS_VERB_TYPES.has(t)).toBe(false)   // cannot hit executeVerb by type
      expect(IOS_WEB_ACTION_TYPES.has(t)).toBe(false)
    }
  })

  test("stream subset is contained and only holds streaming actions", () => {
    for (const t of IOS_SVC_STREAM_ACTION_TYPES) expect(IOS_SVC_ACTION_TYPES.has(t)).toBe(true)
    expect(IOS_SVC_STREAM_ACTION_TYPES.has("ios_logs")).toBe(true)
    expect(IOS_SVC_STREAM_ACTION_TYPES.has("ios_notify")).toBe(true)
    expect(IOS_SVC_STREAM_ACTION_TYPES.has("ios_diag")).toBe(false)
  })
})

const oneDevice = async (): Promise<WebLaneDevice[]> => [{ udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" }]

describe("IosDeviceServiceManager device resolution", () => {
  test("no paired device → device_not_found", async () => {
    const mgr = new IosDeviceServiceManager({ discover: async () => [] })
    const r = await mgr.handle({ type: "ios_profiles" })
    expect(r.success).toBe(false)
    expect((r.data as any).code).toBe("device_not_found")
  })

  test("multiple devices → device_not_found with candidates", async () => {
    const mgr = new IosDeviceServiceManager({ discover: async () => [
      { udid: "U1", contextId: "ios:u1", paired: true, transport: "USB" },
      { udid: "U2", contextId: "ios:u2", paired: true, transport: "USB" },
    ] })
    const r = await mgr.handle({ type: "ios_profiles" })
    expect((r.data as any).code).toBe("device_not_found")
    expect((r.data as any).candidates).toHaveLength(2)
  })

  test("logs read with no active stream → stream_not_found (device resolved, no socket opened)", async () => {
    const mgr = new IosDeviceServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_logs", operation: "read" }, "ios:u1")
    expect(r.success).toBe(false)
    expect((r.data as any).code).toBe("stream_not_found")
  })

  test("notify read with no active stream → stream_not_found", async () => {
    const mgr = new IosDeviceServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_notify", operation: "read" }, "ios:u1")
    expect((r.data as any).code).toBe("stream_not_found")
  })

  test("fs push without --app → container_not_owned (never touches the device)", async () => {
    const mgr = new IosDeviceServiceManager({ discover: oneDevice })
    const r = await mgr.handle({ type: "ios_fs", op: "push", path: "/x", base64: "" }, "ios:u1")
    expect((r.data as any).code).toBe("container_not_owned")
  })
})
