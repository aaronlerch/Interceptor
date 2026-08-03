/**
 * daemon/ios/keychain.ts — macOS Keychain store for the Apple-ID session token
 *.
 *
 * We NEVER persist the Apple-ID password and NEVER put the session/refresh token
 * in `state.json`. Interceptor authenticates directly to Apple (signer.ts) and
 * stashes only the resulting token here, in the login keychain, via the base-macOS
 * `/usr/bin/security` tool (ships with the OS, not Xcode).
 *
 * A generic-password item keyed by (service, account). One active account, so the
 * default account label is fine; callers may pass a specific account (e.g. the
 * Apple-ID email or team id) to keep multiple around.
 */

import { spawnSync } from "node:child_process"

const SECURITY = "/usr/bin/security"
const DEFAULT_SERVICE = "com.interceptor.ios.appleid"
const DEFAULT_ACCOUNT = "default"

export type KeychainRef = { service?: string; account?: string }

function svc(ref?: KeychainRef): string { return ref?.service ?? DEFAULT_SERVICE }
function acct(ref?: KeychainRef): string { return ref?.account ?? DEFAULT_ACCOUNT }

/**
 * Store (or replace) a secret. Uses `-U` so a second call updates in place rather
 * than erroring on a duplicate item.
 *
 * ponytail: the value is passed on argv (`-w`), briefly visible to `ps` on a
 * shared machine. Upgrade path if that matters: pipe via a `security`
 * interactive/`-X` flow. For a single-user dev Mac this is the lazy-correct floor.
 */
export function storeToken(token: string, ref?: KeychainRef): { ok: boolean; error?: string } {
  const r = spawnSync(SECURITY, [
    "add-generic-password", "-U",
    "-s", svc(ref), "-a", acct(ref),
    "-D", "Interceptor Apple-ID session token",
    "-w", token,
  ], { encoding: "utf-8" })
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "security add-generic-password failed").trim() }
  return { ok: true }
}

/** Load the secret, or undefined if there is none. */
export function loadToken(ref?: KeychainRef): string | undefined {
  const r = spawnSync(SECURITY, [
    "find-generic-password", "-s", svc(ref), "-a", acct(ref), "-w",
  ], { encoding: "utf-8" })
  if (r.status !== 0) return undefined
  const out = (r.stdout ?? "").replace(/\n$/, "")
  return out.length ? out : undefined
}

/** Remove the secret. Returns ok even if it was already absent. */
export function deleteToken(ref?: KeychainRef): { ok: boolean; error?: string } {
  const r = spawnSync(SECURITY, [
    "delete-generic-password", "-s", svc(ref), "-a", acct(ref),
  ], { encoding: "utf-8" })
  // status 44 = item not found — treat as already-clear, not an error.
  if (r.status !== 0 && r.status !== 44 && !/could not be found/i.test(r.stderr ?? "")) {
    return { ok: false, error: (r.stderr || r.stdout || "security delete-generic-password failed").trim() }
  }
  return { ok: true }
}

export function hasToken(ref?: KeychainRef): boolean {
  return loadToken(ref) !== undefined
}
