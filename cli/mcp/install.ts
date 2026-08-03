/**
 * cli/mcp/install.ts — one-command MCP registration.
 *
 * Mirrors `interceptor skills adopt`: detect the AI runtimes present on this
 * machine and write the correct MCP-server config into each — no manual JSON
 * editing, works across Claude Code, Codex, Gemini CLI, Cursor, Claude Desktop.
 *
 * Interceptor is a local stdio server already on PATH after the pkg, so the
 * config is just `{command:<abs interceptor>, args:["mcp","serve"]}` — no npx,
 * no remote URL, no auth step. The command path is the running binary itself
 * (`process.execPath`), so it self-locates regardless of install prefix.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type ClientFmt = "json" | "toml"
export type Client = {
  id: string
  label: string
  detect: (home: string, env: Record<string, string | undefined>) => boolean
  configPath: (home: string, env: Record<string, string | undefined>) => string
  fmt: ClientFmt
}

function codexHome(home: string, env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(home, ".codex")
}

export const CLIENTS: Client[] = [
  {
    id: "claude", label: "Claude Code",
    detect: (h) => existsSync(join(h, ".claude")) || existsSync(join(h, ".claude.json")),
    configPath: (h) => join(h, ".claude.json"),
    fmt: "json",
  },
  {
    id: "codex", label: "Codex",
    detect: (h, e) => existsSync(codexHome(h, e)),
    configPath: (h, e) => join(codexHome(h, e), "config.toml"),
    fmt: "toml",
  },
  {
    id: "gemini", label: "Gemini CLI",
    detect: (h) => existsSync(join(h, ".gemini")),
    configPath: (h) => join(h, ".gemini", "settings.json"),
    fmt: "json",
  },
  {
    id: "cursor", label: "Cursor",
    detect: (h) => existsSync(join(h, ".cursor")),
    configPath: (h) => join(h, ".cursor", "mcp.json"),
    fmt: "json",
  },
  {
    id: "claude-desktop", label: "Claude Desktop",
    detect: (h) => existsSync(join(h, "Library", "Application Support", "Claude")),
    configPath: (h) => join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    fmt: "json",
  },
]

export const SERVER_NAME = "interceptor"

/** The command a client should run to launch the server. Self-locating. */
export function interceptorInvocation(execPath = process.execPath): { command: string; args: string[] } {
  const base = (execPath.split("/").pop() || "")
  if (base === "interceptor" || base.startsWith("interceptor")) return { command: execPath, args: ["mcp", "serve"] }
  return { command: "interceptor", args: ["mcp", "serve"] } // dev / bun: assume on PATH
}

export function serverEntry(allow: string | undefined, execPath = process.execPath): Record<string, unknown> {
  const inv = interceptorInvocation(execPath)
  const entry: Record<string, unknown> = { command: inv.command, args: inv.args }
  if (allow) entry.env = { INTERCEPTOR_MCP_ALLOW: allow }
  return entry
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.interceptor-tmp-${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

// ── JSON clients ──────────────────────────────────────────────────────────────

export function mergeJson(existing: string | null, allow: string | undefined, remove: boolean, execPath = process.execPath): string {
  let obj: Record<string, unknown> = {}
  if (existing && existing.trim()) {
    try { const p = JSON.parse(existing); if (p && typeof p === "object" && !Array.isArray(p)) obj = p as Record<string, unknown> } catch { /* start fresh, but don't clobber unparseable */ throw new Error("existing config is not valid JSON; refusing to overwrite") }
  }
  const servers = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {}) as Record<string, unknown>
  if (remove) delete servers[SERVER_NAME]
  else servers[SERVER_NAME] = serverEntry(allow, execPath)
  obj.mcpServers = servers
  return JSON.stringify(obj, null, 2) + "\n"
}

// ── Codex TOML ────────────────────────────────────────────────────────────────

/** Remove the `[mcp_servers.interceptor]` table (and its `.env` subtable). */
export function stripTomlTable(text: string, table: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let skipping = false
  const headerRe = /^\s*\[\s*([^\]]+?)\s*\]\s*$/
  for (const line of lines) {
    const m = line.match(headerRe)
    if (m) {
      const name = m[1].trim()
      skipping = name === table || name.startsWith(table + ".")
      if (skipping) continue
    }
    if (!skipping) out.push(line)
  }
  return out.join("\n")
}

export function mergeToml(existing: string | null, allow: string | undefined, remove: boolean, execPath = process.execPath): string {
  let text = existing || ""
  text = stripTomlTable(text, `mcp_servers.${SERVER_NAME}`)
  if (!remove) {
    const inv = interceptorInvocation(execPath)
    let block = `\n[mcp_servers.${SERVER_NAME}]\n` +
      `command = ${JSON.stringify(inv.command)}\n` +
      `args = ${JSON.stringify(inv.args)}\n`
    if (allow) block += `\n[mcp_servers.${SERVER_NAME}.env]\nINTERCEPTOR_MCP_ALLOW = ${JSON.stringify(allow)}\n`
    text = text.replace(/\s+$/, "") + "\n" + block
  }
  return text.replace(/^\n+/, "").replace(/\s+$/, "") + "\n"
}

// ── apply ─────────────────────────────────────────────────────────────────────

export type InstallResult = { id: string; label: string; path: string; action: "installed" | "removed" | "unchanged" | "error"; detail?: string }

export function detectClients(home = homedir(), env: Record<string, string | undefined> = process.env): Client[] {
  return CLIENTS.filter(c => c.detect(home, env))
}

export function applyClient(
  client: Client, opts: { allow?: string; remove?: boolean; home?: string; env?: Record<string, string | undefined>; execPath?: string },
): InstallResult {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  const path = client.configPath(home, env)
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : null
    const next = client.fmt === "json"
      ? mergeJson(existing, opts.allow, opts.remove === true, execPath)
      : mergeToml(existing, opts.allow, opts.remove === true, execPath)
    if (existing !== null && existing === next) return { id: client.id, label: client.label, path, action: "unchanged" }
    if (opts.remove && existing === null) return { id: client.id, label: client.label, path, action: "unchanged" }
    atomicWrite(path, next)
    return { id: client.id, label: client.label, path, action: opts.remove ? "removed" : "installed" }
  } catch (err) {
    return { id: client.id, label: client.label, path, action: "error", detail: (err as Error).message }
  }
}

/** Render copy-paste config snippets for clients not auto-configured (`--print`). */
export function printSnippets(allow: string | undefined, execPath = process.execPath): string {
  const entry = serverEntry(allow, execPath)
  const json = JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)
  const inv = interceptorInvocation(execPath)
  const toml = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(inv.command)}\nargs = ${JSON.stringify(inv.args)}` +
    (allow ? `\n\n[mcp_servers.${SERVER_NAME}.env]\nINTERCEPTOR_MCP_ALLOW = ${JSON.stringify(allow)}` : "")
  return [
    "Claude Code / Cursor / Gemini / Claude Desktop (JSON — mcpServers):",
    json,
    "",
    "Codex (~/.codex/config.toml):",
    toml,
    "",
    "Claude Code CLI one-liner:",
    `  claude mcp add --scope user ${SERVER_NAME} -- ${inv.command} ${inv.args.join(" ")}`,
  ].join("\n")
}
