/**
 * daemon/ios/webinspector-plist.ts — bounded, in-process plist codec for WIR.
 *
 * The device's Web Inspector relay carries binary OR XML plist frames, and WIR
 * socket data rides inside plist `<data>` values. The existing lockdown helper
 * shells out to `plutil` and cannot decode `<data>` to JSON [daemon/ios/lockdown.ts],
 * so production WIR needs a self-contained decoder that:
 *   - sniffs bplist00 vs XML;
 *   - decodes dict/array/string/integer/real/bool/data (and null/date best-effort);
 *   - is HARD-bounded: a declared length past the cap fails BEFORE allocation,
 *     nesting is capped, decoded strings/data are capped, and any malformed frame
 *     throws PlistError (the caller maps that to `wir_malformed_frame`).
 *
 * Pure (node Buffer only) so it is unit-testable without a device.
 */

export type PlistValue = string | number | boolean | Buffer | null | PlistValue[] | PlistDict | PlistUID
export interface PlistDict { [k: string]: PlistValue }

/** A binary-plist UID (NSKeyedArchiver object reference). Distinct from a plain
 *  integer so `nskeyedUnarchive` can resolve the $objects graph. */
export class PlistUID {
  constructor(public readonly uid: number) {}
}

export type PlistLimits = {
  /** Max whole-frame bytes accepted before parsing (declared > cap fails first). */
  maxBytes: number
  /** Max container nesting depth. */
  maxDepth: number
  /** Max total container entries (array elements + dict pairs). */
  maxNodes: number
  /** Max bytes for a single string/data leaf. */
  maxLeafBytes: number
}

export const DEFAULT_PLIST_LIMITS: PlistLimits = {
  maxBytes: 32 * 1024 * 1024, // 32 MiB frame cap
  maxDepth: 64,
  maxNodes: 500_000,
  maxLeafBytes: 8 * 1024 * 1024, // 8 MiB
}

export class PlistError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlistError"
  }
}

const BPLIST_MAGIC = Buffer.from("bplist00", "latin1")

export function isBinaryPlist(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(BPLIST_MAGIC)
}

/** Decode a plist frame (binary or XML). Enforces the byte cap up front. */
export function decodePlist(buf: Buffer, limits: PlistLimits = DEFAULT_PLIST_LIMITS): PlistValue {
  if (buf.length > limits.maxBytes) throw new PlistError(`plist frame exceeds ${limits.maxBytes}-byte cap`)
  return isBinaryPlist(buf) ? decodeBinaryPlist(buf, limits) : decodeXmlPlist(buf.toString("utf-8"), limits)
}

// ── binary plist (bplist00) ───────────────────────────────────────────────────

function readUBE(buf: Buffer, off: number, len: number): number {
  if (off < 0 || len < 0 || off + len > buf.length) throw new PlistError("binary plist: read out of bounds")
  let v = 0n
  for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(buf[off + k])
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlistError("binary plist: integer exceeds safe range")
  return Number(v)
}

function readPlistInt(buf: Buffer, off: number, len: number): number {
  if (off < 0 || len < 0 || off + len > buf.length) throw new PlistError("binary plist: int read out of bounds")
  let v = 0n
  for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(buf[off + k])
  // 8- and 16-byte plist integers are signed two's complement.
  if (len >= 8) {
    const bits = BigInt(len * 8)
    if (v >> (bits - 1n)) v -= 1n << bits
  }
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new PlistError("binary plist: integer exceeds safe range")
  }
  return Number(v)
}

