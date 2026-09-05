import { connectToHost, connectWsChannel, registerAlarmListener, registerSwKeepaliveListener, registerStorageContextListener } from "./background/transport"
import { registerCdpListeners } from "./background/cdp"
import { registerTabGroupListeners, ensureInterceptorGroup } from "./background/tab-group"
import { registerBrandTabGroup } from "./background/brand-tab-group"
import { registerTabLifecycle } from "./background/tab-lifecycle"
import { registerDelegationListeners } from "./background/delegation"
import { registerPowerIdleListeners } from "./background/keepawake"
import { initializeActionRouter } from "./background/router"

// Register all event listeners
initializeActionRouter()
registerCdpListeners()
registerTabGroupListeners()
registerAlarmListener()
registerSwKeepaliveListener()
registerStorageContextListener()
registerBrandTabGroup()
registerTabLifecycle()
registerDelegationListeners()
registerPowerIdleListeners()

// Startup connections
// ensureInterceptorGroup() is a floating promise here — nothing awaits it, so an
// unhandled rejection surfaces as "Uncaught (in promise)" in the service worker
// with a stack pointing at the function's own last line, which reads like a bug
// in group discovery rather than a missing catch at the call site.
//
// It rejects for a real and ordinary reason: onStartup/onInstalled fire while
// the profile can still have zero windows, and the window-scoped tabGroups APIs
// reject with "No current window" then (upstream issue #162). Group adoption is
// best-effort — the next tab_create re-discovers or creates the group — so the
// right handling is to note it and move on, not to let it escape.
const adoptGroupBestEffort = () =>
  void ensureInterceptorGroup().catch((err) =>
    console.warn("interceptor: deferred group adoption:", (err as Error)?.message ?? err),
  )

chrome.runtime.onInstalled.addListener(() => {
  connectToHost()
  connectWsChannel()
  adoptGroupBestEffort()
})
chrome.runtime.onStartup.addListener(() => {
  connectToHost()
  connectWsChannel()
  adoptGroupBestEffort()
})

connectToHost()
connectWsChannel()
