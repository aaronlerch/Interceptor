// screenshot-cors.ts
//
// Per-tab session DNR rule that grants CORS clearance to subresource fetches
// during the lifetime of a single screenshot operation. Mirrors the lifecycle
// pattern used by `evaluate.ts`'s buildCspBypassRule / installCspBypassForTab,
// just with a different rule-ID base and different header set.
//
// Lifecycle:
//   const installed = await installScreenshotCorsRule(tabId)
//   try { ... do the screenshot ... }
//   finally { await uninstallScreenshotCorsRule(tabId) }
//
// Blast radius:
//   - tabIds: [tabId] — only the tab being screenshotted is affected.
//   - resourceTypes: image, font, media, stylesheet, xmlhttprequest — only
//     subresources the screenshot library re-fetches. main_frame and sub_frame
//     are intentionally excluded so the page's own CSP / COEP / frame-options
//     behavior is not modified.
//   - Session rule (not dynamic): the rule is in-memory only and does not
//     persist across browser restarts.
//
// Tradeoff:
//   - `Access-Control-Allow-Credentials` is removed (not set to "false")
//     because spec-compliant browsers reject `ACAO: *` paired with
//     `ACAC: true`. Sites with credentialed cross-origin XHRs in flight
//     during the screenshot will see those requests behave as Origin-
//     restricted for the duration of the capture.

const SCREENSHOT_CORS_RULE_ID_BASE = 920_000

export function buildScreenshotCorsRule(tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: SCREENSHOT_CORS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      responseHeaders: [
        { header: "access-control-allow-origin", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "*" },
        { header: "access-control-allow-credentials", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
        { header: "cross-origin-resource-policy", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "cross-origin" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: [
        "image" as chrome.declarativeNetRequest.ResourceType,
        "font" as chrome.declarativeNetRequest.ResourceType,
        "media" as chrome.declarativeNetRequest.ResourceType,
        "stylesheet" as chrome.declarativeNetRequest.ResourceType,
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType
      ]
    }
  }
}

// Per-tab refcount. The rule ID is keyed on tabId, so two concurrent
// screenshots of the SAME tab share one DNR rule. Without refcounting, the
// first to finish would uninstall the rule out from under the second — its
// in-flight subresource fetches would lose ACAO:* and taint/fail the render.
// install increments; uninstall decrements and only removes the rule when the
// last concurrent operation on that tab releases it. Different tabs are
// independent (distinct rule IDs and distinct counts).
const corsRuleRefcount = new Map<number, number>()

export async function installScreenshotCorsRule(tabId: number): Promise<void> {
  const prev = corsRuleRefcount.get(tabId) ?? 0
  corsRuleRefcount.set(tabId, prev + 1)
  // Rule is idempotent (removeRuleIds + addRules), so re-installing on a nested
  // acquire is harmless — but only the first acquire needs to touch DNR.
  if (prev === 0) {
    const rule = buildScreenshotCorsRule(tabId)
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [rule.id],
        addRules: [rule]
      })
    } catch (err) {
      // Roll back only THIS acquire's increment, not the whole entry — a
      // concurrent same-tab acquire may have already bumped the count while this
      // install was in flight, and wiping the map would strand it. Decrement by
      // one; delete only if that leaves zero. Callers place install OUTSIDE
      // their try/finally, so a throw here means uninstall won't run for this
      // acquire, which is why we must undo its increment here.
      const cur = corsRuleRefcount.get(tabId) ?? 0
      if (cur <= 1) corsRuleRefcount.delete(tabId)
      else corsRuleRefcount.set(tabId, cur - 1)
      throw err
    }
  }
}

export async function uninstallScreenshotCorsRule(tabId: number): Promise<void> {
  const prev = corsRuleRefcount.get(tabId) ?? 0
  // Only the LAST concurrent operation on this tab tears the rule down.
  if (prev > 1) {
    corsRuleRefcount.set(tabId, prev - 1)
    return
  }
  corsRuleRefcount.delete(tabId)
  const ruleId = SCREENSHOT_CORS_RULE_ID_BASE + tabId
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    })
  } catch {
    // best-effort teardown — never let a cleanup failure mask the original
    // screenshot result
  }
}
