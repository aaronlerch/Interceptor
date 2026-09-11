/**
 * cli/commands/eval.ts — eval
 */

import { normalizeArgsSplit } from "../normalize"

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[], positionalCount?: number): Action {
  const normalized = positionalCount === undefined ? normalizeArgsSplit(filtered) : { argv: filtered, positionalCount }
  const end = normalized.positionalCount + 1
  const world = normalized.argv.slice(end).includes("--main") ? "MAIN" : "ISOLATED"
  // FORK-DELTA: opt-in to the CSP/Trusted-Types header strip. Off by default; it
  // removes the page's own Content-Security-Policy for the tab (see evaluate.ts).
  // `--allow-csp-strip` is declared in EVAL_BOOL, so it lands in the flag region.
  const allowCspStrip = normalized.argv.slice(end).includes("--allow-csp-strip")
  const code = normalized.argv.slice(1, end).join(" ")
  if (!code.trim()) throw new Error("eval requires JavaScript code. Usage: interceptor eval <code> [--main]")
  return { type: "evaluate", code, world, ...(allowCspStrip ? { allowCspStrip: true } : {}) }
}
