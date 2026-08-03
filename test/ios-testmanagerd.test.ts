import { describe, expect, test } from "bun:test"
import { DTX_MAGIC, DTX_HEADER_SIZE, encodeDtxHeader, decodeDtxHeader } from "../daemon/ios/testmanagerd"

// Locks the DTX message header (magic 0x1F3D5B79, 32-byte header, LE fields)
// testmanagerd speaks to launch the runner — replaces xcodebuild.

describe("DTX message header codec", () => {
  test("32-byte header with magic + fields roundtrips", () => {
    const h = {
      fragmentIndex: 0, fragmentCount: 1, length: 512,
      identifier: 3, conversationIndex: 1, channelCode: -1, expectsReply: true,
    }
    const b = encodeDtxHeader(h)
    expect(b.length).toBe(DTX_HEADER_SIZE)
    expect(b.readUInt32LE(0)).toBe(DTX_MAGIC)
    expect(b.readUInt32LE(4)).toBe(DTX_HEADER_SIZE) // cb / header length
    const d = decodeDtxHeader(b)!
    expect(d.fragmentIndex).toBe(0)
    expect(d.fragmentCount).toBe(1)
    expect(d.length).toBe(512)
    expect(d.identifier).toBe(3)
    expect(d.conversationIndex).toBe(1)
    expect(d.channelCode).toBe(-1)      // channel codes are signed
    expect(d.expectsReply).toBe(true)
  })
  test("rejects a buffer without the DTX magic", () => {
    expect(decodeDtxHeader(Buffer.alloc(DTX_HEADER_SIZE))).toBeUndefined()
  })
})
