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
  type SurfaceMode,
} from "../../shared/surface-mode"

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

  if (json) {
    console.log(JSON.stringify({
      mode: enabled ? "full" : "browser-only",
      macosEnabled: enabled,
      marker, bridgeDetected: detected,
      env: { INTERCEPTOR_BROWSER_ONLY: forceOff, INTERCEPTOR_ALL_SURFACES: forceOn },
      reason, markerPath: surfaceMarkerPath(),
    }, null, 2))
    return
  }
  console.log(`surface: ${enabled ? "full (macOS control enabled)" : "browser-only (macOS control disabled)"}`)
  console.log(`  reason: ${reason}`)
  console.log(`  marker: ${marker ?? "(unset)"}  ·  bridge present: ${detected ? "yes" : "no"}`)
  if (!enabled && detected && marker === "browser-only") {
    console.log("  a bridge is installed but disabled by choice — run 'interceptor surface full' to enable it.")
  }
  if (enabled && !detected) {
    console.log("  full mode is selected but no bridge is installed — run 'interceptor upgrade --full' to install it.")
  }
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

  console.error(`error: unknown surface verb '${sub}'. Use: interceptor surface [status|browser-only|full]`)
  process.exit(1)
}
