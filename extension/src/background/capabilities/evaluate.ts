import { IK_TT_POLICY, TT_POLICY_NAME } from "../../inject-keys"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

const CSP_BYPASS_RULE_ID_BASE = 910_000

export function isTrustedTypesError(error: string | undefined): boolean {
  if (!error) return false
  return /trusted ?types|trustedscript|require-trusted-types-for|createPolicy/i.test(error)
}

export function isCspUnsafeEvalError(error: string | undefined): boolean {
  if (!error) return false
  if (isTrustedTypesError(error)) return false
  return /content security policy|script-src|unsafe-eval/i.test(error)
    && /eval|evaluating a string|string as javascript/i.test(error)
}

export function isCspEvalError(error: string | undefined): boolean {
  if (!error) return false
  return isTrustedTypesError(error) || isCspUnsafeEvalError(error)
}

/**
 * Build the per-tab CSP-strip rule.
 *
 * `host` scopes it to the site the operator actually opted in for. Without it
 * the rule follows the TAB, so a tab stripped for one site keeps loading every
 * later site in it without CSP — the operator consented to one page and paid
 * for wherever that tab wandered next. Passing the host is not always possible
 * (the tab may be mid-navigation), and a tab-only rule is still what upstream
 * ships, so it remains the fallback rather than an error.
 */
export function buildCspBypassRule(
  tabId: number,
  host?: string
): chrome.declarativeNetRequest.Rule {
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    tabIds: [tabId],
    resourceTypes: ["main_frame", "sub_frame"]
  }
  if (host) condition.requestDomains = [host]
  return {
    id: CSP_BYPASS_RULE_ID_BASE + tabId,
    priority: 10,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition
  }
}

/** Highest tab id the rule-id scheme can encode without colliding upward. */
const CSP_BYPASS_RULE_ID_MAX = CSP_BYPASS_RULE_ID_BASE + 99_999

/**
 * Drop the CSP-strip rule for one tab.
 *
 * Called when the tab closes. This is not tidiness: Chrome REUSES tab ids, and
 * the rule is a session rule that nothing else removes, so a stripped tab that
 * closes leaves its id armed — and the next tab Chrome happens to give that id
 * loads without CSP, on a site nobody opted in for, with no way to notice.
 */
export async function removeCspBypassForTab(tabId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [CSP_BYPASS_RULE_ID_BASE + tabId]
  })
}

/**
 * Clear every CSP-strip rule this extension may have left installed.
 *
 * Session rules outlive the service worker, so a worker restart within the same
 * browser session comes back to whatever the previous one armed — for tabs that
 * may no longer exist. Purging at startup makes "no eval has asked for a strip
 * since this worker started" mean "no strip is installed".
 */
export async function purgeCspBypassRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules()
  const ours = existing
    .filter((r) => r.id >= CSP_BYPASS_RULE_ID_BASE && r.id <= CSP_BYPASS_RULE_ID_MAX)
    .map((r) => r.id)
  if (ours.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ours })
  }
}

/**
 * Wire the cleanup to the tab lifecycle. Called once from the background entry
 * point — not at module import, because this module is imported by tests that
 * have no `chrome`.
 */
export function registerCspBypassCleanup(): void {
  void purgeCspBypassRules().catch(() => undefined)
  chrome.tabs.onRemoved.addListener((tabId) => {
    void removeCspBypassForTab(tabId).catch(() => undefined)
  })
}

