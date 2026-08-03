/**
 * cli/commands/eval.ts — eval
 */

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[]): Action {
  const world = filtered.includes("--main") ? "MAIN" : "ISOLATED"
  // Opt-in to the CSP/Trusted-Types header strip. Off by default: it removes
  // the page's own Content-Security-Policy for the tab (see evaluate.ts).
  const allowCspStrip = filtered.includes("--allow-csp-strip")
  const code = filtered
    .slice(1)
    .filter(a => a !== "--main" && a !== "--allow-csp-strip")
    .join(" ")
  return { type: "evaluate", code, world, ...(allowCspStrip ? { allowCspStrip: true } : {}) }
}
