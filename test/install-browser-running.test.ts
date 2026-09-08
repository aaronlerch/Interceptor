// Issue #172: on Linux, scripts/install.sh resolved the browser to a bare name
// (brave, google-chrome) and asked `pgrep -f "$BROWSER_BIN"` whether it was
// running. `-f` matches whole command lines, and the installer's own line
// contains the name (`bash scripts/install.sh --brave …`), so the browser
// always looked running — and the "force restart" `pkill -f` signalled the
// installer itself.
//
// The first fix anchored the Linux match to argv[0]: `^([^ ]*/)?google-chrome`.
// That traded a false positive for a false NEGATIVE. Chromium re-execs its
// browser process with argv[0] set to the real executable, so a Chrome started
// from the desktop launcher runs as `/opt/google/chrome/chrome` and the
// anchored pattern matched nothing at all (Ubuntu 24.04 / Chrome 152).
//
// A false negative is the worse direction: write_developer_mode_true() gates on
// browser_running, so the installer would rewrite Preferences beneath a live
// browser, which overwrites that file on shutdown and silently discards the
// Developer-mode flip — leaving a dormant install that times out at 15s per
// command.
//
// Detection now reads /proc/<pid>/exe, which is immune to argv[0] rewriting.
// The helper is extracted from the real script text (single source of truth)
// and exercised against live decoy processes for BOTH regressions.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "bun"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SCRIPT = readFileSync(resolve(REPO_ROOT, "scripts/install.sh"), "utf-8")
const HELPER = SCRIPT.match(/browser_pids_for\(\) \{\n[\s\S]*?\n\}\n/)?.[0]
const IS_LINUX = process.platform === "linux"

function pidsFor(launcher: string, binDir: string): number[] {
  if (!HELPER) throw new Error("browser_pids_for() not found in scripts/install.sh")
  const run = spawnSync([
    "bash",
    "-c",
    `PATH="$2:$PATH"\n${HELPER}\nbrowser_pids_for "$1"`,
    "bash",
    launcher,
    binDir,
  ])
  return run.stdout.toString().split("\n").filter(Boolean).map(Number)
}

const children: ReturnType<typeof spawn>[] = []
const tmpDirs: string[] = []
afterAll(() => {
  for (const c of children) { try { c.kill() } catch {} }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

describe("install.sh browser-running detection (issue #172)", () => {
  test("every browser-running check goes through the helpers; no bare pgrep -f on the binary remains", () => {
    expect(HELPER).toBeDefined()
    expect(SCRIPT).not.toMatch(/pgrep -f "\$BROWSER_BIN"/)
    expect(SCRIPT).not.toMatch(/pgrep -f "\$browser_bin"/)
    expect(SCRIPT).not.toMatch(/pkill -TERM -f "\$BROWSER_BIN"/)
    // write_developer_mode_true, dev-mode auto-enable gate, BROWSER_RUNNING,
    // and the post-kill wait loop → 4 checks; the force-restart path → 1 kill.
    expect(SCRIPT.match(/\bbrowser_running "\$/g)?.length).toBe(4)
    expect(SCRIPT.match(/\bkill_browser "\$/g)?.length).toBe(1)
  })

  test("the argv[0]-anchored pattern is gone; Linux detection reads /proc/<pid>/exe", () => {
    // Guards the revert: that pattern cannot see a re-exec'd Chromium at all.
    // Comments are stripped first — the rationale above deliberately quotes the
    // old pattern, and documenting it must not trip its own regression guard.
    const code = SCRIPT.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
    expect(code).not.toMatch(/\^\(\[\^ \]\*\/\)\?/)
    expect(code).not.toMatch(/browser_pgrep_pattern/)
    expect(HELPER).toMatch(/\/proc\/\[0-9\]\*\/exe/)
  })

  test("Darwin keeps pgrep on the .app binary path", () => {
    // The .app path never appears in the installer's own argv, so the Darwin
    // branch is unambiguous and deliberately unchanged.
    expect(SCRIPT).toMatch(/if \[\[ "\$PLATFORM" == "Darwin" \]\]; then\n {4}pgrep -f "\$1" >\/dev\/null 2>&1/)
  })

  test.skipIf(!IS_LINUX)("a re-exec'd browser is detected, and the installer's own argv still is not", async () => {
    // A browser install dir: a launcher name on PATH beside the real binary,
    // mirroring /opt/google/chrome/{google-chrome,chrome}.
    const root = mkdtempSync(join(tmpdir(), "interceptor-browser-detect-"))
    tmpDirs.push(root)
    const binDir = join(root, "bin")
    mkdirSync(binDir)
    const realBinary = join(binDir, "chromelike")
    copyFileSync("/bin/sleep", realBinary)
    chmodSync(realBinary, 0o755)
    symlinkSync(realBinary, join(binDir, "fakechrome"))

    // Decoy 1 — the regression this test was originally written for: a bash
    // process whose command line carries installer argv, but whose exe is bash.
    const installer = spawn({
      cmd: ["bash", "-c", "sleep 20; :", "bash", "--browser-only", "--fakechrome", "--profile", "Default"],
      stdout: "ignore",
      stderr: "ignore",
    })
    // Decoy 2 — the regression the argv[0] anchor introduced: a process running
    // the browser binary whose argv[0] has been rewritten to something else,
    // exactly as Chromium re-execs itself as /opt/google/chrome/chrome.
    const browser = spawn({
      cmd: ["bash", "-c", `exec -a /some/rewritten/argv0 ${realBinary} 20`],
      stdout: "ignore",
      stderr: "ignore",
    })
    children.push(installer, browser)
    await Bun.sleep(300)

    const pids = pidsFor("fakechrome", binDir)
    expect(pids).not.toContain(installer.pid)
    expect(pids).toContain(browser.pid)
  })
})
