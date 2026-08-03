/**
 * daemon/ios/pcapd.ts — device-wide packet capture via pcapd.
 *
 * `com.apple.pcapd` (classic Lockdown) streams every packet the device sends or
 * receives. Each message is a 4-byte big-endian length + an `IOSPacketHeader`
 * struct + the captured frame (a bare IP packet). We frame it, strip the header
 * (`hdr_length` at offset 0 points exactly past it; the last two u32 of the header
 * are the timeval), and emit libpcap records (LINKTYPE_RAW) so the output opens
 * directly in Wireshark/tcpdump.
 *
 * Pure Buffer framing — the file-writer helpers are unit-testable device-free.
 */

import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import { connectServiceSocket } from "./lockdown"
import { BoundedBuffer } from "./service-plist"
import type { BufferedItem } from "./service-plist"

type Sock = Socket | TLSSocket

export const LINKTYPE_RAW = 101
const PCAP_MAGIC = 0xa1b2c3d4

/** libpcap global header (24 bytes, host-endian little). */
export function pcapGlobalHeader(linktype = LINKTYPE_RAW, snaplen = 262144): Buffer {
  const h = Buffer.alloc(24)
  h.writeUInt32LE(PCAP_MAGIC, 0)
  h.writeUInt16LE(2, 4)          // version major
  h.writeUInt16LE(4, 6)          // version minor
  h.writeInt32LE(0, 8)           // thiszone
  h.writeUInt32LE(0, 12)         // sigfigs
  h.writeUInt32LE(snaplen, 16)
  h.writeUInt32LE(linktype, 20)
  return h
}

/** libpcap per-packet record: 16-byte header + frame bytes. */
export function pcapPacketRecord(tsSec: number, tsUsec: number, frame: Buffer): Buffer {
  const h = Buffer.alloc(16)
  h.writeUInt32LE(tsSec >>> 0, 0)
  h.writeUInt32LE(tsUsec >>> 0, 4)
  h.writeUInt32LE(frame.length, 8)  // incl_len
  h.writeUInt32LE(frame.length, 12) // orig_len
  return Buffer.concat([h, frame])
}

export type IosPacket = { tsSec: number; tsUsec: number; frame: Buffer }

/** Parse one pcapd message (IOSPacketHeader + frame). `hdr_length` at offset 0
 *  (BE u32) points past the header; its final two u32 BE are seconds/microseconds. */
export function parseIosPacket(msg: Buffer): IosPacket {
  if (msg.length < 4) throw new Error("pcapd: short message")
  const hdrLen = msg.readUInt32BE(0)
  if (hdrLen < 8 || hdrLen > msg.length) throw new Error(`pcapd: bad hdr_length ${hdrLen}`)
  const tsSec = msg.readUInt32BE(hdrLen - 8)
  const tsUsec = msg.readUInt32BE(hdrLen - 4)
  const frame = Buffer.from(msg.subarray(hdrLen))
  return { tsSec, tsUsec, frame }
}

/** Frame the 4-byte-BE-length message stream. */
class PcapFramer {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false
  constructor(sock: Sock, private onPacket: (p: IosPacket) => void) {
    sock.on("data", (c: Buffer) => this.feed(c))
    sock.on("close", () => { this.closed = true })
    sock.on("error", () => { this.closed = true })
  }
  private feed(chunk: Buffer): void {
    this.acc = this.acc.length ? Buffer.concat([this.acc, chunk]) : chunk
    for (;;) {
      if (this.acc.length < 4) return
      const len = this.acc.readUInt32BE(0)
      if (len > 16 * 1024 * 1024) { this.closed = true; return } // guard
      if (this.acc.length < 4 + len) return
      const msg = this.acc.subarray(4, 4 + len)
      this.acc = this.acc.subarray(4 + len)
      try { this.onPacket(parseIosPacket(Buffer.from(msg))) } catch { /* skip */ }
    }
  }
  get isClosed(): boolean { return this.closed }
}

export type PcapStream = { buffer: BoundedBuffer<BufferedItem>; close: () => void; isClosed: () => boolean }

/** Open a live pcapd capture; each packet is buffered as a base64 libpcap record. */
export async function openPcap(udid: string, buffer: BoundedBuffer<BufferedItem>): Promise<PcapStream> {
  const { sock } = await connectServiceSocket(udid, "com.apple.pcapd")
  const framer = new PcapFramer(sock, (p) => {
    buffer.push({ at: new Date().toISOString(), tsSec: p.tsSec, tsUsec: p.tsUsec, len: p.frame.length, recordB64: pcapPacketRecord(p.tsSec, p.tsUsec, p.frame).toString("base64") })
  })
  return { buffer, close: () => { try { sock.destroy() } catch {} }, isClosed: () => framer.isClosed }
}
