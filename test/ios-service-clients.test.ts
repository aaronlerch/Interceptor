import { describe, expect, test } from "bun:test"
import { AfcClient, AFC_OP, encodeAfcHeader, decodeAfcHeader } from "../daemon/ios/installer"
import { plistToJson } from "../daemon/ios/service-clients"
import { classifyServiceError, svcError } from "../shared/ios-service"

// Locks the AFC protocol reuse (readDir/readFile over installer.ts's AfcClient),
// the plist→JSON normalizer, and the stable error mapping.

/** An auto-responding fake AFC device: decode each request, emit the matching reply. */
class FakeAfcDevice {
  handlers: Record<string, ((...a: any[]) => void)[]> = {}
  fileBytes: Buffer
  names: string[]
  constructor(opts: { names?: string[]; fileBytes?: Buffer } = {}) {
    this.names = opts.names ?? ["a.txt", "b.txt", ".", ".."]
    this.fileBytes = opts.fileBytes ?? Buffer.from("file-contents")
  }
  on(ev: string, cb: (...a: any[]) => void): this { (this.handlers[ev] ??= []).push(cb); return this }
  removeAllListeners(ev?: string): this { if (ev) this.handlers[ev] = []; else this.handlers = {}; return this }
  destroy(): void {}
  private emit(ev: string, ...a: any[]): void { for (const cb of this.handlers[ev] ?? []) cb(...a) }
  private reply(op: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0), data: Buffer<ArrayBufferLike> = Buffer.alloc(0), packet = 1): void {
    const thisLen = 40 + payload.length
    const entireLen = thisLen + data.length
    const frame = Buffer.concat([encodeAfcHeader(op, thisLen, entireLen, packet), payload, data])
    queueMicrotask(() => this.emit("data", frame))
  }
  private status0(): Buffer<ArrayBufferLike> { return Buffer.alloc(8) /* status 0 = Success */ }
  write(frame: Buffer): boolean {
    const h = decodeAfcHeader(frame)!
    if (h.op === AFC_OP.ReadDir) this.reply(AFC_OP.Data, Buffer.from(this.names.join("\0") + "\0"), Buffer.alloc(0), h.packetNum)
    else if (h.op === AFC_OP.FileOpen) { const hd = Buffer.alloc(8); hd.writeBigUInt64LE(42n, 0); this.reply(AFC_OP.FileOpenResult, hd, Buffer.alloc(0), h.packetNum) }
    else if (h.op === AFC_OP.FileRead) this.reply(AFC_OP.Data, this.fileBytes, Buffer.alloc(0), h.packetNum)
    else if (h.op === AFC_OP.FileClose || h.op === AFC_OP.FileWrite || h.op === AFC_OP.MakeDir) this.reply(AFC_OP.Status, this.status0(), Buffer.alloc(0), h.packetNum)
    else this.reply(AFC_OP.Status, this.status0(), Buffer.alloc(0), h.packetNum)
    return true
  }
}

describe("AfcClient over the shared AFC codec", () => {
  test("readDir returns names, filtering . and ..", async () => {
    const dev = new FakeAfcDevice({ names: ["Documents", "Library", ".", ".."] })
    const afc = new AfcClient(dev as any)
    expect(await afc.readDir(".")).toEqual(["Documents", "Library"])
  })

  test("readFile pulls the whole file (open → read → close)", async () => {
    const dev = new FakeAfcDevice({ fileBytes: Buffer.from("hello-crash-log") })
    const afc = new AfcClient(dev as any)
    const bytes = await afc.readFile("problems/x.ips")
    expect(Buffer.from(bytes).toString()).toBe("hello-crash-log")
  })
})

describe("plistToJson", () => {
  test("recurses; Buffers become {$data,$bytes}; scalars pass through", () => {
    const out = plistToJson({ n: 5, s: "x", t: true, d: Buffer.from("ab"), arr: [1, Buffer.from("z")], nested: { k: "v" } }) as any
    expect(out.n).toBe(5)
    expect(out.s).toBe("x")
    expect(out.t).toBe(true)
    expect(out.d).toEqual({ $data: Buffer.from("ab").toString("base64"), $bytes: 2 })
    expect(out.arr[1].$bytes).toBe(1)
    expect(out.nested.k).toBe("v")
  })
})

describe("error contract", () => {
  test("classifyServiceError maps messages to stable codes", () => {
    expect(classifyServiceError(new Error("'x' is not paired with this Mac yet"))).toBe("device_unpaired")
    expect(classifyServiceError(new Error("device is locked"))).toBe("device_locked")
    expect(classifyServiceError(new Error("lockdown StartService(com.apple.x) failed: InvalidService"))).toBe("service_unavailable")
    expect(classifyServiceError(new Error("AFC op 0x3 failed with status 8"))).toBe("afc_error")
    expect(classifyServiceError(new Error("whatever"))).toBe("bad_request")
  })
  test("svcError carries code + next-step guidance", () => {
    const e = svcError("device_unpaired")
    expect(e.success).toBe(false)
    expect((e.data as { code: string }).code).toBe("device_unpaired")
    expect((e.data as { next: string }).next).toContain("Trust This Computer")
  })
})
