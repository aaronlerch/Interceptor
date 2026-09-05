/**
 * daemon/op.ts — 1Password-backed secret resolution (FORK-DELTA §7).
 *
 * Replaces upstream's hand-rolled vault (issue #244). Upstream built four
 * things 1Password already provides: a keychain store, a biometric gate,
 * unlock windows, and a per-secret target allowlist. Three of those needed the
 * bridge (LAContext lives in AuthDomain), which a browser-only install does not
 * have — so on this fork they were either dead or, in the `gate: "none"` case,
 * simply absent. `op` provides all four and needs no bridge at all.
 *
 * What this module owns: parsing a secret reference, finding the binary,
 * reading an item's metadata for the target check, and reading one field. It
 * holds no state and writes no files, so every rule here is unit-testable.
 *
 * What it deliberately does NOT own: storage, registration, unlock windows, and
 * the gate. Those are 1Password's — `op item create`, the desktop app's Touch
 * ID and auto-lock. There is no `interceptor macos secret register|set|unlock`
 * any more, because there is nothing left for them to do.
 *
 * Two verified environment facts drive the design (probed 2026-09-05):
 *
 *  1. The daemon's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew is NOT on
 *     it. `op` is therefore resolved from an absolute-path candidate list and
 *     never by bare name. A PATH lookup here fails only at delivery time, which
 *     is the worst moment to discover it.
 *  2. `op` authenticates against the desktop app on the user's session, not on
 *     inherited environment. Probed with a disowned `env -i` child holding only
 *     HOME/PATH/USER: it returned vault JSON with no prompt. So resolution can
 *     and should stay in the daemon, where `deliverWithSecret()` already keeps
 *     the value inside one process.
 */

import { existsSync } from "node:fs"

export class OpError extends Error {
  constructor(
    public code:
      | "invalid_ref"
      | "op_missing"
      | "account_ambiguous"
      | "target_denied"
      | "not_found"
      | "op_failed",
    message: string,
  ) {
    super(message)
  }
}

// ── the binary ───────────────────────────────────────────────────────────────

/**
 * Absolute candidates only. `INTERCEPTOR_OP_BIN` wins if it is set AND absolute
 * AND exists — a relative override would resolve against the daemon's cwd,
 * which is not a location the operator chose.
 */
export const OP_BIN_CANDIDATES = [
  "/opt/homebrew/bin/op",
  "/usr/local/bin/op",
  "/usr/bin/op",
]

export function resolveOpBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const override = env.INTERCEPTOR_OP_BIN
  if (override) {
    if (!override.startsWith("/")) {
      throw new OpError("op_missing", `INTERCEPTOR_OP_BIN must be an absolute path, got '${override}'`)
    }
    if (!exists(override)) {
      throw new OpError("op_missing", `INTERCEPTOR_OP_BIN points at a file that does not exist: ${override}`)
    }
    return override
  }
  for (const c of OP_BIN_CANDIDATES) if (exists(c)) return c
  throw new OpError(
    "op_missing",
    "the 1Password CLI (op) was not found. Install it (brew install 1password-cli) or set INTERCEPTOR_OP_BIN to its absolute path. " +
      "Note the daemon's PATH does not include /opt/homebrew/bin, so a PATH install alone is not enough.",
  )
}

// ── the reference ────────────────────────────────────────────────────────────

export type SecretRef = { vault: string; item: string; field: string; raw: string }

/**
 * `op://<vault>/<item>/<field>`. Vault and item may each be a name or a UUID,
 * which is what covers "by ID or by vault+item name" with one syntax rather
 * than two flags.
 *
 * Section-qualified references (`op://vault/item/section/field`) are rejected
 * rather than silently mishandled — add support deliberately if a real item
 * needs it.
 */
export function parseSecretRef(raw: unknown): SecretRef {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new OpError("invalid_ref", "--secret requires a 1Password reference: op://<vault>/<item>/<field>")
  }
  if (!raw.startsWith("op://")) {
    throw new OpError(
      "invalid_ref",
      `--secret takes a 1Password reference, not a bare name: got '${raw}'. Use op://<vault>/<item>/<field> ` +
        "(vault and item may each be a name or a UUID). Copy one from 1Password with 'Copy Secret Reference'.",
    )
  }
  const parts = raw.slice("op://".length).split("/")
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new OpError(
      "invalid_ref",
      `malformed 1Password reference '${raw}': expected exactly op://<vault>/<item>/<field>` +
        (parts.length > 3 ? " (section-qualified references are not supported)" : ""),
    )
  }
  return { vault: parts[0], item: parts[1], field: parts[2], raw }
}

// ── the account ──────────────────────────────────────────────────────────────

/**
 * `op read` with several accounts signed in and no `--account` silently
 * resolves against one of them (verified: a bogus reference got past auth and
 * failed on vault lookup, not on ambiguity). Releasing a credential against a
 * guessed account is not acceptable, so ambiguity is refused here instead.
 */
export function resolveAccount(
  explicit: string | undefined,
  signedIn: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit) return explicit
  const fromEnv = env.INTERCEPTOR_OP_ACCOUNT
  if (fromEnv) return fromEnv
  if (signedIn.length <= 1) return undefined
  throw new OpError(
    "account_ambiguous",
    `${signedIn.length} 1Password accounts are signed in (${signedIn.join(", ")}); ` +
      "op would pick one silently. Pass --op-account <shorthand> or set INTERCEPTOR_OP_ACCOUNT.",
  )
}

