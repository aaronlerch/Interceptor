// Safari Web Extension background service worker — native-relay transport.
//
// Safari has no chrome.debugger / tabGroups / power / offscreen / tabCapture,
// so this entrypoint registers only the Safari-safe listeners. Safari extension
// JavaScript cannot open the direct loopback WebSocket that Chromium builds use,
// so the documented sendNativeMessage path long-polls the containing appex,
// whose network.client sandbox owns the daemon WebSocket.
//
// The context id defaults to "safari" so this instance coexists with Chrome /
// Brave in the daemon's extensionWsMap and is addressable via `--context safari`.

import {
  configureTransport,
  connectSafariNativeRelayChannel,
  registerAlarmListener,
  registerSwKeepaliveListener,
  registerStorageContextListener,
} from "./background/transport"
import { registerDelegationListeners } from "./background/delegation"
import { initializeActionRouter } from "./background/router"

function runOptionalStartupStep(name: string, step: () => void): void {
  try {
    step()
  } catch (err) {
    console.warn(`[interceptor] Safari startup step '${name}' unavailable:`, err)
  }
}

function addOptionalRuntimeListener(
  name: string,
  event: { addListener?: (listener: () => void) => void } | undefined,
): void {
  if (typeof event?.addListener !== "function") return
  runOptionalStartupStep(name, () => event.addListener?.(connectSafariNativeRelayChannel))
}

// Configure transport through module state, not globals. Static imports execute
// before the body of an ES module, so globals assigned above imports cannot
// reliably govern imported-module startup behavior.
configureTransport({ contextId: "safari", safariNativeRelay: true })

// Establish the control-plane channel before optional capability listeners.
// A Safari API mismatch may degrade one capability, but must never hide the
// entire browser context from `interceptor contexts`.
connectSafariNativeRelayChannel()

// Safari-safe listeners only. Delegation touches chrome.contextMenus/commands,
// which Safari supports on macOS but may be gated by the user's permission
// grant — guard so a missing API can never kill the service worker at startup.
runOptionalStartupStep("action router", initializeActionRouter)
runOptionalStartupStep("alarm keepalive", registerAlarmListener)
runOptionalStartupStep("service-worker keepalive", registerSwKeepaliveListener)
runOptionalStartupStep("context storage", registerStorageContextListener)
runOptionalStartupStep("delegation", registerDelegationListeners)

const runtime = (chrome as unknown as { runtime?: typeof chrome.runtime }).runtime
addOptionalRuntimeListener("runtime.onInstalled", runtime?.onInstalled)
addOptionalRuntimeListener("runtime.onStartup", runtime?.onStartup)
