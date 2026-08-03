/// <reference lib="dom" />

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

beforeAll(() => {
  ;(globalThis as any).chrome = { runtime: { onMessage: { addListener() {} } } }
})

import { findFileInput, base64ToBytes, handleFileUpload, handleFileUploadChunk } from "./file"
import { getOrAssignRef } from "../ref-registry"
import { chunkBase64, inferMime } from "../../../../shared/upload"

describe("findFileInput", () => {
  test("returns the element itself when it is a file input", () => {
    const input = document.createElement("input")
    input.type = "file"
    expect(findFileInput(input)).toBe(input)
  })

  test("returns a nested file input when the target wraps one (label/dropzone)", () => {
    const wrapper = document.createElement("div")
    const input = document.createElement("input")
    input.type = "file"
    wrapper.appendChild(input)
    expect(findFileInput(wrapper)).toBe(input)
  })

  test("returns null for a non-file input", () => {
    const input = document.createElement("input")
    input.type = "text"
    expect(findFileInput(input)).toBeNull()
  })

  test("returns null for a plain dropzone with no input", () => {
    const dz = document.createElement("div")
    expect(findFileInput(dz)).toBeNull()
  })
})

describe("base64ToBytes", () => {
  test("decodes what the CLI's Buffer base64 encodes", () => {
    const original = new Uint8Array([0, 1, 2, 254, 255, 104, 105, 128])
    const b64 = Buffer.from(original).toString("base64")
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(original))
  })
})

describe("findFileInput — widened resolution", () => {
  afterEach(() => { document.body.innerHTML = "" })

  test("finds a file input up through an ancestor when a child ref was named", () => {
    const root = document.createElement("div")
    const inner = document.createElement("span")   // the 'Click to upload' text node
    const input = document.createElement("input")
    input.type = "file"
    root.appendChild(input)
    root.appendChild(inner)
    document.body.appendChild(root)
    // naming the inner span still resolves the sibling input via the shared ancestor
    expect(findFileInput(inner)).toBe(input)
  })

  test("falls back to the page's sole file input when the ref subtree has none", () => {
    const input = document.createElement("input")
    input.type = "file"
    document.body.appendChild(input)
    const unrelated = document.createElement("div")   // detached, no input inside/above
    expect(findFileInput(unrelated)).toBe(input)
  })

  test("does NOT guess when the page has multiple file inputs", () => {
    const a = document.createElement("input"); a.type = "file"
    const b = document.createElement("input"); b.type = "file"
    document.body.appendChild(a); document.body.appendChild(b)
    const unrelated = document.createElement("div")
    expect(findFileInput(unrelated)).toBeNull()
  })
})

describe("inferMime — extended map", () => {
  test("maps the audio/video types real upload areas gate on", () => {
    expect(inferMime("me.mp3")).toBe("audio/mpeg")
    expect(inferMime("me.m4a")).toBe("audio/mp4")
    expect(inferMime("me.flac")).toBe("audio/flac")
    expect(inferMime("me.ogg")).toBe("audio/ogg")
    expect(inferMime("me.aac")).toBe("audio/aac")
    expect(inferMime("clip.mkv")).toBe("video/x-matroska")
  })
  test("unknown extension falls to octet-stream", () => {
    expect(inferMime("mystery.zzz")).toBe("application/octet-stream")
  })
})

describe("chunked upload roundtrip", () => {
  afterEach(() => { document.body.innerHTML = "" })

  test("chunkBase64 split rejoins losslessly", () => {
    const original = "A".repeat(1000) + "B".repeat(1000) + "C".repeat(37)
    const parts = chunkBase64(original, 512)
    expect(parts.length).toBe(Math.ceil(original.length / 512))
    expect(parts.join("")).toBe(original)
  })

  test("chunks reassemble and attach to a file input", async () => {
    const input = document.createElement("input")
    input.type = "file"
    document.body.appendChild(input)
    const ref = getOrAssignRef(input)

    const bytes = new Uint8Array(Array.from({ length: 40 }, (_, i) => i % 256))
    const b64 = Buffer.from(bytes).toString("base64")
    const chunks = chunkBase64(b64, 4)   // tiny chunk size → forces many chunks
    const uploadId = "test-upload-roundtrip"
    chunks.forEach((chunk, seq) => {
      const r = handleFileUploadChunk({ type: "file_upload_chunk", uploadId, seq, total: chunks.length, chunk } as never)
      expect(r.success).toBe(true)
    })
    const result = await handleFileUpload({ type: "file_upload", uploadId, ref, fileName: "t.bin", mimeType: "application/octet-stream" } as never)
    expect(result.success).toBe(true)
    expect((result.data as { method: string }).method).toBe("input")
    expect(input.files?.length).toBe(1)
    expect(input.files?.[0]?.name).toBe("t.bin")
    expect(input.files?.[0]?.size).toBe(40)
  })

  test("assemble fails clearly when a chunk is missing", async () => {
    const uploadId = "test-upload-missing"
    handleFileUploadChunk({ type: "file_upload_chunk", uploadId, seq: 0, total: 3, chunk: "AA" } as never)
    // seq 1 and 2 never arrive
    const result = await handleFileUpload({ type: "file_upload", uploadId, ref: "nope", fileName: "x", mimeType: "" } as never)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain("missing chunks")
  })

  test("handleFileUploadChunk rejects an out-of-range seq", () => {
    const r = handleFileUploadChunk({ type: "file_upload_chunk", uploadId: "oor", seq: 9, total: 2, chunk: "aa" } as never)
    expect(r.success).toBe(false)
  })
})
