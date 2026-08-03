import { describe, expect, test } from "bun:test"
import { inferMime, baseName } from "./upload"

describe("inferMime", () => {
  test("known extensions map to the right MIME", () => {
    expect(inferMime("resume.pdf")).toBe("application/pdf")
    expect(inferMime("receipt.PNG")).toBe("image/png")
    expect(inferMime("photo.jpeg")).toBe("image/jpeg")
    expect(inferMime("photo.jpg")).toBe("image/jpeg")
    expect(inferMime("id.heic")).toBe("image/heic")
    expect(inferMime("data.csv")).toBe("text/csv")
    expect(inferMime("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    expect(inferMime("clip.webm")).toBe("video/webm")
  })

  test("unknown / missing extension falls back to octet-stream", () => {
    expect(inferMime("mystery.zzz")).toBe("application/octet-stream")
    expect(inferMime("noextension")).toBe("application/octet-stream")
    expect(inferMime("trailingdot.")).toBe("application/octet-stream")
  })
})

describe("baseName", () => {
  test("handles / and \\ separators", () => {
    expect(baseName("/Users/alice/Downloads/resume.pdf")).toBe("resume.pdf")
    expect(baseName("resume.pdf")).toBe("resume.pdf")
    expect(baseName("C:\\Users\\alice\\resume.pdf")).toBe("resume.pdf")
    expect(baseName("/trailing/slash/")).toBe("file")
  })
})

describe("base64 CLI↔content contract", () => {
  // The CLI encodes with Buffer.toString("base64"); the content handler decodes
  // with atob. This asserts they round-trip byte-for-byte, including bytes that
  // are not valid UTF-8.
  test("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 2, 254, 255, 104, 105, 0, 128, 200])
    const b64 = Buffer.from(original).toString("base64")
    const binary = atob(b64)
    const decoded = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i)
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })
})
