import { runMacosCommand } from "./macos"
import { sendCommand } from "../transport"
import type { DesktopResult, DesktopHello } from "../../shared/desktop-contract"
import { existsSync } from "node:fs"

export async function runDesktopCommand(args: string[], opts: { jsonMode?: boolean; useWs?: boolean; globalTabId?: number; contextId?: string }): Promise<void> {
  if (args[1] === "cdp") {
    await runMacosCommand(["macos", ...args.slice(1)], { ...opts, desktop: true })
    return
  }
  if (["status", "capabilities", "providers"].includes(args[1])) {
    const { result } = await sendCommand({ type: process.platform === "darwin" ? "macos_desktop" : "desktop_hello", sub: "hello" })
    const hello = result.data as DesktopHello | undefined
    // FORK-DELTA §5–§7: no daemon-owned vault or sudo capability is advertised;
    // credentials are 1Password references delivered with --secret op://….
    console.log(JSON.stringify(result.success ? result.data : result, null, 2))
    if (!result.success) process.exitCode = 1
    return
  }
  if (process.platform !== "darwin" && !["secret", "container", "sudo"].includes(args[1])) {
    // Qualify before the legacy parser can prompt for a secret, create monitor
    // metadata, or enter a macOS runtime/CDP implementation.
    let result = (await sendCommand({ type: "desktop_hello" })).result as DesktopResult
    const capabilities = (result.data as { capabilities?: { operation: string; compiled: boolean; present: boolean }[] } | undefined)?.capabilities
    // CLI family names that the provider reports under their contract operation name.
    const named: Record<string, string> = { script: "script_run", intent: "intent_dispatch", container: "container_run" }
    const operation = args[1] === "display" ? `display_${args[2] || "list"}` : args[1] === "inspect" && (!args[2] || args[2].startsWith("--")) ? "inspect_app" : named[args[1]] ?? args[1]
    if (result.success && !capabilities?.some(c => c.operation === operation && c.compiled && c.present)) {
      result = { success: false, code: "unsupported_operation", error: `desktop ${args[1]} is not implemented by this host provider` }
    }
    if (!result.success) {
      if (opts.jsonMode) console.log(JSON.stringify(result))
      else console.error(`error: ${result.error}`)
      process.exitCode = 1; return
    }
  }
  // One parser and output/monitor/secret path for both command names.
  await runMacosCommand(["macos", ...args.slice(1)], { ...opts, desktop: true })
}