// ── the target check ─────────────────────────────────────────────────────────

export type OpTarget =
  | { kind: "browser"; host: string }
  | { kind: "macos"; bundleId: string }

export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p === h) return true
  return h.endsWith("." + p)
}

/** The host of an item URL, or "" when it is not parseable. */
export function urlHost(u: string): string {
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).hostname
  } catch {
    return ""
  }
}

/**
 * The item's own `urls` are the allowlist. The item already records which site
 * it belongs to; upstream kept a second copy of that in
 * `~/.interceptor/secrets.json`, which could drift from the item it described.
 *
 * Fail closed on an item with no URLs: refusing is recoverable (add the URL, or
 * pass --op-any-target), releasing against an unknown destination is not.
 */
export function targetAllowedByItem(
  urls: string[],
  target: OpTarget,
  opts: { anyTarget?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  if (opts.anyTarget) return { ok: true }
  if (target.kind === "macos") {
    return {
      ok: false,
      reason:
        "a 1Password item's URLs cannot describe a native app, so `macos type --secret` needs --op-any-target " +
        `to deliver into ${target.bundleId}`,
    }
  }
  if (urls.length === 0) {
    return {
      ok: false,
      reason:
        "the 1Password item has no website URL, so the delivery target cannot be checked. " +
        "Add the site to the item, or pass --op-any-target to deliver anyway.",
    }
  }
  const hosts = urls.map(urlHost).filter((h) => h.length > 0)
  if (hosts.some((h) => hostMatches(h, target.host))) return { ok: true }
  return {
    ok: false,
    reason: `the page host '${target.host}' is not among the item's URLs (${hosts.join(", ") || "none parseable"})`,
  }
}

// ── running op ───────────────────────────────────────────────────────────────

export type RunOp = (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>

/**
 * Argument array, never an interpolated string: the reference reaches us from a
 * CLI caller and must never be able to become shell syntax.
 */
export const spawnOp: RunOp = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { ok: exitCode === 0, stdout, stderr }
}

function accountArgs(account?: string): string[] {
  return account ? ["--account", account] : []
}

export async function signedInAccounts(bin: string, run: RunOp = spawnOp): Promise<string[]> {
  const r = await run([bin, "account", "list", "--format", "json"])
  if (!r.ok) return []
  try {
    const rows = JSON.parse(r.stdout) as Array<{ url?: string; user_uuid?: string }>
    return rows.map((a) => a.url || a.user_uuid || "").filter((s) => s.length > 0)
  } catch {
    return []
  }
}

/** Item metadata only — this never reads a field value. */
export async function itemUrls(
  bin: string,
  ref: SecretRef,
  account: string | undefined,
  run: RunOp = spawnOp,
): Promise<string[]> {
  const r = await run([
    bin, "item", "get", ref.item,
    "--vault", ref.vault,
    ...accountArgs(account),
    "--format", "json",
  ])
  if (!r.ok) {
    throw new OpError("not_found", `1Password could not read item '${ref.item}' in vault '${ref.vault}': ${r.stderr.trim() || "unknown error"}`)
  }
  try {
    const item = JSON.parse(r.stdout) as { urls?: Array<{ href?: string }> }
    return (item.urls ?? []).map((u) => u.href || "").filter((h) => h.length > 0)
  } catch {
    throw new OpError("op_failed", `could not parse the 1Password item metadata for '${ref.item}'`)
  }
}

/** Reads one field. The return value is a secret: never log it, never event it. */
export async function readSecret(
  bin: string,
  ref: SecretRef,
  account: string | undefined,
  run: RunOp = spawnOp,
): Promise<string> {
  const r = await run([bin, "read", ref.raw, ...accountArgs(account)])
  if (!r.ok) {
    throw new OpError("op_failed", `1Password could not read ${ref.raw}: ${r.stderr.trim() || "unknown error"}`)
  }
  const value = r.stdout.replace(/\n$/, "")
  if (value.length === 0) throw new OpError("not_found", `${ref.raw} resolved to an empty value`)
  return value
}

// ── the release ──────────────────────────────────────────────────────────────

export type ResolveOpOptions = {
  account?: string
  anyTarget?: boolean
  bin?: string
  run?: RunOp
  env?: NodeJS.ProcessEnv
}

/**
 * Order matters and mirrors upstream's: check the target BEFORE reading the
 * value, so a wrong destination never causes a read (and never causes a
 * biometric prompt the operator might approve out of habit).
 */
export async function resolveOpSecret(
  rawRef: unknown,
  target: OpTarget,
  opts: ResolveOpOptions = {},
): Promise<{ value: string; ref: SecretRef }> {
  const run = opts.run ?? spawnOp
  const env = opts.env ?? process.env
  const ref = parseSecretRef(rawRef)
  const bin = opts.bin ?? resolveOpBinary(env)
  const account = resolveAccount(opts.account, await signedInAccounts(bin, run), env)

  const urls = await itemUrls(bin, ref, account, run)
  const allowed = targetAllowedByItem(urls, target, { anyTarget: opts.anyTarget })
  if (!allowed.ok) throw new OpError("target_denied", `${ref.raw} refused: ${allowed.reason}`)

  const value = await readSecret(bin, ref, account, run)
  return { value, ref }
}
