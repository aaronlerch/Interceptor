/**
 * shared/ios-web.ts — types, action set, error codes, and pure helpers for the
 * iOS WebKit-inspection ("ios web") surface.
 *
 * The web lane is a SIBLING of the native XCUITest lane in shared/ios-device.ts:
 * it reuses the `ios:<udid>` device context but adds its own opaque target IDs
 * (`iwt_…`) and web-session IDs (`iws_…`) plus `wN` DOM refs (distinct from the
 * native `eN` refs). Web actions must never fall through to the native runner's
 * `executeVerb`/`ensureRunner`; the daemon router tests IOS_WEB_ACTION_TYPES
 * BEFORE the broad `ios:`-context fallback.
 *
 * Dependency-free (no Bun/daemon imports) so it can be unit tested and imported
 * from both cli and daemon. Mirrors shared/ios-device.ts.
 */

// ── action set (explicit, tested BEFORE the broad ios: fallback) ──────────────

/**
 * Every daemon action the `ios web` surface dispatches. Console/network collapse
 * their start|log|stop into one action type carrying `operation`. `targets
 * --watch` stays a CLI polling mode, not a distinct action.
 */
export const IOS_WEB_ACTION_TYPES = new Set<string>([
  "ios_web_targets",
  "ios_web_attach",
  "ios_web_detach",
  "ios_web_status",
  "ios_web_explain",
  "ios_web_read",
  "ios_web_text",
  "ios_web_find",
  "ios_web_inspect",
  "ios_web_eval",
  "ios_web_call",
  "ios_web_click",
  "ios_web_type",
  "ios_web_keys",
  "ios_web_scroll",
  "ios_web_calibrate",
  "ios_web_console",
  "ios_web_network",
  "ios_web_screenshot",
])

/** Actions that need a live web session (attach must have run). Everything else
 *  is a web lifecycle/diagnostic action that resolves a device on its own. */
export const IOS_WEB_SESSION_ACTION_TYPES = new Set<string>([
  "ios_web_detach", "ios_web_read", "ios_web_text", "ios_web_find", "ios_web_inspect",
  "ios_web_eval", "ios_web_call", "ios_web_click", "ios_web_type", "ios_web_keys",
  "ios_web_scroll", "ios_web_calibrate", "ios_web_console", "ios_web_network",
])

/** Actions that require the native XCUITest runner (screenshot, native input,
 *  calibration). Reported via nativeLaneAvailable / native_lane_unavailable. */
export const IOS_WEB_NATIVE_LANE_ACTION_TYPES = new Set<string>([
  "ios_web_screenshot", "ios_web_calibrate",
])

// ── identifiers ───────────────────────────────────────────────────────────────

export const IOS_WEB_TARGET_PREFIX = "iwt_"
export const IOS_WEB_SESSION_PREFIX = "iws_"
export const IOS_WEB_REF_PREFIX = "w"       // wN — web DOM ref (native uses eN)

export function isWebTargetId(id: string | undefined): id is string {
  return typeof id === "string" && id.startsWith(IOS_WEB_TARGET_PREFIX)
}
export function isWebSessionId(id: string | undefined): id is string {
  return typeof id === "string" && id.startsWith(IOS_WEB_SESSION_PREFIX)
}
/** A web ref is `w` + digits (e.g. "w1", "w42"). Native refs are `eN`. */
export function isWebRef(ref: string | undefined): ref is string {
  return typeof ref === "string" && /^w\d+$/.test(ref)
}
/** A native XCUITest ref is `e` + digits. Guards against cross-resolution. */
export function isNativeRef(ref: string | undefined): ref is string {
  return typeof ref === "string" && /^e\d+$/.test(ref)
}
export function webRef(n: number): string {
  return `${IOS_WEB_REF_PREFIX}${n}`
}

/** Mint an opaque handle from caller-supplied random hex (keeps this module pure). */
export function mintTargetId(randomHex: string): string {
  return IOS_WEB_TARGET_PREFIX + randomHex
}
export function mintSessionId(randomHex: string): string {
  return IOS_WEB_SESSION_PREFIX + randomHex
}

// ── protocol variants ─────────────────────────────────────────────────────────

