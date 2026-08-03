import { describe, expect, test } from "bun:test"
import { OwnerRefCount, reconcileByUdid, type WebLaneDevice } from "../daemon/ios/device-services"

// Locks the shared device-service lifetime: reference counting (runner + WIR are
// independent owners, close-once), and pure-usbmux ↔ manager UDID reconciliation.
//

describe("OwnerRefCount", () => {
  test("last release fires the teardown exactly once", async () => {
    let fired = 0
    const rc = new OwnerRefCount(() => { fired++ })
    rc.retain("runner")
    rc.retain("wir")
    await rc.release("runner")
    expect(fired).toBe(0)          // WIR still holds it
    expect(rc.isClosed).toBe(false)
    await rc.release("wir")
    expect(fired).toBe(1)          // now torn down
    expect(rc.isClosed).toBe(true)
  })

  test("runner disconnect does not close a session WIR still retains", async () => {
    let fired = 0
    const rc = new OwnerRefCount(() => { fired++ })
    rc.retain("wir")
    rc.retain("runner")
    await rc.release("runner")     // runner drops
    expect(fired).toBe(0)          // WIR keeps it alive
  })

  test("explicit close short-circuits later releases (device removal, close once)", async () => {
    let fired = 0
    const rc = new OwnerRefCount(() => { fired++ })
    rc.retain("wir")
    rc.markClosed()                // device removed → external teardown
    await rc.release("wir")
    expect(fired).toBe(0)          // callback not double-fired
    expect(rc.isClosed).toBe(true)
  })

  test("releasing an unknown owner is a no-op", async () => {
    let fired = 0
    const rc = new OwnerRefCount(() => { fired++ })
    rc.retain("a")
    await rc.release("ghost")
    expect(fired).toBe(0)
    expect(rc.size).toBe(1)
  })
})

describe("reconcileByUdid", () => {
  const web: WebLaneDevice[] = [
    { udid: "00001234-AAA", contextId: "ios:00001234-aaa", paired: true, transport: "USB" },
  ]

  test("manager descriptor fills gaps left by usbmux/lockdown, case-insensitively", () => {
    const out = reconcileByUdid(web, [{ udid: "00001234-aaa", name: "Test iPhone", productVersion: "26.1" }])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("Test iPhone")
    expect(out[0].productVersion).toBe("26.1")
    expect(out[0].transport).toBe("USB") // usbmux fact preserved
  })

  test("usbmux fields win when present; nothing is invented", () => {
    const withName: WebLaneDevice[] = [{ ...web[0], name: "From lockdown" }]
    const out = reconcileByUdid(withName, [{ udid: "00001234-AAA", name: "From manager" }])
    expect(out[0].name).toBe("From lockdown")
  })

  test("a manager-only (network) device usbmux missed is appended", () => {
    const out = reconcileByUdid(web, [
      { udid: "00001234-AAA", name: "wired" },
      { udid: "00008999-BBB", name: "wifi-only", contextId: "ios:00008999-bbb" },
    ])
    expect(out).toHaveLength(2)
    const extra = out.find((d) => d.udid === "00008999-BBB")!
    expect(extra.transport).toBe("manager")
    expect(extra.name).toBe("wifi-only")
  })
})
