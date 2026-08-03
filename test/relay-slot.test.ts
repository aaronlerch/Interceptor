import { describe, expect, test } from "bun:test"
import { isRelayPing, relaySlotAfterClose } from "../daemon/outbound-routing"

// Regression: the keepalive pong-timeout reconnect loop (extension error
// "keepalive pong timeout (15s) — forcing reconnect") was self-sustained by
// the singleton clearing its relay slot whenever ANY relay-flagged socket
// closed. A superseded old relay's death unregistered the live relay, so the
// next pong fell to the ws queue, the extension timed out, reconnected, and
// the cycle repeated forever.
describe("relaySlotAfterClose", () => {
  const relayA = { id: "A" }
  const relayB = { id: "B" }

  test("current relay closing releases the slot", () => {
    const result = relaySlotAfterClose<{ id: string }>(relayA, relayA)
    expect(result.slot).toBeNull()
    expect(result.released).toBe(true)
  })

  test("stale relay closing does NOT clobber the current relay", () => {
    // A registers, B supersedes A, then A's lingering process exits.
    const afterStaleClose = relaySlotAfterClose<{ id: string }>(relayB, relayA)
    expect(afterStaleClose.slot).toBe(relayB)
    expect(afterStaleClose.released).toBe(false)
  })

  test("close with empty slot stays empty", () => {
    const result = relaySlotAfterClose<{ id: string }>(null, relayA)
    expect(result.slot).toBeNull()
    expect(result.released).toBe(false)
  })

  test("full supersede sequence keeps the live relay registered", () => {
    // register A → A is current
    let slot: { id: string } | null = relayA
    // B registers (extension reconnected while A lingers) → B is current
    slot = relayB
    // A's process finally notices stdin EOF and its socket closes
    slot = relaySlotAfterClose(slot, relayA).slot
    expect(slot).toBe(relayB)
    // B closing afterwards releases normally
    slot = relaySlotAfterClose(slot, relayB).slot
    expect(slot).toBeNull()
  })
})

describe("isRelayPing", () => {
  test("detects keepalive pings from a relay", () => {
    expect(isRelayPing({ type: "ping" })).toBe(true)
  })

  test("rejects non-ping traffic", () => {
    expect(isRelayPing({ type: "pong" })).toBe(false)
    expect(isRelayPing({ type: "native-relay" })).toBe(false)
    expect(isRelayPing({ id: "abc", result: {} })).toBe(false)
    expect(isRelayPing(null)).toBe(false)
  })
})
