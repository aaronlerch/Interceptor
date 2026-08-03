import { describe, expect, test } from "bun:test"
import {
  clearContextConflictBadge,
  registrationControlType,
  setContextConflictBadge,
  updateContextBadge,
  type ActionBadgeApi,
} from "../extension/src/background/context-registration"

function badgeApi(calls: unknown[]): ActionBadgeApi {
  return {
    setBadgeText: (details) => calls.push(["text", details]),
    setBadgeBackgroundColor: (details) => calls.push(["color", details]),
  }
}

describe("extension context registration controls", () => {
  test("classifies registration control messages", () => {
    expect(registrationControlType({ type: "context_registered", contextId: "work" })).toBe("context_registered")
    expect(registrationControlType({ type: "context_conflict", contextId: "work" })).toBe("context_conflict")
    expect(registrationControlType({ type: "event" })).toBeNull()
    expect(registrationControlType(null)).toBeNull()
  })

  test("sets conflict badge through chrome.action", () => {
    const calls: unknown[] = []

    expect(setContextConflictBadge({ action: badgeApi(calls) })).toBe(true)

    expect(calls).toEqual([
      ["text", { text: "!" }],
      ["color", { color: "#e53e3e" }],
    ])
  })

  test("clears conflict badge after successful registration", () => {
    const calls: unknown[] = []

    expect(clearContextConflictBadge({ action: badgeApi(calls) })).toBe(true)

    expect(calls).toEqual([
      ["text", { text: "" }],
    ])
  })

  test("falls back to browserAction for MV2 bundle", () => {
    const calls: unknown[] = []

    expect(updateContextBadge({ browserAction: badgeApi(calls) }, { text: "!", color: "#e53e3e" })).toBe(true)

    expect(calls).toEqual([
      ["text", { text: "!" }],
      ["color", { color: "#e53e3e" }],
    ])
  })

  test("returns false when no action badge API exists", () => {
    expect(clearContextConflictBadge({})).toBe(false)
  })
})
