import { setDomObserverActive } from "./dom-observer"

// Dormant-until-attached coordinator (isolated world).
//
// The background marks a tab "active" whenever a CLI/daemon command targets it
// and "inactive" after an idle timeout (background/tab-active.ts). This module
// receives that signal and:
//   1. connects/disconnects the DOM-dirty MutationObserver (this world), and
//   2. relays the state into the MAIN world via DOM CustomEvents, which is the
//      only channel the page-world inject scripts can hear (same pattern as the
//      existing `__interceptor_set_overrides` bridge).
//
// MAIN-world consumers:
//   - inject-net.ts   listens for `__interceptor_set_active` → full vs metadata-only capture
//   - inject-canvas.ts listens for `__interceptor_set_active` (disable on inactive)
//                      and `__interceptor_canvas_set` (enable for canvas/scene commands)

let active = false

function relayToMainWorld(isActive: boolean, enableCanvas: boolean): void {
  try {
    document.dispatchEvent(new CustomEvent("__interceptor_set_active", { detail: { active: isActive } }))
  } catch {}
  if (enableCanvas) {
    try {
      document.dispatchEvent(new CustomEvent("__interceptor_canvas_set", { detail: { active: true } }))
    } catch {}
  }
}

export function applyActiveState(isActive: boolean, enableCanvas: boolean): void {
  active = isActive
  setDomObserverActive(isActive)
  relayToMainWorld(isActive, enableCanvas)
}

export function isActive(): boolean { return active }

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object" || msg.type !== "interceptor_set_active") return
  try {
    applyActiveState(msg.active === true, msg.enableCanvas === true)
  } catch {}
  // Fire-and-forget broadcast — no response needed. Do not return true.
})
