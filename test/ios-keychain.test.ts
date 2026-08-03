import { describe, expect, test } from "bun:test"
import { storeToken, loadToken, deleteToken, hasToken } from "../daemon/ios/keychain"

// Roundtrips the Apple-ID token through the REAL login keychain under a throwaway
// service name, then deletes it. Verifies the trust boundary: the token
// lives in the Keychain (via /usr/bin/security), never in state.json.

describe("keychain token store", () => {
  // Unique per-run-ish service so a crashed prior run can't collide. No Date.now
  // in the value — just a fixed test service we always clean up.
  const ref = { service: "com.interceptor.ios.appleid.test", account: "roundtrip" }

  test("store → load → delete roundtrip", () => {
    // Clean any leftover first so the assertion is deterministic.
    deleteToken(ref)
    expect(hasToken(ref)).toBe(false)

    const token = "sess_token.ABC123-with/slashes+and=equals and spaces"
    const stored = storeToken(token, ref)
    expect(stored.ok).toBe(true)

    expect(loadToken(ref)).toBe(token)
    expect(hasToken(ref)).toBe(true)

    // -U replaces in place.
    expect(storeToken("second-value", ref).ok).toBe(true)
    expect(loadToken(ref)).toBe("second-value")

    expect(deleteToken(ref).ok).toBe(true)
    expect(loadToken(ref)).toBeUndefined()
  })

  test("delete of an absent item is not an error", () => {
    expect(deleteToken({ service: "com.interceptor.ios.appleid.test", account: "never-existed" }).ok).toBe(true)
  })
})
