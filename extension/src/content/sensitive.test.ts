/// <reference lib="dom" />

import { describe, expect, test, afterEach } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered by another test file */ }

import { isValueSecret, isSensitive, markSensitive, SECURE_MASK } from "./sensitive"
import { handleForms } from "./data/forms"

afterEach(() => { document.body.innerHTML = "" })

describe("isValueSecret — value read masking", () => {
  test("a password input is secret; a text input is not", () => {
    const pw = document.createElement("input"); pw.type = "password"
    const text = document.createElement("input"); text.type = "text"
    expect(isValueSecret(pw)).toBe(true)
    expect(isValueSecret(text)).toBe(false)
  })

  test("an explicitly marked field is secret regardless of type (vault delivery target)", () => {
    const el = document.createElement("input"); el.type = "text"
    expect(isValueSecret(el)).toBe(false)
    markSensitive(el)
    expect(isSensitive(el)).toBe(true)
    expect(isValueSecret(el)).toBe(true)
  })

  test("forms never report a password field's value in plaintext", async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="user" value="alice">
        <input type="password" name="pass" value="SENT1NEL-should-not-appear">
      </form>`
    const res = await handleForms({ type: "forms" })
    const json = JSON.stringify(res.data)
    expect(json).not.toContain("SENT1NEL-should-not-appear")
    expect(json).toContain(SECURE_MASK)
    // non-secret fields still readable
    expect(json).toContain("alice")
  })
})
