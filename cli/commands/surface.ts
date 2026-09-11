// cli/commands/surface.ts — choose browser-only vs. full computer-use.
//
// FORK-DELTA. A soft, persisted switch (shared/surface-mode.ts) that works even
// when a bridge is installed — unlike `upgrade --full` / `uninstall --bridge-only`,
// which install or remove the bridge. Enforced at both the CLI gate and the
// daemon, so flipping to browser-only actually stops macos_* routing.

import { existsSync } from "node:fs"
import {
  macosEnabled,
  readSurfaceMarker,
  writeSurfaceMarker,
  isTruthyEnv,
  surfaceMarkerPath,
  readMacosAllowlist,
  writeMacosAllowlist,
  clearMacosAllowlist,
  macosAllowlistPath,
  type SurfaceMode,
} from "../../shared/surface-mode"
import { BUILTIN_BRIDGE_PREFIXES } from "../../shared/extensions"

// The review-backed safe default: reads, captures, window/app enumeration, and
// on-device ML only. No synthetic input, no AppleScript/shell (`intent`/`script`),
// no whole-disk `fs`, no network (`url`), and no personal-data stores. A caller
// adds the sharper domains explicitly and consciously.
const RECOMMENDED_DOMAINS = [
  "tree", "find", "inspect", "value", "focused", "windows", "text",
  "apps", "app", "frontmost", "screenshot", "capture", "display",
  "vision", "nlp", "ai", "sounds", "sensitive", "health", "translate",
  "detect", "thumbnail", "pdf", "log", "trust", "tcc",
]

function bridgeDetected(): boolean {
  const home = process.env.HOME || ""
  return process.platform === "darwin" && (
    existsSync("/Library/LaunchAgents/com.interceptor.bridge.plist") ||
    existsSync(`${home}/Library/LaunchAgents/com.interceptor.bridge.plist`) ||
    existsSync("/tmp/interceptor-bridge.sock")
  )
}

function printStatus(json: boolean): void {
  const marker = readSurfaceMarker()
  const forceOff = isTruthyEnv(process.env.INTERCEPTOR_BROWSER_ONLY)
  const forceOn = !!process.env.INTERCEPTOR_ALL_SURFACES
  const detected = bridgeDetected()
  const enabled = macosEnabled({ forceOff, forceOn, marker, detected })
  const reason = forceOff ? "INTERCEPTOR_BROWSER_ONLY is set"
    : forceOn ? "INTERCEPTOR_ALL_SURFACES is set"
    : marker === "browser-only" ? "marker file (~/.interceptor/mode) says browser-only"
    : marker === "full" ? (detected ? "marker says full and a bridge is present" : "marker says full but no bridge is installed")
    : detected ? "no marker; a bridge is present" : "no marker; no bridge installed"

  const allowlist = readMacosAllowlist()
  const allowDesc = allowlist === null ? "all domains" : allowlist.size ? `${allowlist.size} domains` : "none (every domain denied)"

  if (json) {
    console.log(JSON.stringify({
      mode: enabled ? "full" : "browser-only",
      macosEnabled: enabled,
      marker, bridgeDetected: detected,
      env: { INTERCEPTOR_BROWSER_ONLY: forceOff, INTERCEPTOR_ALL_SURFACES: forceOn },
      reason, markerPath: surfaceMarkerPath(),
      allowlist: allowlist === null ? null : [...allowlist].sort(),
      allowlistPath: macosAllowlistPath(),
    }, null, 2))
    return
  }
  console.log(`surface: ${enabled ? "full (macOS control enabled)" : "browser-only (macOS control disabled)"}`)
  console.log(`  reason: ${reason}`)
  console.log(`  marker: ${marker ?? "(unset)"}  ·  bridge present: ${detected ? "yes" : "no"}`)
  console.log(`  allowlist: ${allowDesc}${allowlist && allowlist.size ? ` — ${[...allowlist].sort().join(", ")}` : ""}`)
  if (enabled && allowlist === null) {
    console.log("  (full mode with no allowlist permits every domain, including arbitrary AppleScript/shell —")
    console.log("   'interceptor surface allow recommended' narrows it to read/capture/on-device only.)")
  }
  if (!enabled && detected && marker === "browser-only") {
    console.log("  a bridge is installed but disabled by choice — run 'interceptor surface full' to enable it.")
  }
  if (enabled && !detected) {
    console.log("  full mode is selected but no bridge is installed — run 'interceptor upgrade --full' to install it.")
  }
}

function runAllow(args: string[], json: boolean): void {
  const sub = args[0]
  if (!sub) { // show
    const allow = readMacosAllowlist()
    if (json) { console.log(JSON.stringify({ allowlist: allow === null ? null : [...allow].sort(), path: macosAllowlistPath() }, null, 2)); return }
    console.log(allow === null ? "allowlist: all domains (no file)" : allow.size ? `allowlist: ${[...allow].sort().join(", ")}` : "allowlist: none (every domain denied)")
    return
  }
  if (sub === "all") { clearMacosAllowlist(); console.log("allowlist cleared — every macOS domain is permitted in full mode."); return }
  if (sub === "none") { const p = writeMacosAllowlist([]); console.log(`allowlist set to none (${p}) — every macOS domain is denied.`); return }
  if (sub === "recommended") { const p = writeMacosAllowlist(RECOMMENDED_DOMAINS); console.log(`allowlist set to the recommended safe set (${p}):`); console.log(`  ${RECOMMENDED_DOMAINS.join(", ")}`); return }

  // explicit list: validate every name against the known domain universe so a
  // typo fails loudly instead of silently denying a domain you wanted.
  const domains = args.map(d => d.toLowerCase())
  const unknown = domains.filter(d => !BUILTIN_BRIDGE_PREFIXES.has(d) && d !== "trust")
  if (unknown.length) {
    console.error(`error: unknown macOS domain(s): ${unknown.join(", ")}`)
    console.error(`       known domains: ${[...BUILTIN_BRIDGE_PREFIXES].sort().join(", ")}`)
    process.exit(1)
  }
  const p = writeMacosAllowlist([...new Set(domains)].sort())
  console.log(`allowlist set (${p}): ${[...new Set(domains)].sort().join(", ")}`)
}

export async function runSurfaceCommand(filtered: string[]): Promise<void> {
  const json = filtered.includes("--json")
  const sub = filtered[1] && !filtered[1].startsWith("-") ? filtered[1] : "status"

  if (sub === "status") { printStatus(json); return }

  if (sub === "browser-only" || sub === "full") {
    const path = writeSurfaceMarker(sub as SurfaceMode)
    if (!json) console.log(`surface set to '${sub}' (${path})`)
    printStatus(json)
    return
  }

  if (sub === "allow") {
    runAllow(filtered.slice(2).filter(a => a !== "--json"), json)
    return
  }

  console.error(`error: unknown surface verb '${sub}'. Use: interceptor surface [status|browser-only|full|allow ...]`)
  process.exit(1)
}
