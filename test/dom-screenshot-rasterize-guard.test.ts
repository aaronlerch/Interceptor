/// <reference lib="dom" />

import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by an earlier test file */ }

import { checkRasterizeOutput } from "../extension/src/content/dom-screenshot"

// Oversized-render guard (PRD-123). A canvas past the browser's max
// dimension/area limits doesn't throw — toDataURL() silently returns "data:,"
// and the pipeline used to report success with size: 0 (reproduced live:
// 3016x600214 and 100016x400214 "captures" that were empty PNGs). The guard
// must turn that into an actionable error naming the remedy flags, and must
// never fire on a real capture payload.

// Smallest real-world payload: a 1x1 canvas PNG is ~100+ base64 chars.
const REAL_PAYLOAD = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("checkRasterizeOutput", () => {
  test("a real dataUrl passes through unchanged", () => {
    const url = `data:image/png;base64,${REAL_PAYLOAD}`
    expect(checkRasterizeOutput(url, 1280, 800)).toBe(url)
  })

  test("the oversized-canvas 'data:,' result throws, never returns", () => {
    expect(() => checkRasterizeOutput("data:,", 3016, 600214)).toThrow(/canvas size limit/)
  })

  test("the error names the remedy flags and the failed dimensions", () => {
    let msg = ""
    try { checkRasterizeOutput("data:,", 100016, 400214) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain("100016x400214")
    expect(msg).toContain("--region")
    expect(msg).toContain("--target-max-long-edge")
    expect(msg).toContain("--scale")
  })

  test("a near-empty payload (allocation failure) also throws", () => {
    expect(() => checkRasterizeOutput("data:image/png;base64,AAAA", 65536, 65536)).toThrow(/canvas size limit/)
  })

  test("the thrown Error survives describeRenderError intact (no 'undefined')", async () => {
    const { describeRenderError } = await import("../extension/src/content/dom-screenshot")
    let err: unknown
    try { checkRasterizeOutput("data:,", 3016, 600214) } catch (e) { err = e }
    const described = describeRenderError(err)
    expect(described).toContain("canvas size limit")
    expect(described).not.toContain("undefined")
  })
})
