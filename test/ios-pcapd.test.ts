import { describe, expect, test } from "bun:test"
import { pcapGlobalHeader, pcapPacketRecord, parseIosPacket, LINKTYPE_RAW } from "../daemon/ios/pcapd"

// libpcap file framing + IOSPacketHeader parsing.

describe("pcap file framing", () => {
  test("global header: magic, version, linktype", () => {
    const h = pcapGlobalHeader()
    expect(h.length).toBe(24)
    expect(h.readUInt32LE(0)).toBe(0xa1b2c3d4)
    expect(h.readUInt16LE(4)).toBe(2)   // version major
    expect(h.readUInt16LE(6)).toBe(4)   // version minor
    expect(h.readUInt32LE(20)).toBe(LINKTYPE_RAW)
  })

  test("packet record: 16-byte header + frame, lengths match", () => {
    const frame = Buffer.from([0x45, 0x00, 0x00, 0x14]) // IPv4 header start
    const rec = pcapPacketRecord(1700000000, 123456, frame)
    expect(rec.length).toBe(16 + frame.length)
    expect(rec.readUInt32LE(0)).toBe(1700000000) // ts_sec
    expect(rec.readUInt32LE(4)).toBe(123456)     // ts_usec
    expect(rec.readUInt32LE(8)).toBe(frame.length)  // incl_len
    expect(rec.readUInt32LE(12)).toBe(frame.length) // orig_len
    expect(rec.subarray(16)).toEqual(frame)
  })
})

describe("IOSPacketHeader parsing", () => {
  test("hdr_length points past header; timeval is its last two u32 BE", () => {
    const hdrLen = 24
    const hdr = Buffer.alloc(hdrLen)
    hdr.writeUInt32BE(hdrLen, 0)          // hdr_length
    hdr.writeUInt32BE(1699999999, hdrLen - 8) // seconds
    hdr.writeUInt32BE(654321, hdrLen - 4)     // microseconds
    const frame = Buffer.from([0x45, 0x11, 0x22, 0x33])
    const p = parseIosPacket(Buffer.concat([hdr, frame]))
    expect(p.tsSec).toBe(1699999999)
    expect(p.tsUsec).toBe(654321)
    expect(p.frame).toEqual(frame)
  })

  test("bad hdr_length throws", () => {
    const bad = Buffer.alloc(8); bad.writeUInt32BE(9999, 0)
    expect(() => parseIosPacket(bad)).toThrow()
  })
})
