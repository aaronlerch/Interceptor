/**
 * shared/ios-dev.ts — types, action set, stable error codes, and service/channel
 * constants for the iOS developer-service, Instruments & telemetry lanes.
 *
 * Sibling of shared/ios-service.ts (classic Lockdown lane) and shared/ios-web.ts
 * (WebKit lane). Adds the DTX/Instruments powerhouse (process list, per-proc
 * telemetry, launch/kill, GPS sim, FPS, app inventory) plus os_trace unified
 * logs, pcap, screenshotr, backup, live screen, and a runner-free AX tree.
 *
 * Routed BEFORE the broad `ios:` fallback so these actions never reach the
 * XCUITest runner. Dependency-free (no Bun/daemon imports) for shared use.
 */

// ── action set (tested BEFORE the broad ios: fallback; runner-free) ───────────

export const IOS_DEV_ACTION_TYPES = new Set<string>([
  "ios_proc",       // deviceinfo runningProcesses
  "ios_top",        // sysmontap per-process telemetry (stream)
  "ios_spawn",      // processcontrol launch (with env/args)
  "ios_kill",       // processcontrol kill/signal
  "ios_location",   // LocationSimulation set/clear
  "ios_gpu",        // graphics.opengl FPS/GPU (stream)
  // NOTE: ios_oslog (os_trace_relay) + ios_pcap (pcapd) are temporarily removed —
  // both classic-Lockdown streams stopped delivering on iOS 27 (oslog opens but
  // yields no entries; pcapd StartService throws). Codecs kept in ostrace.ts/pcapd.ts.
  "ios_shot",       // screenshotr one-shot PNG (DDI-gated)
  "ios_backup",     // mobilebackup2
  "ios_screen",     // CoreMediaIO/QuickTime live screen (stream)
  "ios_axtree",     // axAuditDaemon runner-free accessibility tree
])

/** Streaming actions carry operation start|read|stop (CLI may also poll/--follow). */
export const IOS_DEV_STREAM_ACTION_TYPES = new Set<string>([
  "ios_top",
  "ios_gpu",
  "ios_screen",
])

export type IosDevResult = { success: boolean; error?: string; data?: unknown }

// ── stable error codes + guidance ─────────────────────────────────────────────

export type IosDevErrorCode =
  | "device_not_found"
  | "device_unpaired"
  | "tunnel_unavailable"
  | "service_unavailable"
  | "dtx_channel_failed"
  | "ddi_not_mounted"
  | "service_stream_closed"
  | "stream_not_found"
  | "buffer_overflow"
  | "plist_malformed"
  | "unsupported_on_os"
  | "not_permitted"
  | "bad_request"

const NEXT_STEP: Record<IosDevErrorCode, string> = {
  device_not_found: "Run 'interceptor ios devices'; pick from the listed candidates.",
  device_unpaired: "Cable-connect, unlock, and accept Trust This Computer.",
  tunnel_unavailable: "The RemoteXPC tunnel could not be established — confirm the device is unlocked and paired, then retry.",
  service_unavailable: "This service did not open on this OS build (it may be gated or moved).",
  dtx_channel_failed: "The Instruments DTX channel could not be opened — the developer service may be busy; retry.",
  ddi_not_mounted: "This needs the Developer Disk Image mounted (open Xcode once with the device attached, or run any 'ios' verb that mounts it).",
  service_stream_closed: "The device closed the stream — re-run to reattach.",
  stream_not_found: "No active stream — run the 'start' operation first.",
  buffer_overflow: "Stream events were dropped by the bounded store; see the dropped count and retained range.",
  plist_malformed: "The service returned a malformed/oversized frame; the socket was closed.",
  unsupported_on_os: "This capability is not available on this iOS version.",
  not_permitted: "The device refused this action (permission/entitlement).",
  bad_request: "Check the command arguments and try again.",
}

/** Build the machine-readable error payload the CLI renders. */
export function devError(code: IosDevErrorCode, error?: string, extra?: Record<string, unknown>): IosDevResult {
  return {
    success: false,
    error: error ?? code.replace(/_/g, " "),
    data: { code, next: NEXT_STEP[code], ...(extra ?? {}) },
  }
}

/** Map a thrown daemon error to a stable dev error code (best-effort). */
export function classifyDevError(err: unknown): IosDevErrorCode {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not paired|Trust This Computer/i.test(msg)) return "device_unpaired"
  if (/tunnel|RemoteXPC|RSD|CoreDeviceProxy/i.test(msg)) return "tunnel_unavailable"
  if (/DDI|Developer.*image|not mounted|ImageNotMounted/i.test(msg)) return "ddi_not_mounted"
  if (/channel|dtx/i.test(msg)) return "dtx_channel_failed"
  if (/service .*not found|StartService|InvalidService|Could not start|unavailable/i.test(msg)) return "service_unavailable"
  if (/plist/i.test(msg)) return "plist_malformed"
  return "bad_request"
}

// ── canonical service names (single source of truth) ──────────────────────────

export const IOS_DEV_SERVICE = {
  instruments: "com.apple.instruments.dtservicehub",       // direct RSD (like testmanagerd)
  osTraceRelay: "com.apple.os_trace_relay",                 // classic Lockdown
  pcapd: "com.apple.pcapd",                                 // classic Lockdown
  screenshotr: "com.apple.mobile.screenshotr",              // DDI-gated (RSD when mounted)
  mobilebackup2: "com.apple.mobilebackup2",                 // classic DeviceLink
  axAudit: "com.apple.accessibility.axAuditDaemon.remoteserver", // RSD (runner-free AX)
} as const

/** Instruments DTX channel identifiers. */
export const INSTRUMENTS_CHANNEL = {
  deviceinfo: "com.apple.instruments.server.services.deviceinfo",
  sysmontap: "com.apple.instruments.server.services.sysmontap",
  processcontrol: "com.apple.instruments.server.services.processcontrol",
  location: "com.apple.instruments.server.services.LocationSimulation",
  graphics: "com.apple.instruments.server.services.graphics.opengl",
} as const

// ── output shapes ─────────────────────────────────────────────────────────────

export type BufferedEvent = { at: string; [k: string]: unknown }

export type StreamDrain = {
  events: BufferedEvent[]
  dropped: number
  retainedFrom?: string
}