// Chrome 152 returns NEITHER `error` NOR `result` when a user script throws,
// rejects, or fails to parse (live 2026-09-07: `eval --main 'throw new Error("boom")'`
// came back success:true, data:null). The raw code cannot report its own failure,
// so it is wrapped textually — no eval, so page CSP stays out of it:
//   expression  — async IIFE + try/catch: catches throws and rejections,
//                 supports `await`, clones the value so it survives serialization.
//   statement   — top-level try/catch that keeps the script completion value
//                 (`const x = 41; x + 1` → 42, as before) for non-expression code.
//   probe       — an undefined result after `statement` is either an undefined
//                 completion or a parse failure; the nonce flag `statement` sets
//                 tells them apart without running the code again.
//   asyncBody   — last resort for statement code that needs `await`/`return`;
//                 only reached when `statement` did not parse, so nothing runs twice.
const USER_SCRIPT_CLONE = `const __c=v=>{if(v==null)return v;const t=typeof v;if(t==="string"||t==="number"||t==="boolean")return v;if(t==="bigint")return v.toString();try{return JSON.parse(JSON.stringify(v))}catch{try{return String(v)}catch{return null}}};`
const USER_SCRIPT_CATCH = `catch(e){return{__ik:1,ok:false,error:String(e&&e.message||e)}}`
const USER_SCRIPT_RAN_KEY = "interceptor.eval.ran"
export function userScriptForms(code: string, nonce: string): { expression: string; statement: string; probe: string; asyncBody: string } {
  const key = `Symbol.for(${JSON.stringify(USER_SCRIPT_RAN_KEY)})`
  return {
    expression: `(async()=>{${USER_SCRIPT_CLONE}try{return{__ik:1,ok:true,value:__c(await (async()=>(\n${code}\n))())}}${USER_SCRIPT_CATCH}})()`,
    statement: `globalThis[${key}]=${JSON.stringify(nonce)};try{\n${code}\n}catch(e){({__ik:1,ok:false,error:String(e&&e.message||e)})}`,
    probe: `(()=>{const k=${key};const r=globalThis[k];delete globalThis[k];return r===${JSON.stringify(nonce)}})()`,
    asyncBody: `(async()=>{${USER_SCRIPT_CLONE}try{\n${code}\n;return{__ik:1,ok:true}}${USER_SCRIPT_CATCH}})()`,
  }
}
const USER_SCRIPT_SYNTAX_ERROR = "SyntaxError: the code did not parse as an expression or as statements (or returned a value the browser could not serialize). Check quoting; multi-statement code that needs await should end with `return <value>`."

function unwrapUserScriptResult(raw: unknown): ActionResult {
  const r = raw as { __ik?: number; ok?: boolean; value?: unknown; error?: string } | null
  if (r && typeof r === "object" && r.__ik === 1) {
    return r.ok ? { success: true, data: r.value } : { success: false, error: r.error ?? "eval failed" }
  }
  return { success: true, data: raw }
}

async function executeWithUserScripts(
  tabId: number,
  world: "MAIN" | "USER_SCRIPT",
  code: string,
  frameId?: number
): Promise<{ available: boolean; result?: ActionResult; reason?: string }> {
  try {
    if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") {
      return { available: false, reason: "chrome.userScripts.execute is unavailable (check Allow User Scripts and browser support)" }
    }
    const forms = userScriptForms(code, crypto.randomUUID())
    const run = async (js: string) => {
      const results = await chrome.userScripts.execute({
        target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
        js: [{ code: js }],
        world
      })
      // Safari targets the requested frame but omits frameId from its sole result.
      // Keep rejecting an explicit mismatched frame while accepting that API shape.
      return frameId === undefined
        ? results[0]
        : results.find(r => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined)
    }
    const settled = (first: { error?: string; result?: unknown } | undefined) => {
      if (!first) return { available: true, result: { success: false, error: `no result for frame ${frameId ?? 0}` } }
      if (first.error) return { available: true, result: { success: false, error: first.error } }
      return undefined
    }
    let first = await run(forms.expression)
    let done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    first = await run(forms.statement)
    done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    const ran = await run(forms.probe)
    if (ran?.result === true) return { available: true, result: { success: true, data: first!.result } }
    first = await run(forms.asyncBody)
    done = settled(first)
    if (done) return done
    if (first!.result !== undefined && first!.result !== null) return { available: true, result: unwrapUserScriptResult(first!.result) }
    return { available: true, result: { success: false, error: USER_SCRIPT_SYNTAX_ERROR } }
  } catch (err) {
    const message = (err as Error).message || String(err)
    if (/userScripts|Developer mode|Allow User Scripts|permission|undefined/i.test(message)) {
      return { available: false, reason: message }
    }
    return { available: true, result: { success: false, error: message } }
  }
}

