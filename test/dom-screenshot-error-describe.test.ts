/// <reference lib="dom" />

import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by an earlier test file */ }

import { describeRenderError } from "../extension/src/content/dom-screenshot"

// html-to-image rejects createImage with a raw DOM `error` Event (img.onerror
// = reject) when the serialized+embedded SVG fails to decode on a heavy page.
// A DOM Event has no `.message`, so the old `(err as Error).message` reported
// the literal "undefined". describeRenderError must coerce every shape into a
// meaningful, non-"undefined" string so the failure is actionable and the SW
// can recognise it to fall back to --pixel.

describe("describeRenderError", () => {
  test("Error with a message passes the message through", () => {
    expect(describeRenderError(new Error("canvas tainted"))).toBe("canvas tainted")
  })

  test("a DOM error Event yields an actionable string, never 'undefined'", () => {
    const ev = new Event("error")
    const out = describeRenderError(ev)
    expect(out).not.toBe("undefined")
    expect(out).not.toContain("[object")
    expect(out.toLowerCase()).toContain("image load failed")
  })

  test("an <img> onerror Event names the element", () => {
    const img = document.createElement("img")
    const ev = new Event("error")
    Object.defineProperty(ev, "target", { value: img })
    expect(describeRenderError(ev).toLowerCase()).toContain("<img>")
  })

  test("a bare string error is returned as-is", () => {
    expect(describeRenderError("boom")).toBe("boom")
  })

  test("an opaque non-Error never leaks 'undefined' or '[object Object]'", () => {
    expect(describeRenderError({})).toBe("unknown render error (non-Error thrown)")
    expect(describeRenderError(undefined)).toBe("unknown render error (non-Error thrown)")
  })

  test("a thrown literal 'undefined'/'null' string is sanitized, not leaked", () => {
    // Guard order regression: the string branch used to return before the
    // sanitize check, leaking the exact value this function exists to remove.
    expect(describeRenderError("undefined")).toBe("unknown render error (non-Error thrown)")
    expect(describeRenderError("null")).toBe("unknown render error (non-Error thrown)")
    expect(describeRenderError("")).toBe("unknown render error (non-Error thrown)")
  })

  test("bare primitives never leak 'null'/'0'", () => {
    expect(describeRenderError(null)).toBe("unknown render error (non-Error thrown)")
  })

  test("a meaningful thrown string is still returned as-is", () => {
    expect(describeRenderError("canvas is 0x0")).toBe("canvas is 0x0")
  })
})