export function decodeBinaryPlist(buf: Buffer, limits: PlistLimits = DEFAULT_PLIST_LIMITS): PlistValue {
  if (!isBinaryPlist(buf)) throw new PlistError("binary plist: bad magic")
  if (buf.length < 8 + 32) throw new PlistError("binary plist: truncated (no trailer)")
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const numObjects = readUBE(trailer, 8, 8)
  const topObject = readUBE(trailer, 16, 8)
  const offsetTableOffset = readUBE(trailer, 24, 8)

  if (offsetSize < 1 || offsetSize > 8) throw new PlistError("binary plist: bad offset size")
  if (refSize < 1 || refSize > 8) throw new PlistError("binary plist: bad ref size")
  if (numObjects < 1 || numObjects > limits.maxNodes) throw new PlistError("binary plist: object count out of range")
  if (topObject >= numObjects) throw new PlistError("binary plist: bad top object")
  const tableEnd = offsetTableOffset + numObjects * offsetSize
  if (offsetTableOffset < 8 || tableEnd > buf.length - 32) throw new PlistError("binary plist: offset table out of range")

  const offsets = new Array<number>(numObjects)
  for (let i = 0; i < numObjects; i++) offsets[i] = readUBE(buf, offsetTableOffset + i * offsetSize, offsetSize)

  let nodes = 0
  const seen = new Set<number>() // cycle guard on the object graph

  // Reads a container's element count: low nibble, or (lo === 0xF) an inline int.
  const readCount = (pos: number, lo: number): { count: number; next: number } => {
    if (lo !== 0x0f) return { count: lo, next: pos }
    const marker = buf[pos]
    if ((marker & 0xf0) !== 0x10) throw new PlistError("binary plist: bad count marker")
    const intLen = 1 << (marker & 0x0f)
    return { count: readUBE(buf, pos + 1, intLen), next: pos + 1 + intLen }
  }

  const decodeObj = (index: number, depth: number): PlistValue => {
    if (depth > limits.maxDepth) throw new PlistError("binary plist: too deeply nested")
    if (index < 0 || index >= numObjects) throw new PlistError("binary plist: object ref out of range")
    let pos = offsets[index]
    if (pos < 8 || pos >= offsetTableOffset) throw new PlistError("binary plist: object offset out of range")
    const marker = buf[pos]
    pos++
    const hi = marker & 0xf0
    const lo = marker & 0x0f

    switch (hi) {
      case 0x00:
        if (marker === 0x00) return null
        if (marker === 0x08) return false
        if (marker === 0x09) return true
        throw new PlistError(`binary plist: unsupported primitive 0x${marker.toString(16)}`)
      case 0x10:
        return readPlistInt(buf, pos, 1 << lo)
      case 0x20: {
        const n = 1 << lo
        if (n === 4) return buf.readFloatBE(pos)
        if (n === 8) return buf.readDoubleBE(pos)
        throw new PlistError("binary plist: unsupported real width")
      }
      case 0x30: // date (seconds since 2001) — surfaced as its raw double
        return buf.readDoubleBE(pos)
      case 0x40: {
        const { count, next } = readCount(pos, lo)
        if (count > limits.maxLeafBytes) throw new PlistError("binary plist: data leaf too large")
        if (next + count > buf.length) throw new PlistError("binary plist: data out of bounds")
        return Buffer.from(buf.subarray(next, next + count))
      }
      case 0x50: {
        const { count, next } = readCount(pos, lo)
        if (count > limits.maxLeafBytes) throw new PlistError("binary plist: ascii string too large")
        if (next + count > buf.length) throw new PlistError("binary plist: string out of bounds")
        return buf.subarray(next, next + count).toString("latin1")
      }
      case 0x60: {
        const { count, next } = readCount(pos, lo)
        const bytes = count * 2
        if (bytes > limits.maxLeafBytes) throw new PlistError("binary plist: utf16 string too large")
        if (next + bytes > buf.length) throw new PlistError("binary plist: utf16 out of bounds")
        return Buffer.from(buf.subarray(next, next + bytes)).swap16().toString("utf16le")
      }
      case 0x80: // UID — NSKeyedArchiver object reference, kept distinct from a plain int
        return new PlistUID(readUBE(buf, pos, lo + 1))
      case 0xa0:
      case 0xc0: {
        if (seen.has(index)) throw new PlistError("binary plist: cyclic reference")
        seen.add(index)
        const { count, next } = readCount(pos, lo)
        nodes += count
        if (nodes > limits.maxNodes) throw new PlistError("binary plist: too many nodes")
        const arr: PlistValue[] = []
        for (let i = 0; i < count; i++) arr.push(decodeObj(readUBE(buf, next + i * refSize, refSize), depth + 1))
        seen.delete(index)
        return arr
      }
      case 0xd0: {
        if (seen.has(index)) throw new PlistError("binary plist: cyclic reference")
        seen.add(index)
        const { count, next } = readCount(pos, lo)
        nodes += count * 2
        if (nodes > limits.maxNodes) throw new PlistError("binary plist: too many nodes")
        const keyBase = next
        const valBase = next + count * refSize
        const dict: PlistDict = {}
        for (let i = 0; i < count; i++) {
          const key = decodeObj(readUBE(buf, keyBase + i * refSize, refSize), depth + 1)
          const val = decodeObj(readUBE(buf, valBase + i * refSize, refSize), depth + 1)
          dict[String(key)] = val
        }
        seen.delete(index)
        return dict
      }
      default:
        throw new PlistError(`binary plist: unsupported object type 0x${hi.toString(16)}`)
    }
  }

  return decodeObj(topObject, 0)
}

