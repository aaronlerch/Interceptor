// Dormant-until-attached: per-tab active-state broadcaster.
//
// Interceptor's content-script hooks (DOM-dirty observer, fetch/XHR body
// capture, canvas draw interception) are dormant by default and only do
// expensive work while a tab is actively being driven. This module is the
// background-side source of truth: every command that targets a tab marks it
// active and (re)arms an idle timer; when the timer fires with no further
// commands, the tab is told to go dormant again.
//
// The signal is a fire-and-forget `interceptor_set_active` message handled by
// content/active-state.ts, which toggles the observer and relays the state into
// the MAIN world for the inject scripts.

const ACTIVE_IDLE_MS = 45_000

const idleTimers = new Map<number, ReturnType<typeof setTimeout>>()

// canvas/scene commands additionally enable the canvas draw interceptor for the
// tab (it stays dormant for every other command so chart-heavy pages aren't taxed).
const CANVAS_ACTION = /^(canvas_|scene_)/

function send(tabId: number, msg: Record<string, unknown>): void {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => {
      // Swallow "receiving end does not exist" on tabs without a content script
      // (chrome://, freshly-created tabs, etc.) — the next command re-broadcasts.
      void chrome.runtime.lastError
    })
  } catch {}
}

export function markTabActive(tabId: number, actionType?: string): void {
  send(tabId, {
    type: "interceptor_set_active",
    active: true,
    enableCanvas: CANVAS_ACTION.test(actionType || ""),
  })

  const prev = idleTimers.get(tabId)
  if (prev) clearTimeout(prev)
  idleTimers.set(tabId, setTimeout(() => {
    idleTimers.delete(tabId)
    send(tabId, { type: "interceptor_set_active", active: false })
  }, ACTIVE_IDLE_MS))
}

export function markTabInactive(tabId: number): void {
  const t = idleTimers.get(tabId)
  if (t) { clearTimeout(t); idleTimers.delete(tabId) }
  send(tabId, { type: "interceptor_set_active", active: false })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const t = idleTimers.get(tabId)
  if (t) { clearTimeout(t); idleTimers.delete(tabId) }
})
