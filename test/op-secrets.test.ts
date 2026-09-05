/**
 * FORK-DELTA §7: 1Password replaces upstream's hand-rolled vault (issue #244).
 *
 * These cover the rules that are ours rather than `op`'s: reference parsing,
 * binary resolution, account disambiguation, and the item-URL target check.
 * `op` itself is stubbed — the point is our ordering and our refusals, not
 * 1Password's behavior.
 */
import { describe, expect, test } from "bun:test"
import {
  OpError,
  OP_BIN_CANDIDATES,
  hostMatches,
  itemUrls,
  parseSecretRef,
  readSecret,
  resolveAccount,
  resolveOpBinary,
  resolveOpSecret,
  signedInAccounts,
  targetAllowedByItem,
  urlHost,
  type RunOp,
} from "../daemon/op"

/** A stub `op` that records every argv it was handed. */
function fakeOp(routes: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>): {
  run: RunOp
  calls: string[][]
} {
  const calls: string[][] = []
  const run: RunOp = async (argv) => {
    calls.push(argv)
    const verb = argv[1] === "item" ? "item" : argv[1]
    const r = routes[verb] ?? { ok: false, stderr: `unstubbed: ${verb}` }
    return { ok: r.ok !== false, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }
  return { run, calls }
}

const ITEM_WITH_URL = JSON.stringify({ urls: [{ href: "https://mail.google.com/" }] })
const ITEM_NO_URL = JSON.stringify({ urls: [] })
const TWO_ACCOUNTS = JSON.stringify([
  { url: "work.1password.com" },
  { url: "my.1password.com" },
])
const ONE_ACCOUNT = JSON.stringify([{ url: "my.1password.com" }])

describe("secret references", () => {
  test("op:// with three segments parses; vault and item may be names or UUIDs", () => {
    expect(parseSecretRef("op://Private/Gmail/password")).toEqual({
      vault: "Private", item: "Gmail", field: "password", raw: "op://Private/Gmail/password",
    })
    expect(parseSecretRef("op://ai2dtcyoucnndvs4l7smj252my/kqp3sabc/password").item).toBe("kqp3sabc")
  })

  test("a bare name is refused with the reference syntax in the message", () => {
    expect(() => parseSecretRef("gmail")).toThrow(OpError)
    try { parseSecretRef("gmail") } catch (e) {
      expect((e as OpError).code).toBe("invalid_ref")
      expect((e as OpError).message).toContain("op://<vault>/<item>/<field>")
    }
  })

  test("wrong scheme, wrong arity, and empty segments are refused", () => {
    for (const bad of ["file:///etc/passwd", "op://Private/Gmail", "op://Private/Gmail/user/password", "op:///Gmail/password", "op://Private//password", ""]) {
      expect(() => parseSecretRef(bad)).toThrow(OpError)
    }
    expect(() => parseSecretRef(undefined)).toThrow(OpError)
  })

  test("a section-qualified reference says so rather than failing vaguely", () => {
    try { parseSecretRef("op://Private/Gmail/section/password") } catch (e) {
      expect((e as OpError).message).toContain("section-qualified")
    }
  })
})

describe("finding the op binary", () => {
  // The daemon's PATH is /usr/bin:/bin:/usr/sbin:/sbin — Homebrew is not on it,
  // so a bare-name lookup would fail at delivery time. Absolute paths only.
  test("picks the first existing absolute candidate", () => {
    expect(resolveOpBinary({}, (p) => p === "/opt/homebrew/bin/op")).toBe("/opt/homebrew/bin/op")
    expect(resolveOpBinary({}, (p) => p === "/usr/local/bin/op")).toBe("/usr/local/bin/op")
    expect(OP_BIN_CANDIDATES.every((c) => c.startsWith("/"))).toBe(true)
  })

  test("INTERCEPTOR_OP_BIN wins, but only when absolute and present", () => {
    expect(resolveOpBinary({ INTERCEPTOR_OP_BIN: "/custom/op" }, (p) => p === "/custom/op")).toBe("/custom/op")
    expect(() => resolveOpBinary({ INTERCEPTOR_OP_BIN: "op" }, () => true)).toThrow(/absolute path/)
    expect(() => resolveOpBinary({ INTERCEPTOR_OP_BIN: "./op" }, () => true)).toThrow(/absolute path/)
    expect(() => resolveOpBinary({ INTERCEPTOR_OP_BIN: "/nope/op" }, () => false)).toThrow(/does not exist/)
  })

  test("no candidate found names the PATH trap in the error", () => {
    try { resolveOpBinary({}, () => false) } catch (e) {
      expect((e as OpError).code).toBe("op_missing")
      expect((e as OpError).message).toContain("/opt/homebrew/bin")
    }
  })
})

describe("account disambiguation", () => {
  // `op read` with several accounts and no --account resolves against one of
  // them silently. Releasing a credential against a guessed account is not ok.
  test("several accounts and no hint is refused", () => {
    expect(() => resolveAccount(undefined, ["a.1password.com", "b.1password.com"], {})).toThrow(OpError)
    try { resolveAccount(undefined, ["a", "b"], {}) } catch (e) {
      expect((e as OpError).code).toBe("account_ambiguous")
    }
  })

  test("explicit beats env, env beats nothing, one account needs neither", () => {
    expect(resolveAccount("chosen", ["a", "b"], { INTERCEPTOR_OP_ACCOUNT: "env" })).toBe("chosen")
    expect(resolveAccount(undefined, ["a", "b"], { INTERCEPTOR_OP_ACCOUNT: "env" })).toBe("env")
    expect(resolveAccount(undefined, ["only"], {})).toBeUndefined()
    expect(resolveAccount(undefined, [], {})).toBeUndefined()
  })
})

describe("the target check reads the 1Password item's own URLs", () => {
  test("exact host and subdomain match; unrelated host does not", () => {
    expect(hostMatches("google.com", "google.com")).toBe(true)
    expect(hostMatches("google.com", "mail.google.com")).toBe(true)
    expect(hostMatches("google.com", "notgoogle.com")).toBe(false)
    expect(urlHost("https://mail.google.com/x")).toBe("mail.google.com")
    expect(urlHost("mail.google.com")).toBe("mail.google.com")
    expect(urlHost("not a url")).toBe("")
  })

  test("a matching item URL allows the browser target", () => {
    expect(targetAllowedByItem(["https://google.com"], { kind: "browser", host: "mail.google.com" }).ok).toBe(true)
  })

  test("a non-matching host is refused and the reason names both sides", () => {
    const r = targetAllowedByItem(["https://google.com"], { kind: "browser", host: "evil.example" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("evil.example")
      expect(r.reason).toContain("google.com")
    }
  })

  test("an item with no URLs fails CLOSED, with a recoverable instruction", () => {
    const r = targetAllowedByItem([], { kind: "browser", host: "mail.google.com" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("--op-any-target")
  })

  test("a native app target needs --op-any-target — an item URL cannot describe one", () => {
    expect(targetAllowedByItem(["https://google.com"], { kind: "macos", bundleId: "com.apple.finder" }).ok).toBe(false)
    expect(targetAllowedByItem([], { kind: "macos", bundleId: "com.apple.finder" }, { anyTarget: true }).ok).toBe(true)
  })

  test("--op-any-target overrides every refusal above", () => {
    expect(targetAllowedByItem([], { kind: "browser", host: "anything" }, { anyTarget: true }).ok).toBe(true)
  })
})

describe("op invocation", () => {
  test("a failing account list throws instead of reporting zero accounts", async () => {
    // "op did not answer" and "no accounts signed in" are different facts;
    // collapsing them makes a wedged 1Password look like a sign-in problem.
    const { run } = fakeOp({ account: { ok: false, stderr: "did not answer within 12s" } })
    await expect(signedInAccounts("/op", run)).rejects.toMatchObject({ code: "op_failed" })
  })


  test("itemUrls reads metadata only — the argv never contains 'read'", async () => {
    const { run, calls } = fakeOp({ item: { stdout: ITEM_WITH_URL } })
    const urls = await itemUrls("/opt/homebrew/bin/op", parseSecretRef("op://Private/Gmail/password"), "my.1password.com", run)
    expect(urls).toEqual(["https://mail.google.com/"])
    expect(calls[0]).toEqual([
      "/opt/homebrew/bin/op", "item", "get", "Gmail",
      "--vault", "Private", "--account", "my.1password.com", "--format", "json",
    ])
    expect(calls[0]).not.toContain("read")
  })

  test("readSecret passes the raw reference as one argv element, never interpolated", async () => {
    const { run, calls } = fakeOp({ read: { stdout: "hunter2\n" } })
    const value = await readSecret("/opt/homebrew/bin/op", parseSecretRef("op://Private/Gmail/password"), undefined, run)
    expect(value).toBe("hunter2")
    expect(calls[0]).toEqual(["/opt/homebrew/bin/op", "read", "op://Private/Gmail/password"])
  })

  test("an empty field value is not a valid secret", async () => {
    const { run } = fakeOp({ read: { stdout: "\n" } })
    await expect(readSecret("/op", parseSecretRef("op://v/i/f"), undefined, run)).rejects.toMatchObject({ code: "not_found" })
  })

  test("an op failure surfaces op's own stderr", async () => {
    const { run } = fakeOp({ read: { ok: false, stderr: "[ERROR] isn't an item" } })
    await expect(readSecret("/op", parseSecretRef("op://v/i/f"), undefined, run)).rejects.toMatchObject({ code: "op_failed" })
  })
})

describe("resolveOpSecret ordering", () => {
  test("happy path returns the value and the parsed reference", async () => {
    const { run } = fakeOp({ account: { stdout: ONE_ACCOUNT }, item: { stdout: ITEM_WITH_URL }, read: { stdout: "hunter2\n" } })
    const res = await resolveOpSecret("op://Private/Gmail/password", { kind: "browser", host: "mail.google.com" }, { bin: "/op", run, env: {} })
    expect(res.value).toBe("hunter2")
    expect(res.ref.field).toBe("password")
  })

  test("the target check runs BEFORE the read — a wrong host never reads the field", async () => {
    const { run, calls } = fakeOp({ account: { stdout: ONE_ACCOUNT }, item: { stdout: ITEM_WITH_URL }, read: { stdout: "hunter2\n" } })
    await expect(
      resolveOpSecret("op://Private/Gmail/password", { kind: "browser", host: "evil.example" }, { bin: "/op", run, env: {} }),
    ).rejects.toMatchObject({ code: "target_denied" })
    expect(calls.some((c) => c[1] === "read")).toBe(false)
  })

  test("an item with no URL refuses before the read too", async () => {
    const { run, calls } = fakeOp({ account: { stdout: ONE_ACCOUNT }, item: { stdout: ITEM_NO_URL }, read: { stdout: "hunter2\n" } })
    await expect(
      resolveOpSecret("op://Private/Key/password", { kind: "browser", host: "mail.google.com" }, { bin: "/op", run, env: {} }),
    ).rejects.toMatchObject({ code: "target_denied" })
    expect(calls.some((c) => c[1] === "read")).toBe(false)
  })

  test("two accounts and no --op-account refuses before any item lookup", async () => {
    const { run, calls } = fakeOp({ account: { stdout: TWO_ACCOUNTS }, item: { stdout: ITEM_WITH_URL }, read: { stdout: "x\n" } })
    await expect(
      resolveOpSecret("op://Private/Gmail/password", { kind: "browser", host: "mail.google.com" }, { bin: "/op", run, env: {} }),
    ).rejects.toMatchObject({ code: "account_ambiguous" })
    expect(calls.some((c) => c[1] === "item" || c[1] === "read")).toBe(false)
  })

  test("two accounts with --op-account threads it into every op call", async () => {
    const { run, calls } = fakeOp({ account: { stdout: TWO_ACCOUNTS }, item: { stdout: ITEM_WITH_URL }, read: { stdout: "hunter2\n" } })
    const res = await resolveOpSecret(
      "op://Private/Gmail/password",
      { kind: "browser", host: "mail.google.com" },
      { bin: "/op", run, env: {}, account: "my.1password.com" },
    )
    expect(res.value).toBe("hunter2")
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c).toContain("--account")
      expect(c).toContain("my.1password.com")
    }
  })

  test("a bad reference is refused before op is invoked at all", async () => {
    const { run, calls } = fakeOp({})
    await expect(
      resolveOpSecret("gmail", { kind: "browser", host: "mail.google.com" }, { bin: "/op", run, env: {} }),
    ).rejects.toMatchObject({ code: "invalid_ref" })
    expect(calls).toEqual([])
  })
})
