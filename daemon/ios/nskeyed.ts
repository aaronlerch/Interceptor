/**
 * daemon/ios/nskeyed.ts — bounded NSKeyedArchiver → plain-JS decode.
 *
 * DTX / Instruments replies are NSKeyedArchiver binary plists: a `$objects`
 * array whose entries reference each other by UID (`$top.root` is the entry
 * point). We decode the plist with the existing bounded `decodePlist` (which now
 * surfaces UIDs as `PlistUID`, distinct from plain integers), then resolve the
 * object graph into ordinary JS values.
 *
 * Bounds: node count + recursion depth are capped; UID resolution is memoized so
 * a cyclic graph terminates. Pure (Buffer in, JS out) — unit-testable device-free.
 *
 * Reuse: builds on daemon/ios/webinspector-plist.ts. The archive side already
 * lives in usertunnel.ts (`nskeyedArchive`); this is the inverse.
 */

import { decodePlist, PlistUID, DEFAULT_PLIST_LIMITS, type PlistValue, type PlistLimits, type PlistDict } from "./webinspector-plist"

const MAX_DEPTH = 96
const MAX_NODES = 200_000

const isDict = (v: unknown): v is PlistDict =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof PlistUID)

/** A CF$UID can arrive as a `PlistUID` (binary) or a `{ "CF$UID": n }` dict (XML). */
function asUid(v: PlistValue): number | undefined {
  if (v instanceof PlistUID) return v.uid
  if (isDict(v) && typeof v["CF$UID"] === "number") return v["CF$UID"] as number
  return undefined
}

type State = { objects: PlistValue[]; nodes: number; memo: Map<number, unknown> }

/** Decode an NSKeyedArchiver plist buffer to plain JS. */
export function nskeyedUnarchive(buf: Buffer, limits: PlistLimits = DEFAULT_PLIST_LIMITS): unknown {
  const root = decodePlist(buf, limits)
  if (!isDict(root)) throw new Error("nskeyed: top-level is not a dict")
  const objects = root["$objects"]
  if (!Array.isArray(objects)) throw new Error("nskeyed: missing $objects array")
  const top = root["$top"]
  let rootRef: number | undefined
  if (isDict(top)) {
    const r = top["root"] !== undefined ? top["root"] : Object.values(top)[0]
    rootRef = r !== undefined ? asUid(r as PlistValue) : undefined
  }
  const state: State = { objects, nodes: 0, memo: new Map() }
  if (rootRef === undefined) return resolveValue(top as PlistValue, state, 0)
  return resolveIndex(rootRef, state, 0)
}

function bump(state: State): void {
  if (++state.nodes > MAX_NODES) throw new Error("nskeyed: node budget exceeded")
}

function resolveValue(v: PlistValue, state: State, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("nskeyed: max depth exceeded")
  const uid = asUid(v)
  if (uid !== undefined) return resolveIndex(uid, state, depth)
  if (Array.isArray(v)) { bump(state); return v.map((e) => resolveValue(e, state, depth + 1)) }
  if (Buffer.isBuffer(v)) return v
  if (isDict(v)) return resolveDict(v, state, depth)
  return v // string | number | boolean | null
}

function resolveIndex(uid: number, state: State, depth: number): unknown {
  if (uid === 0) return null // $null
  if (state.memo.has(uid)) return state.memo.get(uid)
  if (uid < 0 || uid >= state.objects.length) throw new Error(`nskeyed: UID ${uid} out of range`)
  const obj = state.objects[uid]
  // Placeholder guards against cycles before we finish building the value.
  state.memo.set(uid, undefined)
  const out = resolveValue(obj, state, depth + 1)
  state.memo.set(uid, out)
  return out
}

function className(dict: PlistDict, state: State): string | undefined {
  const clsRef = dict["$class"]
  if (clsRef === undefined) return undefined
  const clsUid = asUid(clsRef as PlistValue)
  const cls = clsUid !== undefined ? state.objects[clsUid] : clsRef
  if (isDict(cls)) {
    if (typeof cls["$classname"] === "string") return cls["$classname"] as string
    const classes = cls["$classes"]
    if (Array.isArray(classes) && typeof classes[0] === "string") return classes[0] as string
  }
  return undefined
}

function resolveDict(dict: PlistDict, state: State, depth: number): unknown {
  bump(state)
  const cls = className(dict, state)
  const arr = (key: string): unknown[] => {
    const a = dict[key]
    return Array.isArray(a) ? a.map((e) => resolveValue(e, state, depth + 1)) : []
  }
  switch (cls) {
    case "NSNull": return null
    case "NSString": case "NSMutableString":
      return typeof dict["NS.string"] === "string" ? dict["NS.string"] : ""
    case "NSData": case "NSMutableData":
      return Buffer.isBuffer(dict["NS.data"]) ? dict["NS.data"] : Buffer.alloc(0)
    case "NSDate":
      return typeof dict["NS.time"] === "number" ? dict["NS.time"] : dict["NS.time"]
    case "NSUUID":
      return Buffer.isBuffer(dict["NS.uuidbytes"]) ? dict["NS.uuidbytes"] : dict["NS.uuidbytes"]
    case "NSArray": case "NSMutableArray": case "NSSet": case "NSMutableSet": case "NSOrderedSet":
      return arr("NS.objects")
    case "NSDictionary": case "NSMutableDictionary": {
      const keys = arr("NS.keys")
      const vals = arr("NS.objects")
      const out: Record<string, unknown> = {}
      for (let i = 0; i < keys.length; i++) out[String(keys[i])] = vals[i]
      return out
    }
    case "NSURL":
      return dict["NS.relative"] !== undefined ? resolveValue(dict["NS.relative"], state, depth + 1) : null
    default: {
      // Unknown/custom class (or a plain nested dict): resolve every field except archiver bookkeeping.
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(dict)) {
        if (k === "$class") continue
        out[k] = resolveValue(v, state, depth + 1)
      }
      return out
    }
  }
}
