/**
 * shared/surface-mode.ts — is the macOS ("full computer-use") surface enabled?
 *
 * FORK-DELTA. Browser-only vs. full is a soft, persisted CHOICE, not merely
 * whether a bridge happens to be present. Upstream only had a one-way override
 * (force the macOS surface ON); nothing could turn it OFF while a bridge socket
 * existed, and the CLI gate was the only gate — a caller reaching the daemon
 * socket directly routed macos_* straight through. Every coding agent on this
 * machine is exactly such a direct caller, so the choice is enforced in BOTH
 * places: the CLI gate (detectSurfaces) and the daemon's macos_* routing.
 *
 * Precedence, first that applies wins:
 *   1. force-off — `--browser-only` / INTERCEPTOR_BROWSER_ONLY  → disabled
 *   2. force-on  — `--all-surfaces` / INTERCEPTOR_ALL_SURFACES  → enabled
 *   3. marker file ~/.interceptor/mode = "browser-only"         → disabled
 *   4. otherwise                                                → `detected`
 *
 * force-off is checked before force-on so the safe direction wins a conflict.
 * The "full" marker value is deliberately the same as no marker (fall through
 * to detection): you cannot conjure a bridge that is not installed.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type SurfaceMode = "browser-only" | "full"

const TRUTHY = new Set(["1", "true", "yes", "on"])

/** Env var truthiness for the OFF switch (1/true/yes/on). */
export function isTruthyEnv(v: string | undefined): boolean {
  return typeof v === "string" && TRUTHY.has(v.trim().toLowerCase())
}

export function surfaceMarkerPath(env: Record<string, string | undefined> = process.env): string {
  return `${env.HOME || ""}/.interceptor/mode`
}

/** Read the persisted mode marker, or null if unset/unreadable/malformed. */
export function readSurfaceMarker(env: Record<string, string | undefined> = process.env): SurfaceMode | null {
  try {
    const raw = readFileSync(surfaceMarkerPath(env), "utf-8").trim().toLowerCase()
    if (raw === "browser-only" || raw === "full") return raw
  } catch { /* unset or unreadable → null */ }
  return null
}

/** Persist the mode marker (0600). Returns the path written. */
export function writeSurfaceMarker(mode: SurfaceMode, env: Record<string, string | undefined> = process.env): string {
  const path = surfaceMarkerPath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${mode}\n`, { mode: 0o600 })
  return path
}

/** The single decision. See the precedence in the file header. */
export function macosEnabled(opts: {
  forceOff: boolean
  forceOn: boolean
  marker: SurfaceMode | null
  detected: boolean
}): boolean {
  if (opts.forceOff) return false
  if (opts.forceOn) return true
  if (opts.marker === "browser-only") return false
  return opts.detected
}

/**
 * Convenience for a process that has no argv flags to consult (the daemon):
 * decide from env + marker alone. `detected` says whether a bridge is present
 * (the daemon passes true — it holds the bridge socket).
 */
export function macosEnabledFromEnv(
  detected: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return macosEnabled({
    forceOff: isTruthyEnv(env.INTERCEPTOR_BROWSER_ONLY),
    forceOn: !!env.INTERCEPTOR_ALL_SURFACES,
    marker: readSurfaceMarker(env),
    detected,
  })
}
