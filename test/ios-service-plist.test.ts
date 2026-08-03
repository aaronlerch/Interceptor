import { describe, expect, test } from "bun:test"
import {
  BoundedBuffer, sendPlistAwaitReply, sendPlistCollect, RawLineStream, PlistFrameStream,
  asDict, pStr,
} from "../daemon/ios/service-plist"
import { encodeLockdownFrame } from "../daemon/ios/lockdown"

// Locks the classic-Lockdown framing/stream helpers: framed plist request/reply,
// stream-until-Status:Complete, raw line reassembly, framed-plist notifications,
// and the bounded buffer overflow accounting.

/** Minimal net.Socket stand-in: captures writes, lets tests emit data/close/error. */
class FakeSocket {
  handlers: Record<string, ((...a: any[]) => void)[]> = {}
  writes: Buffer[] = []
  destroyed = false
  on(ev: string, cb: (...a: any[]) => void): this { (this.handlers[ev] ??= []).push(cb); return this }
  removeAllListeners(ev?: string): this { if (ev) this.handlers[ev] = []; else this.handlers = {}; return this }
  write(b: Buffer): boolean { this.writes.push(Buffer.from(b)); return true }
  destroy(): void { this.destroyed = true; this.emit("close") }
  emit(ev: string, ...a: any[]): void { for (const cb of this.handlers[ev] ?? []) cb(...a) }
}

describe("BoundedBuffer", () => {
  test("caps by count and counts drops", () => {
    const b = new BoundedBuffer<{ n: number }>(3, 1e9)
    for (let i = 0; i < 5; i++) b.push({ n: i })
    const d = b.drain()
    expect(d.items).toHaveLength(3)
    expect(d.dropped).toBe(2)
    expect(d.items[0].n).toBe(2)
    expect(typeof d.retainedFrom).toBe("string")
  })
})

describe("sendPlistAwaitReply", () => {
  test("writes a framed request and decodes one framed reply (incl. <data>)", async () => {
    const s = new FakeSocket()
    const p = sendPlistAwaitReply(s as any, { Request: "All" })
    // request was framed + written
    expect(s.writes.length).toBe(1)
    expect(s.writes[0].readUInt32BE(0)).toBe(s.writes[0].length - 4)
    // device replies with a lockdown frame carrying <data>
    s.emit("data", encodeLockdownFrame({ Status: "Success", Diagnostics: { Blob: Buffer.from("abc") } }))
    const v = asDict(await p) as any
    expect(pStr(v.Status)).toBe("Success")
    expect(Buffer.isBuffer(v.Diagnostics.Blob)).toBe(true)
  })

  test("rejects on close before reply", async () => {
    const s = new FakeSocket()
    const p = sendPlistAwaitReply(s as any, { Request: "All" }, 500)
    s.emit("close")
    await expect(p).rejects.toBeDefined()
  })
})

describe("sendPlistCollect", () => {
  test("collects frames until Status Complete", async () => {
    const s = new FakeSocket()
    const p = sendPlistCollect(s as any, { Command: "Browse" }, (v) => pStr(asDict(v)?.Status) === "Complete")
    s.emit("data", encodeLockdownFrame({ CurrentList: ["a"] }))
    s.emit("data", encodeLockdownFrame({ CurrentList: ["b"] }))
    s.emit("data", encodeLockdownFrame({ Status: "Complete" }))
    const out = await p
    expect(out).toHaveLength(3)
    expect(pStr(asDict(out[2])?.Status)).toBe("Complete")
  })
})

describe("RawLineStream", () => {
  test("reassembles a line split across reads; flushes tail on close", () => {
    const s = new FakeSocket()
    const lines: string[] = []
    new RawLineStream(s as any, (l) => lines.push(l), { delimiter: /\n/ })
    s.emit("data", Buffer.from("hello wo"))
    s.emit("data", Buffer.from("rld\nsecond line"))
    expect(lines).toEqual(["hello world"])   // partial "second line" held
    s.emit("close")
    expect(lines).toEqual(["hello world", "second line"]) // tail flushed
  })
})

describe("PlistFrameStream", () => {
  test("decodes framed notifications and can send observe commands", () => {
    const s = new FakeSocket()
    const got: string[] = []
    const stream = new PlistFrameStream(s as any, (v) => { const n = pStr(asDict(v)?.Name); if (n) got.push(n) })
    stream.send({ Command: "ObserveNotification", Name: "com.example.foo" })
    expect(s.writes.length).toBe(1)
    s.emit("data", encodeLockdownFrame({ Command: "RelayNotification", Name: "com.example.foo" }))
    expect(got).toEqual(["com.example.foo"])
  })

  test("a complete but malformed plist frame closes the stream via onError", () => {
    const s = new FakeSocket()
    let errored = false
    const stream = new PlistFrameStream(s as any, () => {}, { onError: () => { errored = true } })
    // complete frame (valid 4-byte length) whose body is not a plist → decodePlist throws
    const body = Buffer.from("not-a-plist-at-all")
    const hdr = Buffer.alloc(4); hdr.writeUInt32BE(body.length, 0)
    s.emit("data", Buffer.concat([hdr, body]))
    expect(errored).toBe(true)
    expect(stream.isClosed).toBe(true)
  })
})
