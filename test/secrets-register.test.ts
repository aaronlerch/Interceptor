/**
 * test/secrets-register.test.ts — issue #244 registration and CLI surface:
 * the box path forwards name/gate/targets (never a value), values never ride
 * argv, and the sudo leg pipes the password to stdin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMacosCommand } from "../cli/commands/macos"
import { parseActionsCommand } from "../cli/commands/actions"
import { normalizeArgsSplit } from "../cli/normalize"
import { parseTargets, SecretError } from "../daemon/secrets"

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
  test("register forwards name, gate, targets, reuse and never a value", () => {
    const a = parseMacosCommand(["macos", "secret", "register", "admin", "--gate", "touchid", "--target", "macos:com.apple.SecurityAgent,browser:x.com", "--reuse", "300"]) as Record<string, unknown>
    expect(a).toEqual({ type: "macos_secret", sub: "register", name: "admin", gate: "touchid", targets: ["macos:com.apple.SecurityAgent", "browser:x.com"], reuseSeconds: 300 })
    expect(JSON.stringify(a)).not.toContain("value")
  })

  test("a value on argv is refused for register and set", () => {
    expect(() => parseMacosCommand(["macos", "secret", "set", "admin", "hunter2"])).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("never pass the secret value on argv")
    expect(() => parseMacosCommand(["macos", "secret", "register", "admin", "hunter2"])).toThrow("__exit_1")
  })

  test("set --stdin marks the stdin path; other verbs parse", () => {
    expect(parseMacosCommand(["macos", "secret", "set", "admin", "--stdin"])).toEqual({ type: "macos_secret", sub: "set", name: "admin", stdin: true })
    expect(parseMacosCommand(["macos", "secret", "list"])).toEqual({ type: "macos_secret", sub: "list" })
    expect(parseMacosCommand(["macos", "secret", "status"])).toEqual({ type: "macos_secret", sub: "status" })
    expect(parseMacosCommand(["macos", "secret", "rm", "admin"])).toEqual({ type: "macos_secret", sub: "rm", name: "admin" })
    expect(parseMacosCommand(["macos", "secret", "unlock", "admin", "--for", "30m"])).toEqual({ type: "macos_secret", sub: "unlock", name: "admin", for: "30m" })
    expect(parseMacosCommand(["macos", "secret", "lock"])).toEqual({ type: "macos_secret", sub: "lock" })
    expect(parseMacosCommand(["macos", "secret", "reveal", "admin"])).toEqual({ type: "macos_secret", sub: "reveal", name: "admin" })
    expect(() => parseMacosCommand(["macos", "secret", "unlock", "admin"])).toThrow("__exit_1")
    expect(() => parseMacosCommand(["macos", "secret", "frobnicate"])).toThrow("__exit_1")
    expect(() => parseMacosCommand(["macos", "secret", "rm"])).toThrow("__exit_1")
  })

  test("macos type --secret is by name and refuses literal text", () => {
    expect(parseMacosCommand(["macos", "type", "--secret", "admin"])).toEqual({ type: "macos_type", secret: "admin" })
    expect(parseMacosCommand(["macos", "type", "e4", "--secret", "admin", "--app", "TextEdit"])).toEqual({ type: "macos_type", secret: "admin", ref: "e4", app: "TextEdit" })
    expect(() => parseMacosCommand(["macos", "type", "e4", "hello", "--secret", "admin"])).toThrow("__exit_1")
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

  test("'sudo' and 'ios' are no longer valid secret targets", () => {
    expect(() => parseTargets("sudo")).toThrow(SecretError)
    expect(() => parseTargets("ios")).toThrow(SecretError)
    expect(parseTargets("browser:x.com")).toEqual(["browser:x.com"])
  })
})

describe("browser type --secret", () => {
  test("normalizer accepts --secret as a value flag and the parser emits a by-name action", () => {
    const n = normalizeArgsSplit(["type", "e3", "--secret", "site-pw"])
    expect(n.argv).toEqual(["type", "e3", "--secret", "site-pw"])
    expect(n.positionalCount).toBe(1)
    expect(parseActionsCommand(n.argv, n.positionalCount)).toEqual({ type: "input_text", ref: "e3", secret: "site-pw", clear: true })
    const os = normalizeArgsSplit(["type", "e3", "--secret", "site-pw", "--trusted"])
    expect(parseActionsCommand(os.argv, os.positionalCount)).toEqual({ type: "os_type", ref: "e3", secret: "site-pw" })
    const sem = normalizeArgsSplit(["type", "textbox:Password", "--secret", "site-pw", "--append"])
    expect(parseActionsCommand(sem.argv, sem.positionalCount)).toMatchObject({ type: "find_and_type", secret: "site-pw", clear: false })
  })

  test("literal text plus --secret is a hard error; literal path unchanged", () => {
    const n = normalizeArgsSplit(["type", "e3", "hello", "--secret", "site-pw"])
    expect(() => parseActionsCommand(n.argv, n.positionalCount)).toThrow("__exit_1")
    expect(errors.join("\n")).toContain("mutually exclusive")
    const plain = normalizeArgsSplit(["type", "e3", "hello", "world"])
    expect(parseActionsCommand(plain.argv, plain.positionalCount)).toEqual({ type: "input_text", ref: "e3", text: "hello world", clear: true })
  })
})
