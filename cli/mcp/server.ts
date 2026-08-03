/**
 * cli/mcp/server.ts — build the Interceptor MCP server.
 *
 * Five router tools (browser / macos / read / local / raw) whose verb menus
 * are generated from the binary's own manifest, plus discovery resources for the
 * long tail. All execution flows through the subprocess adapter (§4); every call
 * is classified and gated by the operator allowlist (§7); content-bearing output
 * is fenced (§8).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { COMMAND_SPECS } from "../manifest"
import { VERSION } from "../version"
import { runInterceptor, warmDaemon, withGlobalFlags } from "./adapter"
import { toResult, type McpResult } from "./output"
import { classify, gate, parseAllow, READ_VERBS, type Surface } from "./tiers"

const CALL_TIMEOUT_MS = 660_000 // backstop above the CLI's own longest verb ceiling

// ── Verb menus ────────────────────────────────────────────────────────────────
// browser + local come from the authoritative manifest (auto-tracks the binary).
const BROWSER_VERBS = COMMAND_SPECS.filter(c => c.surface === "browser").map(c => ({ v: c.name, s: c.summary }))
const LOCAL_VERBS: { v: string; s: string }[] = [
  { v: "status", s: "daemon/bridge/extension health" },
  { v: "manifest", s: "machine-readable capability manifest" },
  { v: "diagnose", s: "post-failure snapshot" },
  { v: "init", s: "bootstrap the daemon" },
  { v: "skills", s: "list/link skill packs" },
  { v: "research", s: "deep-research playbook + ledger" },
  { v: "upgrade", s: "promote to full computer-use mode" },
  { v: "extensions", s: "list installed extensions" },
  { v: "contexts", s: "list connected browser contexts" },
  { v: "capabilities", s: "available domains + verbs" },
]

// macOS / iOS top-level verb menus (maintained against the CLI surface; full flag/
// sub-verb detail lives in the interceptor://help/macos resource).
const MACOS_VERBS: { v: string; s: string }[] = [
  { v: "tree", s: "AX tree" }, { v: "find", s: "search AX tree" }, { v: "inspect", s: "element details" },
  { v: "value", s: "get/set AX value (mutate)" }, { v: "action", s: "invoke AX action" }, { v: "focused", s: "focused element" },
  { v: "windows", s: "window list" }, { v: "text", s: "read element text" }, { v: "menu", s: "menu navigation" },
  { v: "apps", s: "running apps" }, { v: "app", s: "app activate/launch/quit/terminate" }, { v: "frontmost", s: "frontmost app" },
  { v: "click", s: "background click" }, { v: "type", s: "background type" }, { v: "keys", s: "key combo" },
  { v: "scroll", s: "scroll" }, { v: "resize", s: "resize window" }, { v: "move", s: "move window" }, { v: "drag", s: "drag" },
  { v: "screenshot", s: "capture screen/window/element" }, { v: "capture", s: "capture frame/stream" },
  { v: "listen", s: "speech recognition" }, { v: "vad", s: "voice activity detection" }, { v: "sounds", s: "sound classification" },
  { v: "vision", s: "OCR/faces/objects/barcode" }, { v: "nlp", s: "entities/sentiment/embed" }, { v: "ai", s: "on-device LLM" },
  { v: "sensitive", s: "sensitive-content detection" }, { v: "health", s: "system health" }, { v: "files", s: "recent/search files" },
  { v: "notifications", s: "post/list/tail notifications" }, { v: "clipboard", s: "read/write pasteboard" }, { v: "display", s: "list/set displays" },
  { v: "audio", s: "audio I/O" }, { v: "stream", s: "screen streaming" }, { v: "monitor", s: "multi-modal recording" },
  { v: "open", s: "activate+read (compound)" }, { v: "read", s: "read AX tree (compound)" }, { v: "act", s: "click/type+read (compound)" },
  { v: "fs", s: "read/write/search files" }, { v: "url", s: "HTTPS fetch" }, { v: "log", s: "unified log query" },
  { v: "script", s: "run AppleScript/OSA (exec)" }, { v: "intent", s: "structured Apple Events (exec)" },
  { v: "vm", s: "VirtualBuddy VM lifecycle" }, { v: "container", s: "run OCI container (exec)" },
  { v: "overlay", s: "HUD/panel overlays" }, { v: "pdf", s: "PDF read/annotate/merge" }, { v: "detect", s: "file-type detection" },
  { v: "translate", s: "translation" }, { v: "thumbnail", s: "thumbnails" }, { v: "auth", s: "LocalAuthentication" },
  { v: "calendar", s: "Calendar read/CRUD" }, { v: "reminders", s: "Reminders read/CRUD" }, { v: "contacts", s: "Contacts read/CRUD" },
  { v: "appintent", s: "App Intent donations" }, { v: "photos", s: "Photos read/CRUD" }, { v: "maps", s: "Maps search/directions" },
  { v: "location", s: "location services" }, { v: "music", s: "Music library/playback" }, { v: "share", s: "share menu (exfil)" },
  { v: "update", s: "Sparkle updates" }, { v: "trust", s: "TCC prompts" }, { v: "tcc", s: "TCC status/profile" },
  { v: "runtime", s: "in-process app runtime (exec)" }, { v: "cdp", s: "Electron/Chromium CDP" },
]

function foldMenu(items: { v: string; s: string }[]): string {
  return items.map(i => `${i.v} — ${i.s}`).join("; ")
}
function verbEnum(items: { v: string; s: string }[]): [string, ...string[]] {
  const names = items.map(i => i.v)
  return names as [string, ...string[]]
}

// Read-only verb menu for interceptor_read (from the tier tables — one source of truth).
const READ_MENU: { surface: Surface; v: string }[] = (["browser", "macos"] as Surface[])
  .flatMap(s => [...READ_VERBS[s]].map(v => ({ surface: s, v })))
const READ_VERB_NAMES = [...new Set(READ_MENU.map(r => r.v))] as [string, ...string[]]

// ── Session state ─────────────────────────────────────────────────────────────
type Session = { group: string; allowEnv: string | undefined; fence: boolean }

async function runVerb(
  surface: Surface, verb: string, args: string[],
  session: Session,
  flags: { group?: string; context?: string; tab?: number; confirm?: boolean },
  cliArgs: string[],
): Promise<McpResult> {
  const c = classify(surface, verb, args)
  const g = gate(c, parseAllow(session.allowEnv), flags.confirm === true)
  if (!g.allowed) {
    return { content: [{ type: "text", text: g.reason || "refused" }], isError: true }
  }
  const injected = withGlobalFlags(cliArgs, {
    group: surface === "browser" ? flags.group : undefined,
    context: surface === "browser" ? flags.context : undefined,
    tab: surface === "browser" ? flags.tab : undefined,
  })
  const run = await runInterceptor(injected, { timeoutMs: CALL_TIMEOUT_MS })
  return toResult({ surface, verb, run, fenceEnabled: session.fence })
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "interceptor", version: VERSION })
  const session: Session = {
    group: process.env.INTERCEPTOR_MCP_GROUP || `mcp-${process.pid}`,
    allowEnv: process.env.INTERCEPTOR_MCP_ALLOW,
    fence: (process.env.INTERCEPTOR_MCP_FENCE || "on").toLowerCase() !== "off",
  }

  const gid = () => session.group

  // ── interceptor_browser ─────────────────────────────────────────────────────
  server.registerTool("interceptor_browser", {
    title: "Interceptor — browser",
    description:
      "Drive the user's real signed-in Chrome/Brave/Safari via Interceptor (DOM, network, tabs, editors, screenshots). " +
      "verb menu: " + foldMenu(BROWSER_VERBS) +
      ". Put sub-args/flags in `args` (see the interceptor://manifest resource for exact flags/returns). " +
      "eval/save run page code and require operator opt-in + confirm.",
    inputSchema: {
      verb: z.enum(verbEnum(BROWSER_VERBS)).describe("browser verb"),
      args: z.array(z.string()).optional().describe("verb arguments + flags, verbatim"),
      context: z.string().optional().describe("route to a specific browser context/profile"),
      tab: z.number().optional().describe("target a specific tab id"),
      confirm: z.boolean().optional().describe("required for exec-tier verbs (eval/save) when operator-allowed"),
    },
  }, async (a: { verb: string; args?: string[]; context?: string; tab?: number; confirm?: boolean }) => {
    const args = a.args || []
    return runVerb("browser", a.verb, args, session, { group: gid(), context: a.context, tab: a.tab, confirm: a.confirm }, [a.verb, ...args])
  })

  // ── interceptor_macos ───────────────────────────────────────────────────────
  server.registerTool("interceptor_macos", {
    title: "Interceptor — macOS",
    description:
      "Drive native macOS apps + OS via Interceptor (AX, background input, windows, capture, Apple Events, VM, runtime, personal data). " +
      "verb menu: " + foldMenu(MACOS_VERBS) +
      ". Put the sub-verb + flags in `args` (see interceptor://help/macos). Destructive/exec verbs (app quit, vm delete, script, runtime, container, share) require operator opt-in + confirm.",
    inputSchema: {
      verb: z.enum(verbEnum(MACOS_VERBS)).describe("macOS top-level verb"),
      args: z.array(z.string()).optional().describe("sub-verb + arguments + flags, verbatim"),
      confirm: z.boolean().optional().describe("required for destructive/exec verbs when operator-allowed"),
    },
  }, async (a: { verb: string; args?: string[]; confirm?: boolean }) => {
    const args = a.args || []
    return runVerb("macos", a.verb, args, session, { confirm: a.confirm }, ["macos", a.verb, ...args])
  })

  // ── interceptor_read (read-only, auto-approvable) ───────────────────────────
  server.registerTool("interceptor_read", {
    title: "Interceptor — read (observational)",
    description:
      "Read-only observation across surfaces (no state change): trees, text, network, screenshots, listings. Safe to auto-approve. " +
      "verbs: " + READ_VERB_NAMES.join(", ") + ".",
    inputSchema: {
      surface: z.enum(["browser", "macos"]).describe("which surface to read"),
      verb: z.enum(READ_VERB_NAMES).describe("read-only verb"),
      args: z.array(z.string()).optional().describe("arguments + flags, verbatim"),
      context: z.string().optional(),
      tab: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a: { surface: Surface; verb: string; args?: string[]; context?: string; tab?: number }) => {
    const args = a.args || []
    if (!READ_VERBS[a.surface]?.has(a.verb)) {
      return { content: [{ type: "text", text: `'${a.verb}' is not a read-only verb on ${a.surface}. Use interceptor_${a.surface}.` }], isError: true }
    }
    const cliArgs = a.surface === "browser" ? [a.verb, ...args] : [a.surface, a.verb, ...args]
    return runVerb(a.surface, a.verb, args, session,
      { group: gid(), context: a.context, tab: a.tab }, cliArgs)
  })

  // ── interceptor_local (meta, read-only) ─────────────────────────────────────
  server.registerTool("interceptor_local", {
    title: "Interceptor — local/meta",
    description: "Local, daemon-free meta commands: " + foldMenu(LOCAL_VERBS) + ".",
    inputSchema: {
      verb: z.enum(verbEnum(LOCAL_VERBS)).describe("local verb"),
      args: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a: { verb: string; args?: string[] }) => {
    const args = a.args || []
    // upgrade is the one mutating local verb — gate it under the tier system.
    if (a.verb === "upgrade") return runVerb("local", a.verb, args, session, { confirm: false }, [a.verb, ...args])
    const run = await runInterceptor([a.verb, ...args], { timeoutMs: CALL_TIMEOUT_MS })
    return toResult({ surface: "local", verb: a.verb, run, fenceEnabled: session.fence })
  })

  // ── interceptor_raw (escape hatch — off unless operator allows `raw`) ────────
  server.registerTool("interceptor_raw", {
    title: "Interceptor — raw passthrough",
    description:
      "Run `interceptor` with verbatim args (extension verbs, exotic flag combos). DISABLED unless the operator set " +
      "INTERCEPTOR_MCP_ALLOW to include `raw`. The underlying verb is still tier-classified and gated.",
    inputSchema: {
      args: z.array(z.string()).min(1).describe("full interceptor argv, verbatim"),
      confirm: z.boolean().optional(),
    },
  }, async (a: { args: string[]; confirm?: boolean }) => {
    const allow = parseAllow(session.allowEnv)
    if (!allow.raw) {
      return { content: [{ type: "text", text: "interceptor_raw is disabled. Operator must relaunch with INTERCEPTOR_MCP_ALLOW=raw." }], isError: true }
    }
    // Derive surface/verb for classification.
    const args = a.args
    let surface: Surface = "browser", verb = args[0] || "", rest = args.slice(1)
    if (args[0] === "ios") {
      return { content: [{ type: "text", text: "the iOS surface is removed from this build." }], isError: true }
    }
    if (args[0] === "macos") { surface = "macos"; verb = args[1] || ""; rest = args.slice(2) }
    return runVerb(surface, verb, rest, session, { group: gid(), confirm: a.confirm }, args)
  })

  // ── Discovery resources ─────────────────────────────────────────────────────
  const textResource = (verb: string[], mimeType: string) => async (uri: URL) => {
    const run = await runInterceptor(verb, { timeoutMs: 30_000 })
    return { contents: [{ uri: uri.href, mimeType, text: run.stdout || run.stderr }] }
  }
  server.registerResource("manifest", "interceptor://manifest",
    { mimeType: "application/json", description: "Machine-readable capability manifest (browser+local fully; macos stubs)" },
    textResource(["manifest"], "application/json"))
  server.registerResource("help-macos", "interceptor://help/macos",
    { mimeType: "text/plain", description: "Full macOS verb + sub-verb reference" },
    textResource(["help", "macos"], "text/plain"))
  server.registerResource("extensions", "interceptor://extensions",
    { mimeType: "application/json", description: "Installed extension verbs (not in the manifest)" },
    textResource(["extensions", "list", "--json"], "application/json"))
  server.registerResource("help", new ResourceTemplate("interceptor://help/{verb}", { list: undefined }),
    { mimeType: "text/plain", description: "Help for one verb" },
    async (uri: URL, vars: { verb?: string | string[] }) => {
      const v = Array.isArray(vars.verb) ? vars.verb[0] : vars.verb || ""
      const run = await runInterceptor(["help", v], { timeoutMs: 30_000 })
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: run.stdout || run.stderr }] }
    })

  return server
}

export { warmDaemon }