/**
 * WIR socket-setup shapes. The iOS 26 Appium fix proved the setup fields changed
 * enough to silently drop commands: omit WIRPageIdentifierKey when the page ID is
 * absent/empty/non-numeric and send WIRMessageDataTypeChunkSupportedKey:0.
 */
export type WirSetupVariant = "classic-page-id" | "optional-page-id-no-chunks"

/** Ordered setup-variant candidates given a listing's page id and OS build. The
 *  first is tried, and on failure (before any mutating call) the other once. */
export function setupVariantCandidates(devicePageId: number | null | undefined): WirSetupVariant[] {
  // A finite numeric page id → classic first; otherwise the modern no-chunks
  // shape must lead (classic cannot express a missing page id).
  return isFinitePageId(devicePageId)
    ? ["classic-page-id", "optional-page-id-no-chunks"]
    : ["optional-page-id-no-chunks", "classic-page-id"]
}

export function isFinitePageId(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/**
 * Inner WIP envelope. Modern WebKit inserts a Target multiplexing layer; older
 * builds speak WIP directly on the forwarded socket. The attach probe decides.
 */
export type WipEnvelopeMode = "direct" | "target-multiplexed"

/** Transport that carried the WIR service socket. */
export type WirTransport = "rsd-shim" | "classic-lockdown"

// ── target / application / session shapes ─────────────────────────────────────

export type IosWebTargetType =
  | "web-page"
  | "web-view"        // inspectable WKWebView
  | "javascript"      // JSContext
  | "service-worker"
  | "web-app"         // Home Screen web app
  | "extension"       // Web Extension content/background/pop-up
  | "safari-view"     // SFSafariViewController (discovery-driven)
  | "other"

export type IosWebTarget = {
  /** Daemon-generated opaque handle for one listing entry. Not derived from URL/title/bundle. */
  targetId: string
  /** Finite numeric page id when the listing supplies one; null otherwise (never guessed). */
  devicePageId: number | null
  type: IosWebTargetType
  title?: string
  url?: string
  inspectable: boolean
}

export type IosWebApplication = {
  /** Opaque device-supplied application identifier (WIRApplicationIdentifierKey). */
  applicationId: string
  bundleId?: string
  name?: string
  active?: boolean
  proxy?: boolean
  targets: IosWebTarget[]
}

export type IosWebTargetsPayload = {
  deviceContextId: string
  transport: WirTransport | "unknown"
  applications: IosWebApplication[]
}

/** One inspectable domain's observed capability ledger. Per-session, never global. */
export type IosWebDomainCapability = {
  enabled: boolean
  methodsObserved: string[]
  unavailableMethods: string[]
}

export type IosWebCapabilities = {
  targetType: string
  setupVariant: WirSetupVariant
  envelopeMode: WipEnvelopeMode
  domains: Record<string, IosWebDomainCapability>
  domRead: boolean
  runtimeEvaluate: boolean
  consoleEvents: boolean
  networkEvents: boolean
  debugger: boolean
  accessibility: boolean
  nativeLane: boolean
  nativeMappingCalibrated: boolean
  screenshot: "native-runner" | "unavailable"
}

export function blankCapabilities(
  targetType: string,
  setupVariant: WirSetupVariant,
  envelopeMode: WipEnvelopeMode,
): IosWebCapabilities {
  return {
    targetType,
    setupVariant,
    envelopeMode,
    domains: {},
    domRead: false,
    runtimeEvaluate: false,
    consoleEvents: false,
    networkEvents: false,
    debugger: false,
    accessibility: false,
    nativeLane: false,
    nativeMappingCalibrated: false,
    screenshot: "unavailable",
  }
}

export type IosWebResult = { success: boolean; error?: string; data?: unknown }

// ── stable error codes + guidance ─────────────────────────────────────────────

export type IosWebErrorCode =
  | "device_not_found"
  | "device_locked"
  | "device_unpaired"
  | "web_inspector_disabled"
  | "webinspector_service_unavailable"
  | "no_inspectable_targets"
  | "target_not_exposed"
  | "target_closed"
  | "target_busy"
  | "target_attach_unconfirmed"
  | "wir_setup_failed"
  | "wir_malformed_frame"
  | "wip_timeout"
  | "wip_method_unavailable"
  | "stale_web_ref"
  | "native_lane_unavailable"
  | "native_mapping_unavailable"
  | "buffer_overflow"
  | "dom_unavailable"
  | "session_not_found"
  | "invalid_web_ref"
  | "bad_request"

const NEXT_STEP: Record<IosWebErrorCode, string> = {
  device_not_found: "Run 'interceptor ios devices'; pick from the listed candidates.",
  device_locked: "Unlock the device and retry.",
  device_unpaired: "Unlock the device, connect it by cable, and accept Trust This Computer.",
  web_inspector_disabled: "Enable Settings > Apps > Safari > Advanced > Web Inspector on the device.",
  webinspector_service_unavailable: "No supported Web Inspector service opened; see the OS/build and attempted service names.",
  no_inspectable_targets: "Open or foreground a Safari page (or your app's inspectable WKWebView) and re-run.",
  target_not_exposed: "The app must set WKWebView.isInspectable = true; the target may also have ended.",
  target_closed: "The page/context/worker ended — re-run 'ios web targets'.",
  target_busy: "Close the other inspector, or pass --replace for an Interceptor-owned session.",
  target_attach_unconfirmed: "Close other inspectors, refresh targets, then inspect 'ios web explain' setup diagnostics.",
  wir_setup_failed: "No inner protocol response after the known setup variants; capture a sanitized diagnostic fixture.",
  wir_malformed_frame: "The WIR frame was invalid; the affected session was closed.",
  wip_timeout: "The inner request produced no response within its timeout.",
  wip_method_unavailable: "The target does not implement that method (capability updated).",
  stale_web_ref: "The document changed — re-run 'ios web read' to mint fresh refs.",
  native_lane_unavailable: "This needs the XCUITest runner; complete 'interceptor ios setup/install' first.",
  native_mapping_unavailable: "Native mapping is not calibrated/current — recalibrate or use --mode dom.",
  buffer_overflow: "Events were dropped by the bounded store; see the dropped count and retained range.",
  dom_unavailable: "Neither DOM.getDocument nor the runtime serializer succeeded on this target.",
  session_not_found: "No matching web session — run 'ios web attach <target-id>' first.",
  invalid_web_ref: "Expected a web ref like 'w3'. Native 'eN' refs are not valid here.",
  bad_request: "Check the command arguments and try again.",
}

/** Build the machine-readable error payload the CLI renders. */
export function webError(code: IosWebErrorCode, error?: string, extra?: Record<string, unknown>): IosWebResult {
  return {
    success: false,
    error: error ?? code.replace(/_/g, " "),
    data: { code, next: NEXT_STEP[code], ...(extra ?? {}) },
  }
}

// ── redaction (pure — tested directly) ────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "x-auth-token", "x-amz-security-token",
])
const REDACTED = "«redacted»"

