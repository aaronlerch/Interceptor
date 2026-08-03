/**
 * shared/ios-service.ts — types, action set, and stable error codes for the
 * iOS device-service introspection lane.
 *
 * A runner-free, pairing-only observe/introspect lane that speaks the CLASSIC
 * Lockdown service family (diagnostics, logs, filesystem, crash reports,
 * profiles, notifications, springboard). Sibling of the web lane
 * (shared/ios-web.ts): reuses `ios:<udid>` device identity, adds its own action
 * set routed BEFORE the broad `ios:` fallback so it never reaches the runner.
 *
 * Dependency-free (no Bun/daemon imports) so it can be unit-tested and imported
 * from both cli and daemon. Mirrors shared/ios-device.ts + shared/ios-web.ts.
 */

// ── action set (tested BEFORE the broad ios: fallback; runner-free) ───────────

export const IOS_SVC_ACTION_TYPES = new Set<string>([
  "ios_diag",
  "ios_logs",
  "ios_fs",
  "ios_crash",
  "ios_profiles",
  "ios_notify",
  "ios_springboard",
])

/** Streaming actions carry operation start|read|stop (CLI may also poll). */
export const IOS_SVC_STREAM_ACTION_TYPES = new Set<string>(["ios_logs", "ios_notify"])

export type IosSvcResult = { success: boolean; error?: string; data?: unknown }

// ── stable error codes + guidance ─────────────────────────────────────────────

export type IosSvcErrorCode =
  | "device_not_found"
  | "device_unpaired"
  | "device_locked"
  | "service_unavailable"
  | "service_stream_closed"
  | "afc_error"
  | "plist_malformed"
  | "buffer_overflow"
  | "container_not_owned"
  | "stream_not_found"
  | "bad_request"

const NEXT_STEP: Record<IosSvcErrorCode, string> = {
  device_not_found: "Run 'interceptor ios devices'; pick from the listed candidates.",
  device_unpaired: "Cable-connect, unlock, and accept Trust This Computer.",
  device_locked: "Unlock the device and retry (the service refused while locked).",
  service_unavailable: "This service did not open over classic Lockdown on this OS build (it may have moved to a tunnel .shim.remote).",
  service_stream_closed: "The device closed the stream — re-run to reattach.",
  afc_error: "The AFC filesystem op failed — check the path and the --app container.",
  plist_malformed: "The service returned a malformed/oversized plist frame; the socket was closed.",
  buffer_overflow: "Stream events were dropped by the bounded store; see the dropped count and retained range.",
  container_not_owned: "Only app containers you own or are authorized to test are accessible via house_arrest.",
  stream_not_found: "No active stream — run the 'start' operation first.",
  bad_request: "Check the command arguments and try again.",
}

/** Build the machine-readable error payload the CLI renders. */
export function svcError(code: IosSvcErrorCode, error?: string, extra?: Record<string, unknown>): IosSvcResult {
  return {
    success: false,
    error: error ?? code.replace(/_/g, " "),
    data: { code, next: NEXT_STEP[code], ...(extra ?? {}) },
  }
}

/** Map a thrown daemon error to a stable svc error code (best-effort). */
export function classifyServiceError(err: unknown): IosSvcErrorCode {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not paired|Trust This Computer/i.test(msg)) return "device_unpaired"
  // StartService failures are the most specific — check before the lock check
  // (the word "lockdown" must NOT be read as "locked").
  if (/StartService|InvalidService|Could not start|service.*unavailable/i.test(msg)) return "service_unavailable"
  if (/passcode|is locked|\block(ed)?\b/i.test(msg)) return "device_locked"
  if (/\bAFC\b/i.test(msg)) return "afc_error"
  if (/plist/i.test(msg)) return "plist_malformed"
  return "bad_request"
}

// ── canonical service names (single source of truth) ──────────────────────────

export const IOS_SERVICE = {
  installationProxy: "com.apple.mobile.installation_proxy",
  afc: "com.apple.afc",
  houseArrest: "com.apple.mobile.house_arrest",
  diagnosticsRelay: "com.apple.mobile.diagnostics_relay",
  syslogRelay: "com.apple.syslog_relay",
  crashCopy: "com.apple.crashreportcopymobile",
  crashMover: "com.apple.crashreportmover",
  mcInstall: "com.apple.mobile.MCInstall",
  misagent: "com.apple.misagent",
  notificationProxy: "com.apple.mobile.notification_proxy",
  springboard: "com.apple.springboardservices",
} as const

// ── output shapes (normalized envelopes) ──────────────────────────────────────

export type DiagKind = "all" | "battery" | "gestalt" | "ioreg"

export type FsOp = "ls" | "pull" | "push"

export type BufferedEvent = { at: string; [k: string]: unknown }

export type StreamDrain = {
  events: BufferedEvent[]
  dropped: number
  retainedFrom?: string
}
