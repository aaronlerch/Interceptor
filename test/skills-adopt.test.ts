import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, realpathSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { classifyLink, adoptSkill, discoverSkills, allTargets, type SkillTarget, type SkillInfo } from "../cli/commands/skills"

let root: string
let packDir: string
let targetDir: string

function makeSkill(name: string): SkillInfo {
  const dir = join(packDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody`)
  return { name, description: `test skill ${name}`, dir }
}

function target(): SkillTarget {
  return { id: "claude", label: "Claude Code", parent: join(root, ".claude"), dir: targetDir }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "interceptor-skills-test-"))
  packDir = join(root, "pack")
  targetDir = join(root, ".claude", "skills")
  mkdirSync(packDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("discoverSkills", () => {
  test("finds directories with SKILL.md and reads descriptions", () => {
    makeSkill("interceptor-browser")
    makeSkill("interceptor")
    mkdirSync(join(packDir, "not-a-skill"))
    const skills = discoverSkills(packDir)
    expect(skills.map(s => s.name)).toEqual(["interceptor", "interceptor-browser"])
    expect(skills[0].description).toBe("test skill interceptor")
  })
})

describe("classifyLink", () => {
  test("missing when destination does not exist", () => {
    const s = makeSkill("a")
    expect(classifyLink(targetDir, "a", s.dir)).toBe("missing")
  })

  test("linked when symlink resolves to the pack skill", () => {
    const s = makeSkill("a")
    mkdirSync(targetDir, { recursive: true })
    symlinkSync(s.dir, join(targetDir, "a"))
    expect(classifyLink(targetDir, "a", s.dir)).toBe("linked")
  })

  test("foreign when symlink points elsewhere", () => {
    const s = makeSkill("a")
    const other = makeSkill("b")
    mkdirSync(targetDir, { recursive: true })
    symlinkSync(other.dir, join(targetDir, "a"))
    expect(classifyLink(targetDir, "a", s.dir)).toBe("foreign")
  })

  test("stale-copy when destination is a real directory", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "SKILL.md"), "old copy")
    expect(classifyLink(targetDir, "a", s.dir)).toBe("stale-copy")
  })
})

describe("adoptSkill", () => {
  test("creates a working symlink and reports linked", () => {
    const s = makeSkill("a")
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("linked")
    expect(lstatSync(join(targetDir, "a")).isSymbolicLink()).toBe(true)
    expect(realpathSync(join(targetDir, "a"))).toBe(realpathSync(s.dir))
  })

  test("is idempotent (already-linked)", () => {
    const s = makeSkill("a")
    adoptSkill(target(), s, false)
    expect(adoptSkill(target(), s, false).action).toBe("already-linked")
  })

  test("replaces a foreign symlink (ln -sfn semantics, no data destroyed)", () => {
    const s = makeSkill("a")
    const other = makeSkill("b")
    mkdirSync(targetDir, { recursive: true })
    symlinkSync(other.dir, join(targetDir, "a"))
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("linked")
    expect(realpathSync(join(targetDir, "a"))).toBe(realpathSync(s.dir))
  })

  test("NEVER replaces a real directory without --force", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "user-edit.md"), "precious")
    const r = adoptSkill(target(), s, false)
    expect(r.action).toBe("skipped")
    expect(lstatSync(join(targetDir, "a")).isDirectory()).toBe(true)
  })

  test("replaces a real directory with --force", () => {
    const s = makeSkill("a")
    mkdirSync(join(targetDir, "a"), { recursive: true })
    writeFileSync(join(targetDir, "a", "SKILL.md"), "old copy")
    const r = adoptSkill(target(), s, true)
    expect(r.action).toBe("replaced-copy")
    expect(lstatSync(join(targetDir, "a")).isSymbolicLink()).toBe(true)
  })
})

describe("allTargets", () => {
  test("codex honors CODEX_HOME and defaults to ~/.codex/skills", () => {
    const defaults = allTargets("/home/u", {})
    const codex = defaults.find(t => t.id === "codex")!
    expect(codex.dir).toBe(join("/home/u", ".codex", "skills"))
    const overridden = allTargets("/home/u", { CODEX_HOME: "/custom/codex" })
    expect(overridden.find(t => t.id === "codex")!.dir).toBe(join("/custom/codex", "skills"))
  })

  test("claude targets ~/.claude/skills (resolves to %USERPROFILE%\\.claude on Windows)", () => {
    const claude = allTargets("/home/u", {}).find(t => t.id === "claude")!
    expect(claude.dir).toBe(join("/home/u", ".claude", "skills"))
  })
})
