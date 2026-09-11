import { describe, expect, test } from "bun:test"
import manifest from "../extension/manifest.json"
import identitiesJson from "../extension/store-identities.json"
import {
  deriveChromiumExtensionId,
  edgeDeclared,
  makeNativeHostManifest,
  parseStoreIdentities,
  validateStoreIdentities,
} from "../scripts/installer/generate-native-host"

describe("Windows store identity source", () => {
  const identities = parseStoreIdentities(identitiesJson)

  // FORK-DELTA: the fork keeps its own unpacked extension identity and does NOT
  // adopt upstream's published Chrome Web Store id (see MERGE-PLAN-v0.25.0 §D3).
  // store-identities.json is intentionally unpublished ("pending"), so the fork
  // derives its own id and never passes the production store gate. The approval
  // gate logic is still exercised below against an explicit approved clone.
  const FORK_ID = "hkjbaciefhhgekldhncknbjkofbpenng"
  const approvedClone = () => {
    const c = structuredClone(identities)
    c.chrome.approvalStatus = "approved"
    c.chrome.approvalDate = "2026-01-01"
    c.chrome.listingUrl = `https://chromewebstore.google.com/detail/interceptor/${FORK_ID}`
    return c
  }

  test("derives the fork's own extension ID from the key pinned in the manifest", () => {
    expect(deriveChromiumExtensionId(identities.chrome.publicKey)).toBe(FORK_ID)
    expect(identities.chrome.publicKey).toBe(manifest.key)
    expect(identities.chrome.approvalStatus).toBe("pending")
    expect(identities.chrome.listingUrl).toBe("")
  })

  test("non-production validation passes; the unpublished identity fails the production store gate", () => {
    expect(() => validateStoreIdentities(identities, { production: false, extensionManifestKey: manifest.key })).not.toThrow()
    expect(() => validateStoreIdentities(identities, { production: true, extensionManifestKey: manifest.key })).toThrow("not approved")
    expect(edgeDeclared(identities.edge)).toBe(false)
    // the production gate logic still works when a record IS approved:
    expect(() => validateStoreIdentities(approvedClone(), { production: true, extensionManifestKey: manifest.key })).not.toThrow()
  })

  test("the dev native-host manifest carries the fork identity only and a relative daemon path", () => {
    const nativeHost = makeNativeHostManifest(identities, false)
    expect(nativeHost.path).toBe("interceptor-daemon.exe")
    expect(nativeHost.allowed_origins).toEqual([`chrome-extension://${FORK_ID}/`])
    // production requires store approval, which the fork does not have.
    expect(() => makeNativeHostManifest(identities, true)).toThrow("not approved")
  })

  test("a half-filled Edge record blocks production until it is approved", () => {
    const pending = approvedClone() // chrome approved so the gate reaches edge
    pending.edge.storeId = "b".repeat(32)
    expect(edgeDeclared(pending.edge)).toBe(true)
    expect(() => validateStoreIdentities(pending, { production: true })).toThrow("edge store identity is not approved")
    expect(makeNativeHostManifest(pending, false).allowed_origins).toEqual([
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      `chrome-extension://${FORK_ID}/`,
    ])
  })

  test("rejects unknown fields and mismatched IDs", () => {
    expect(() => parseStoreIdentities({ ...identitiesJson, surprise: true })).toThrow("keys must be exactly")
    const changed = structuredClone(identities)
    changed.chrome.storeId = "a".repeat(32)
    expect(() => validateStoreIdentities(changed, { production: false })).toThrow("does not match")
  })
})
