/**
 * cli/lib/surfaces.ts — which Interceptor surfaces exist on this install
 *
 *
 * Both pkgs ship the same CLI binary; the Full pkg additionally lays down the
 * bridge LaunchAgent. Surface presence is therefore detected, not compiled in:
 *   browser  — always (it IS the product)
 *   macos    — darwin + bridge LaunchAgent plist present (Full install),
 *              or a dev checkout running the bridge directly
 *   ios      — rides the Full daemon (same detection as macos)
 *
 * The macOS surface is a soft, persisted CHOICE — see shared/surface-mode.ts.
 * `--all-surfaces` / INTERCEPTOR_ALL_SURFACES force it on; `--browser-only` /
 * INTERCEPTOR_BROWSER_ONLY force it off; the ~/.interceptor/mode marker persists
 * the default; otherwise it is detected from bridge presence.
 */

import { existsSync } from "node:fs"
import { macosEnabled, readSurfaceMarker, isTruthyEnv } from "../../shared/surface-mode"

export type Surfaces = { browser: true; macos: boolean }

const LAUNCH_AGENT_SYSTEM = "/Library/LaunchAgents/com.interceptor.bridge.plist"

function launchAgentUser(): string {
  return `${process.env.HOME || ""}/Library/LaunchAgents/com.interceptor.bridge.plist`
}

export function detectSurfaces(argv: string[] = [], env: Record<string, string | undefined> = process.env): Surfaces {
  const detected = process.platform === "darwin" &&
    (existsSync(LAUNCH_AGENT_SYSTEM) || existsSync(launchAgentUser()) ||
     existsSync("/tmp/interceptor-bridge.sock"))
  const macos = macosEnabled({
    forceOff: argv.includes("--browser-only") || isTruthyEnv(env.INTERCEPTOR_BROWSER_ONLY),
    forceOn: argv.includes("--all-surfaces") || !!env.INTERCEPTOR_ALL_SURFACES,
    marker: readSurfaceMarker(env),
    detected,
  })
  return { browser: true, macos }
}

export const SURFACE_UPGRADE_HINT =
  "macos: not available in this install — 'interceptor upgrade --full' adds computer-use mode (macOS only)."