/** Redact sensitive request/response headers by name (case-insensitive). */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v
  }
  return out
}

const DEFAULT_SENSITIVE_QUERY_KEYS = new Set([
  "access_token", "token", "id_token", "refresh_token", "code",
  "api_key", "apikey", "key", "password", "secret", "client_secret", "sig", "signature",
])

/**
 * Redact URL user-info and sensitive query values without discarding structure.
 * Malformed URLs are returned unchanged except for an obvious `user:pass@` strip.
 *
 */
export function redactUrl(raw: string | undefined, extraKeys: Iterable<string> = []): string | undefined {
  if (!raw) return raw
  const keys = new Set([...DEFAULT_SENSITIVE_QUERY_KEYS, ...[...extraKeys].map((k) => k.toLowerCase())])
  try {
    const u = new URL(raw)
    if (u.username || u.password) { u.username = u.username ? REDACTED : ""; u.password = "" }
    for (const k of [...u.searchParams.keys()]) {
      if (keys.has(k.toLowerCase())) u.searchParams.set(k, REDACTED)
    }
    return u.toString()
  } catch {
    // Not a parseable absolute URL — strip an inline userinfo if present.
    return raw.replace(/\/\/[^/@\s]+@/, `//${REDACTED}@`)
  }
}

// ── action-mode contract (click/type/keys/scroll) ─────────────────────────────

export type IosWebActionMode = "auto" | "dom" | "native"

export type IosWebActionModeReport = {
  requestedMode: IosWebActionMode
  modeUsed: "dom" | "native"
  trustedInput: boolean
  nativeLaneAvailable: boolean
  fallbackReason?: string
}
