/**
 * test/secret-delivery-cli.test.ts — the CLI surface for credential delivery.
 *
 * FORK-DELTA §5/§6/§7: `macos sudo` and `macos authdialog` are gone, and the
 * vault is 1Password. `--secret` takes an op:// reference — a location, not a
 * value, so unlike upstream's secret name it is genuinely safe on argv.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parseMacosCommand } from "../cli/commands/macos"
import { parseActionsCommand } from "../cli/commands/actions"
import { normalizeArgsSplit } from "../cli/normalize"

let exitCode: number | undefined
let errors: string[] = []
const realExit = process.exit
const realConsoleError = console.error

beforeEach(() => {
  exitCode = undefined
  errors = []
  process.exit = ((code?: number) => { exitCode = code; throw new Error(`__exit_${code}`) }) as never
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
})
afterEach(() => { process.exit = realExit; console.error = realConsoleError })

describe("macos secret CLI shape", () => {
  test("status is the only remaining verb — 1Password owns the vault", () => {
    expect(parseMacosCommand(["macos", "secret", "status"])).toEqual({ type: "macos_secret", sub: "status" })
    expect(parseMacosCommand(["macos", "secret"])).toEqual({ type: "macos_secret", sub: "status" })
  })

  test("the removed store verbs point at the op equivalents rather than failing blankly", () => {
    for (const verb of ["register", "set", "list", "rm", "unlock", "lock", "reveal"]) {
      errors = []
      expect(() => parseMacosCommand(["macos", "secret", verb, "admin"])).toThrow("__exit_1")
      expect(errors.join("\n")).toContain("1Password owns the vault")
      expect(errors.join("\n")).toContain("op item create")
    }
  })

  test("macos type --secret takes a reference and refuses literal text", () => {
    const REF = "op://Private/Admin/password"
    expect(parseMacosCommand(["macos", "type", "--secret", REF])).toEqual({ type: "macos_type", secret: REF })
    expect(parseMacosCommand(["macos", "type", "e4", "--secret", REF, "--app", "TextEdit"])).toEqual({ type: "macos_type", secret: REF, ref: "e4", app: "TextEdit" })
    expect(parseMacosCommand(["macos", "type", "--secret", REF, "--op-any-target", "--op-account", "my.1password.com"]))
      .toEqual({ type: "macos_type", secret: REF, opAccount: "my.1password.com", opAnyTarget: true })
    expect(() => parseMacosCommand(["macos", "type", "e4", "hello", "--secret", REF])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("mutually exclusive")
    // the literal path is unchanged
    expect(parseMacosCommand(["macos", "type", "e4", "hello"])).toEqual({ type: "macos_type", ref: "e4", text: "hello" })
  })

  // FORK-DELTA §5/§6: `macos sudo` and `macos authdialog` are removed. Upstream
  // shipped both as secret-delivery legs; `sudo` piped the vault value into
  // `sudo -S` from the daemon, so any local process that reached the daemon
  // socket could run an arbitrary command as root with no prompt. These assert
  // the verbs stay gone rather than silently returning in a later merge.
  test("macos sudo is not a verb", () => {
    expect(() => parseMacosCommand(["macos", "sudo", "--secret", "admin", "--", "id"])).toThrow()
  })

  test("macos authdialog is not a verb", () => {
    expect(() => parseMacosCommand(["macos", "authdialog", "status"])).toThrow()
  })

})

describe("browser type --secret", () => {
  const REF = "op://Private/Gmail/password"

  test("normalizer accepts --secret and the parser emits a by-reference action", () => {
    const n = normalizeArgsSplit(["type", "e3", "--secret", REF])
    expect(n.argv).toEqual(["type", "e3", "--secret", REF])
    expect(n.positionalCount).toBe(1)
    expect(parseActionsCommand(n.argv, n.positionalCount)).toEqual({ type: "input_text", ref: "e3", secret: REF, clear: true })
    const os = normalizeArgsSplit(["type", "e3", "--secret", REF, "--trusted"])
    expect(parseActionsCommand(os.argv, os.positionalCount)).toEqual({ type: "os_type", ref: "e3", secret: REF })
    const sem = normalizeArgsSplit(["type", "textbox:Password", "--secret", REF, "--append"])
    expect(parseActionsCommand(sem.argv, sem.positionalCount)).toMatchObject({ type: "find_and_type", secret: REF, clear: false })
  })

  test("--op-account and --op-any-target ride through, and are declared flags", () => {
    const n = normalizeArgsSplit(["type", "e3", "--secret", REF, "--op-account", "my.1password.com", "--op-any-target"])
    expect(parseActionsCommand(n.argv, n.positionalCount)).toEqual({
      type: "input_text", ref: "e3", secret: REF, opAccount: "my.1password.com", opAnyTarget: true, clear: true,
    })
  })

  test("a bare name is refused locally, before any daemon round trip", () => {
    for (const bad of ["gmail", "op://Private/Gmail", "file:///etc/passwd"]) {
      errors = []
      const n = normalizeArgsSplit(["type", "e3", "--secret", bad])
      expect(() => parseActionsCommand(n.argv, n.positionalCount)).toThrow("__exit_1")
      expect(errors.join("\n")).toContain("op://<vault>/<item>/<field>")
    }
    expect(() => parseMacosCommand(["macos", "type", "--secret", "admin"])).toThrow("__exit_1")
  })

  test("--op-account without a value is a usage error, not a swallowed flag", () => {
    const n = normalizeArgsSplit(["type", "e3", "--secret", REF, "--op-account"])
    expect(() => parseActionsCommand(n.argv, n.positionalCount)).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("--op-account requires")
  })

  test("literal text plus --secret is a hard error; literal path unchanged", () => {
    const n = normalizeArgsSplit(["type", "e3", "hello", "--secret", REF])
    expect(() => parseActionsCommand(n.argv, n.positionalCount)).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("mutually exclusive")
    const plain = normalizeArgsSplit(["type", "e3", "hello", "world"])
    expect(parseActionsCommand(plain.argv, plain.positionalCount)).toEqual({ type: "input_text", ref: "e3", text: "hello world", clear: true })
  })
})
