import { describe, expect, test } from "bun:test"
import { _decodeEntry, _printableRuns } from "../daemon/ios/ostrace"

// os_trace entry decode: pull the human-readable strings out of a packed entry
// body and pick the message.

describe("os_trace printable extraction", () => {
  test("finds NUL-terminated runs, drops short noise", () => {
    const body = Buffer.concat([
      Buffer.from([0x01, 0x00, 0x02]),        // binary noise (< min run)
      Buffer.from("SpringBoard\0", "utf8"),
      Buffer.from([0x00, 0x00]),
      Buffer.from("layout did change\0", "utf8"),
    ])
    const runs = _printableRuns(body)
    expect(runs).toContain("SpringBoard")
    expect(runs).toContain("layout did change")
  })

  test("decodeEntry picks the longest run as the message", () => {
    const body = Buffer.concat([
      Buffer.alloc(4),                         // pid slot
      Buffer.from("dasd\0", "utf8"),
      Buffer.from("evaluating activity com.apple.foo\0", "utf8"),
    ])
    const e = _decodeEntry(body)
    expect(e.message).toBe("evaluating activity com.apple.foo")
    expect(e.strings.length).toBeGreaterThanOrEqual(2)
    expect(typeof e.at).toBe("string")
  })

  test("empty body → empty message, no throw", () => {
    const e = _decodeEntry(Buffer.alloc(0))
    expect(e.message).toBe("")
  })
})
