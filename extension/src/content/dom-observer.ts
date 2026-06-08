let domDirty = false

export function getDomDirty(): boolean { return domDirty }
export function setDomDirty(v: boolean) { domDirty = v }

// Dormant-until-attached: the DOM-dirty observer is NOT installed on page load.
// It fires on every subtree mutation, which on heavy React apps is pure
// main-thread churn while Interceptor is idle. The background broadcasts an
// active/inactive signal per tab (see background/tab-active.ts → content/active-state.ts);
// we only observe while that tab is actively being driven, and disconnect when
// it goes idle.
let domObserver: MutationObserver | null = null
let observing = false

function ensureObserver(): MutationObserver {
  if (!domObserver) {
    domObserver = new MutationObserver(() => {
      domDirty = true
    })
  }
  return domObserver
}

export function setDomObserverActive(active: boolean): void {
  if (active) {
    if (observing) return
    const observer = ensureObserver()
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
      observing = true
    }
  } else {
    if (domObserver && observing) {
      try { domObserver.disconnect() } catch {}
      observing = false
      // We're no longer watching, so any mutation during the dormant gap is
      // invisible to us. Conservatively mark dirty so the next `diff` recomputes
      // a real structural comparison instead of short-circuiting to "no changes".
      domDirty = true
    }
  }
}

export function isDomObserverActive(): boolean { return observing }

window.addEventListener("beforeunload", () => {
  if (domObserver) {
    try { domObserver.disconnect() } catch {}
    observing = false
  }
})
