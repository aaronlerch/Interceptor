/**
 * cli/commands/eval.ts — eval
 */

import { normalizeArgsSplit } from "../normalize"

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[], positionalCount?: number): Action {
  const normalized = positionalCount === undefined ? normalizeArgsSplit(filtered) : { argv: filtered, positionalCount }
  const end = normalized.positionalCount + 1
  const flags = normalized.argv.slice(end)
  const world = flags.includes("--main") ? "MAIN" : "ISOLATED"
  const code = normalized.argv.slice(1, end).join(" ")
  if (!code.trim()) throw new Error("eval requires JavaScript code. Usage: interceptor eval <code> [--main] [--no-reload] [--allow-csp-strip]")
  const action: Action = { type: "evaluate", code, world }
  // FORK-DELTA §2: opt-in to the CSP/Trusted-Types header strip. Off by
  // default; it removes the page's own Content-Security-Policy for the tab (see
  // evaluate.ts). `--allow-csp-strip` is declared in EVAL_BOOL.
  if (flags.includes("--allow-csp-strip")) action.allowCspStrip = true
  // --no-reload: refuse even the gated strip-and-reload recovery, so a stateful
  // page is never reloaded underneath the caller (upstream flag).
  if (flags.includes("--no-reload")) action.noCspReload = true
  return action
}
