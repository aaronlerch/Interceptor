import { describe, expect, test } from "bun:test"
import {
  htons, buildPlistXml, encodeUsbmuxMessage, tryReadUsbmuxMessage, plistInteger,
  parseDeviceListXml, pickUsbmuxDeviceId,
} from "../daemon/ios/usbmux-forward"

// These lock the native usbmux wire format against the go-ios / pymobiledevice3
// reference so the forwarder cannot silently drift. The header is 16 LE bytes
// (Length=16+payload, Version=1, Request=8, Tag) followed by an XML plist; a
// Connect carries the port in network byte order.

describe("usbmux wire format", () => {
  test("htons swaps the two bytes of a 16-bit port", () => {
    expect(htons(8100)).toBe(0xa41f) // 0x1FA4 -> 0xA41F = 42015
    expect(htons(8101)).toBe(0xa51f) // 0x1FA5 -> 0xA51F = 42271
    expect(htons(0x1234)).toBe(0x3412)
  })

  test("Connect message header is LE {len, version=1, request=8, tag}", () => {
    const tag = 7
    const msg = encodeUsbmuxMessage({ MessageType: "Connect", DeviceID: 3, PortNumber: htons(8100) }, tag)
    expect(msg.readUInt32LE(0)).toBe(msg.length)       // Length includes the 16-byte header
    expect(msg.readUInt32LE(0)).toBe(16 + (msg.length - 16))
    expect(msg.readUInt32LE(4)).toBe(1)                // Version = PLIST
    expect(msg.readUInt32LE(8)).toBe(8)                // Request = PLIST message
    expect(msg.readUInt32LE(12)).toBe(tag)             // Tag
  })

  test("Connect payload is an XML plist carrying the htons'd port", () => {
    const msg = encodeUsbmuxMessage({ MessageType: "Connect", DeviceID: 3, PortNumber: htons(8100) }, 1)
    const payload = msg.subarray(16).toString("utf-8")
    expect(payload).toContain("<key>MessageType</key><string>Connect</string>")
    expect(payload).toContain("<key>DeviceID</key><integer>3</integer>")
    expect(payload).toContain("<key>PortNumber</key><integer>42015</integer>")
    expect(payload.startsWith("<?xml")).toBe(true)
  })

  test("buildPlistXml escapes XML metacharacters in values", () => {
    expect(buildPlistXml({ K: "a & b < c > d" })).toContain("<string>a &amp; b &lt; c &gt; d</string>")
  })

  test("tryReadUsbmuxMessage frames a message and returns the remainder", () => {
    const a = encodeUsbmuxMessage({ MessageType: "ListDevices" }, 1)
    const b = encodeUsbmuxMessage({ MessageType: "Connect", DeviceID: 1 }, 2)
    const stream = Buffer.concat([a, b])

    // Partial header → need more.
    expect(tryReadUsbmuxMessage(stream.subarray(0, 8))).toBeUndefined()
    // Partial body → need more.
    expect(tryReadUsbmuxMessage(stream.subarray(0, a.length - 1))).toBeUndefined()

    const first = tryReadUsbmuxMessage(stream)!
    expect(first.payload.toString("utf-8")).toContain("ListDevices")
    expect(first.rest.length).toBe(b.length)

    const second = tryReadUsbmuxMessage(first.rest)!
    expect(second.payload.toString("utf-8")).toContain("Connect")
    expect(second.rest.length).toBe(0)
  })

  test("parseDeviceListXml pairs DeviceID↔SerialNumber, tolerates <data> fields", () => {
    // Shape of a real usbmuxd ListDevices reply (EscrowBag <data> breaks JSON
    // conversion, which is why we parse XML).
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict><key>DeviceList</key><array>` +
      `<dict><key>DeviceID</key><integer>5</integer><key>MessageType</key><string>Attached</string>` +
      `<key>Properties</key><dict><key>ConnectionType</key><string>USB</string>` +
      `<key>EscrowBag</key><data>YWJj</data><key>SerialNumber</key><string>UDID-AAA</string></dict></dict>` +
      `<dict><key>DeviceID</key><integer>9</integer>` +
      `<key>Properties</key><dict><key>ConnectionType</key><string>Network</string>` +
      `<key>SerialNumber</key><string>UDID-BBB</string></dict></dict>` +
      `</array></dict></plist>`
    const devs = parseDeviceListXml(xml)
    expect(devs).toEqual([
      { deviceId: 5, udid: "UDID-AAA", connectionType: "USB" },
      { deviceId: 9, udid: "UDID-BBB", connectionType: "Network" },
    ])
  })

  test("pickUsbmuxDeviceId matches lower-case context UDIDs and prefers USB", () => {
    const devices = [
      { deviceId: 9, udid: "00008150-0006290C2282401C", connectionType: "Network" },
      { deviceId: 5, udid: "00008150-0006290C2282401C", connectionType: "USB" },
    ]
    expect(pickUsbmuxDeviceId(devices, "00008150-0006290c2282401c")).toBe(5)
  })

  test("plistInteger pulls a top-level integer value", () => {
    const ok = "<dict><key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer></dict>"
    const err = "<dict><key>Number</key><integer>3</integer></dict>"
    expect(plistInteger(ok, "Number")).toBe(0)
    expect(plistInteger(err, "Number")).toBe(3)
    expect(plistInteger(ok, "Missing")).toBeUndefined()
  })
})