// ── XML plist ─────────────────────────────────────────────────────────────────

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent: string) => {
    switch (ent) {
      case "amp": return "&"
      case "lt": return "<"
      case "gt": return ">"
      case "quot": return '"'
      case "apos": return "'"
      default:
        if (ent[0] === "#") {
          const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
          return Number.isFinite(code) ? String.fromCodePoint(code) : m
        }
        return m
    }
  })
}

export function decodeXmlPlist(text: string, limits: PlistLimits = DEFAULT_PLIST_LIMITS): PlistValue {
  const s = text
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  const len = s.length
  let i = 0
  let nodes = 0
  const fail = (m: string): never => { throw new PlistError(`xml plist: ${m}`) }

  const ws = () => { while (i < len && (s[i] === " " || s[i] === "\n" || s[i] === "\t" || s[i] === "\r")) i++ }
  const peekTag = (): { raw: string; end: number } | null => {
    ws()
    if (i >= len || s[i] !== "<") return null
    const gt = s.indexOf(">", i)
    if (gt < 0) fail("unterminated tag")
    return { raw: s.slice(i + 1, gt), end: gt + 1 }
  }
  const readOpen = (): { name: string; self: boolean } => {
    const t = peekTag()
    if (!t) fail("expected an element")
    i = t!.end
    const self = t!.raw.endsWith("/")
    const name = (self ? t!.raw.slice(0, -1) : t!.raw).trim().split(/\s+/)[0]
    if (name.startsWith("/")) fail(`unexpected close </${name.slice(1)}>`)
    return { name, self }
  }
  const readTextUntilClose = (name: string): string => {
    const close = `</${name}>`
    const idx = s.indexOf(close, i)
    if (idx < 0) fail(`unterminated <${name}>`)
    const txt = s.slice(i, idx)
    i = idx + close.length
    return txt
  }
  const bumpNodes = () => { if (++nodes > limits.maxNodes) fail("too many nodes") }

  const parseValue = (depth: number): PlistValue => {
    if (depth > limits.maxDepth) fail("too deeply nested")
    const open = readOpen()
    switch (open.name) {
      case "plist": {
        const v = parseValue(depth)
        const t = peekTag()
        if (t && t.raw.trim() === "/plist") i = t.end
        return v
      }
      case "dict": {
        if (open.self) return {}
        const d: PlistDict = {}
        for (;;) {
          const t = peekTag()
          if (!t) fail("unterminated <dict>")
          if (t!.raw.trim() === "/dict") { i = t!.end; break }
          const k = readOpen()
          if (k.name !== "key") fail("expected <key> in dict")
          const key = unescapeXml(readTextUntilClose("key"))
          d[key] = parseValue(depth + 1)
          bumpNodes()
        }
        return d
      }
      case "array": {
        if (open.self) return []
        const a: PlistValue[] = []
        for (;;) {
          const t = peekTag()
          if (!t) fail("unterminated <array>")
          if (t!.raw.trim() === "/array") { i = t!.end; break }
          a.push(parseValue(depth + 1))
          bumpNodes()
        }
        return a
      }
      case "true": if (!open.self) readTextUntilClose("true"); return true
      case "false": if (!open.self) readTextUntilClose("false"); return false
      case "string": {
        if (open.self) return ""
        const txt = readTextUntilClose("string")
        if (txt.length > limits.maxLeafBytes) fail("string leaf too large")
        return unescapeXml(txt)
      }
      case "integer": return open.self ? 0 : parseInt(readTextUntilClose("integer").trim(), 10)
      case "real": return open.self ? 0 : Number(readTextUntilClose("real").trim())
      case "data": {
        if (open.self) return Buffer.alloc(0)
        const b64 = readTextUntilClose("data").replace(/\s+/g, "")
        if (b64.length > limits.maxLeafBytes) fail("data leaf too large")
        return Buffer.from(b64, "base64")
      }
      case "date": return open.self ? "" : readTextUntilClose("date").trim()
      default: return fail(`unknown element <${open.name}>`)
    }
  }

  ws()
  if (i >= len) throw new PlistError("xml plist: empty document")
  return parseValue(0)
}

// ── XML plist encoder (WIR output frames may be XML) ──────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function encodeNode(v: PlistValue): string {
  if (v === null) return "<string></string>" // WIR never sends null; keep well-formed
  if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`
  if (Array.isArray(v)) return `<array>${v.map(encodeNode).join("")}</array>`
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>"
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (typeof v === "object") {
    const body = Object.entries(v)
      .map(([k, val]) => `<key>${escapeXml(k)}</key>${encodeNode(val)}`)
      .join("")
    return `<dict>${body}</dict>`
  }
  return `<string>${escapeXml(String(v))}</string>`
}

export function encodeXmlPlist(v: PlistValue): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">${encodeNode(v)}</plist>`
  )
}