async function executeEval(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  code: string,
  frameId?: number
): Promise<ActionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
    world,
    args: [code, IK_TT_POLICY, TT_POLICY_NAME],
    func: async (c: string, ttKey: string, ttName: string) => {
      const TT = Symbol.for(ttKey)
      function clone(v: unknown): unknown {
        if (v === null || v === undefined) return v
        const t = typeof v
        if (t === "string" || t === "number" || t === "boolean") return v
        if (t === "bigint") return (v as bigint).toString()
        try {
          return JSON.parse(JSON.stringify(v))
        } catch {
          try { return String(v) } catch { return null }
        }
      }
      try {
        const w = window as any
        let source = c
        if (w.trustedTypes) {
          if (!w[TT]) {
            try {
              w[TT] = w.trustedTypes.createPolicy(ttName, {
                createScript: (s: string) => s
              })
            } catch {
              try {
                w[TT] = w.trustedTypes.createPolicy(ttName + "-" + Date.now(), {
                  createScript: (s: string) => s
                })
              } catch {}
            }
          }
          if (w[TT]) {
            source = w[TT].createScript(c)
          }
        }
        let r: unknown = (0, eval)(source as string)
        if (r && typeof (r as any).then === "function") {
          r = await (r as Promise<unknown>)
        }
        return { success: true, data: clone(r) }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    }
  })
  const first = frameId === undefined
    ? results[0]
    : results.find(r => r.frameId === frameId) ?? (results.length === 1 && results[0]?.frameId === undefined ? results[0] : undefined)
  return (first?.result as ActionResult) ?? { success: false, error: `no result for frame ${frameId ?? 0}` }
}

async function installCspBypassForTab(tabId: number): Promise<void> {
  // Scope the strip to the host currently loaded in the tab, so it covers the
  // page the operator opted in for and not the tab's whole future.
  let host: string | undefined
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url) host = new URL(tab.url).hostname
  } catch {
    // Mid-navigation, or a tab we cannot read. Fall back to the tab-only rule.
  }
  const rule = buildCspBypassRule(tabId, host)
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [rule.id],
    addRules: [rule]
  })
}

async function reloadTabForCspRetry(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache: true })
  await waitForTabLoad(tabId, 15_000)
}

/** Error returned when step 3 is reached without an explicit operator opt-in. */
export const CSP_STRIP_REFUSED =
  "MAIN-world eval is blocked by this page's Content-Security-Policy / Trusted Types. " +
  "Stripping the page's CSP header would disable the site's own XSS defenses for this tab, " +
  "so it is off by default. Re-run with --allow-csp-strip if you intend that."

/**
 * Run a per-tab evaluation through the CSP / Trusted-Types escalation chain:
 *   1. try the `run` callback in the requested world
 *   2. on any unsafe-eval CSP / TT failure (MAIN), strip the page's CSP response
 *      header via a per-tab declarativeNetRequest rule + reload, then retry
 *
 * Steps 1-2 are always available: they work *within* the page's policy and take
 * nothing away from it. Step 3 does not — it removes `content-security-policy`
 * (and `-report-only`, and with them `require-trusted-types-for`) from the
 * response for this tab, so a logged-in page loses its own XSS defenses for as
 * long as the session rule is installed. That is an operator decision, not a
 * default: step 3 requires `opts.allowCspStrip`, threaded from the CLI's
 * explicit `--allow-csp-strip` flag. Without it the chain stops at step 2 and
 * returns CSP_STRIP_REFUSED.
 *
 * `run` performs the actual in-page work and returns an ActionResult — e.g.
 * clone-eval for the `evaluate` capability, or blob-URL normalization for the
 * binary sink. On the fallback / bypass paths the successful result's `data` is
 * wrapped as `{ value, cspBypassApplied, originalError }`;
 * callers that need the raw value should unwrap `data.value` when present.
 *
 * This is the shared bypass core (lifted out of handleEvaluateActions) so every
 * capability that evals into a page inherits the same strict-CSP / Trusted-Types
 * handling — and the same opt-in gate — instead of reimplementing a weaker one.
 *
 * The rule installed by step 3 is scoped to the tab AND the host, and is
 * removed when the tab closes (see registerCspBypassCleanup). It is deliberately
 * NOT removed the moment the retry succeeds: the document is already loaded
 * without CSP by then, so removing it would change nothing for the current page
 * while forcing a fresh strip-and-reload on every later navigation in a flow the
 * operator has already opted into.
 */
export async function runWithCspStripBypass(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  run: (tabId: number, world: "MAIN" | "ISOLATED") => Promise<ActionResult>,
  opts: { allowCspStrip?: boolean } = {}
): Promise<ActionResult> {
  const first = await run(tabId, world)
  if (first.success || world !== "MAIN") {
    return first
  }

  // Upstream 0.25.0: eval never silently switches world — a MAIN request that
  // fails under Trusted-Types/CSP is not retried in ISOLATED (whose results
  // have different semantics). This aligns with the fork's honest-results
  // stance; strict-CSP readability is already served by the userScripts attempt
  // in handleEvaluateActions before this point. See test/eval-contract.test.ts.
  if (!isCspUnsafeEvalError(first.error) && !isTrustedTypesError(first.error)) {
    return first
  }

  // Header-strip gate. Everything above worked inside the page's policy; from
  // here we would take the policy away. Refuse unless the operator asked.
  if (!opts.allowCspStrip) {
    return {
      success: false,
      error: CSP_STRIP_REFUSED,
      data: {
        originalError: first.error,
        cspBypassApplied: false,
        cspStripAvailable: true
      }
    }
  }

  try {
    await installCspBypassForTab(tabId)
    await reloadTabForCspRetry(tabId)
  } catch (err) {
    return {
      success: false,
      error: `MAIN-world eval hit page CSP and automatic CSP bypass setup failed: ${(err as Error).message}`,
      data: { originalError: first.error, cspBypassAttempted: false }
    }
  }

  let retried: ActionResult
  try { retried = await run(tabId, "MAIN") }
  catch (err) { retried = { success: false, error: err instanceof Error ? err.message : String(err) } }
  if (retried.success) {
    return {
      ...retried,
      data: {
        value: retried.data,
        cspBypassApplied: true,
        originalError: first.error
      }
    }
  }

  return {
    success: false,
    error: retried.error || first.error || "MAIN-world eval failed after CSP bypass retry",
    data: {
      originalError: first.error,
      cspBypassApplied: true
    }
  }
}

export async function handleEvaluateActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type !== "evaluate") {
    return { success: false, error: `unknown evaluate action: ${action.type}` }
  }
  const code = action.code as string
  const frameId = action.frameId as number | undefined
  if (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) {
    return { success: false, error: "frameId must be a non-negative safe integer" }
  }
  if (typeof code !== "string" || !code.trim()) return { success: false, error: "evaluate requires JavaScript code" }
  const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
  const allowCspStrip = action.allowCspStrip === true
  const initialUserScriptWorld = world === "MAIN" ? "MAIN" : "USER_SCRIPT"
  const userScriptAttempt = await executeWithUserScripts(tabId, initialUserScriptWorld, code, frameId)
  if (userScriptAttempt.available && (world !== "MAIN" || !isCspEvalError(userScriptAttempt.result?.error))) {
    return userScriptAttempt.result ?? { success: false, error: "no result" }
  }
  // Trusted-Types / unsafe-eval CSP escalation now lives in the shared
  // runWithCspStripBypass core (see above) so `evaluate` and the binary sink
  // share one bypass implementation. The userScripts attempt above remains
  // evaluate-specific.
  try {
    const result = action.noCspReload === true
      ? await executeEval(tabId, world, code, frameId)
      : await runWithCspStripBypass(tabId, world, (t, w) => executeEval(t, w, code, frameId), { allowCspStrip })
    if (!result.success && world === "ISOLATED" && isCspEvalError(result.error)) {
      return {
        success: false,
        error: `Isolated eval is unavailable: ${userScriptAttempt.reason ?? "the userScripts execution failed"}. Enable Allow User Scripts for this extension and reload it, or explicitly use eval --main for page-world access.`,
        data: { originalError: result.error, requestedWorld: world, userScriptsAvailable: userScriptAttempt.available },
      }
    }
    return result
  } catch (err) {
    return { success: false, error: `eval in frame ${frameId ?? 0} failed: ${(err as Error).message}` }
  }
}
