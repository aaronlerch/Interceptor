/**
 * daemon/ios/wda-client.ts — minimal HTTP client for a running WebDriverAgent
 * (XCUITest) server, reached over a host-local port the IosManager forwarded
 * from the device's WDA (default 8100).
 *
 * Capability set verified against pymobiledevice3's `WdaClient` + Apple XCUITest
 * API: session mgmt, source, coordinate tap, drag, keys, hardware
 * button press, screenshot, app launch/activate/terminate, window size.
 *
 * NOTE: exact WDA route strings are isolated HERE so they can
 * be pinned/adjusted against the bundled WDA + appium-ios-device version at build
 * time without touching the manager. Actuation is coordinate-based (tap/drag at a
 * frame center computed host-side from the `/source` tree) — robust against WDA
 * element-handle staleness.
 */

import type { IosDeviceChannel } from "./channel"

export type WdaCaps = { x: number; y: number; width: number; height: number }

export type WdaClientOptions = {
  baseUrl: string // e.g. http://127.0.0.1:8100
  timeoutMs?: number
}

type WdaResponse<T = unknown> = { value?: T; sessionId?: string; status?: number }

export class WdaError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message)
    this.name = "WdaError"
  }
}

export class WdaClient implements IosDeviceChannel {
  readonly baseUrl: string
  private timeoutMs: number
  private sessionId: string | undefined

  constructor(opts: WdaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  // ── low-level HTTP ──────────────────────────────────────────────────────────

  private async req<T = unknown>(method: string, path: string, body?: unknown): Promise<WdaResponse<T>> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      let parsed: WdaResponse<T> = {}
      if (text) {
        try { parsed = JSON.parse(text) as WdaResponse<T> } catch { /* non-JSON body */ }
      }
      if (!res.ok) {
        const detail = (parsed?.value as { error?: string; message?: string } | undefined)
        throw new WdaError(detail?.message || detail?.error || `WDA ${method} ${path} -> HTTP ${res.status}`, res.status)
      }
      return parsed
    } catch (err) {
      if (err instanceof WdaError) throw err
      if ((err as Error).name === "AbortError") throw new WdaError(`WDA ${method} ${path} timed out after ${this.timeoutMs}ms`)
      throw new WdaError(`WDA ${method} ${path} failed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private sessionPath(suffix: string): string {
    if (!this.sessionId) throw new WdaError("no active WDA session — call createSession() first")
    return `/session/${this.sessionId}${suffix}`
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  /** WDA /status — also confirms reachability/health. */
  async status(): Promise<unknown> {
    const r = await this.req("GET", "/status")
    return r.value ?? r
  }

  /**
   * Create (or reuse) a WDA session. A session is not strictly required for the
   * global `/source` and `/screenshot`, but app launch/activate and key entry
   * are session-scoped, so we always establish one. `bundleId` optionally
   * launches an app on session start.
   */
  async createSession(bundleId?: string): Promise<string> {
    const capabilities = bundleId
      ? { alwaysMatch: { "bundleId": bundleId } }
      : { alwaysMatch: {} }
    const r = await this.req<{ sessionId?: string }>("POST", "/session", {
      capabilities,
      // legacy field some WDA builds still read
      desiredCapabilities: bundleId ? { bundleId } : {},
    })
    const sid = r.sessionId || (r.value as { sessionId?: string } | undefined)?.sessionId
    if (!sid) throw new WdaError("WDA did not return a sessionId on POST /session")
    this.sessionId = sid
    return sid
  }

  setSession(sessionId: string): void { this.sessionId = sessionId }
  getSession(): string | undefined { return this.sessionId }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return
    try { await this.req("DELETE", `/session/${this.sessionId}`) } catch { /* best effort */ }
    this.sessionId = undefined
  }

  // ── introspection ──────────────────────────────────────────────────────────

  /** UI hierarchy as a JSON tree (XCUIElement snapshot serialization). */
  async source(): Promise<unknown> {
    // Session-scoped source carries the active app's tree; fall back to global.
    const path = this.sessionId ? this.sessionPath("/source?format=json") : "/source?format=json"
    const r = await this.req("GET", path)
    return r.value ?? r
  }

  async windowSize(): Promise<WdaCaps> {
    const r = await this.req<WdaCaps>("GET", this.sessionPath("/window/size"))
    const v = (r.value ?? {}) as Partial<WdaCaps>
    return { x: 0, y: 0, width: Number(v.width) || 0, height: Number(v.height) || 0 }
  }

  // ── input (coordinate-based, W3C Actions) ────────────────────────────────────
  // NOTE: WDA 15.x dropped the legacy /wda/tap/0 + /wda/dragfromtoforduration
  // coordinate endpoints (they ack 200 but no-op). The W3C `/session/{id}/actions`
  // pointer API is the working primitive — verified live against WDA 15.1.1.

  /** Tap at an absolute screen coordinate via a W3C pointer down/up sequence. */
  async tap(x: number, y: number): Promise<void> {
    await this.req("POST", this.sessionPath("/actions"), {
      actions: [{
        type: "pointer", id: "finger1", parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x, y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 60 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    })
    await this.releaseActions()
  }

  /** Press-and-hold then drag between two coordinates over a duration (seconds). */
  async drag(fromX: number, fromY: number, toX: number, toY: number, durationSec = 0.5): Promise<void> {
    await this.req("POST", this.sessionPath("/actions"), {
      actions: [{
        type: "pointer", id: "finger1", parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: fromX, y: fromY },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 250 },
          { type: "pointerMove", duration: Math.max(1, Math.round(durationSec * 1000)), x: toX, y: toY },
          { type: "pointerUp", button: 0 },
        ],
      }],
    })
    await this.releaseActions()
  }

  /** Release any held W3C action state (best effort). */
  private async releaseActions(): Promise<void> {
    try { await this.req("DELETE", this.sessionPath("/actions")) } catch { /* not all builds implement it */ }
  }

  /** Type text into the currently focused element. */
  async sendKeys(text: string): Promise<void> {
    await this.req("POST", this.sessionPath("/wda/keys"), { value: Array.from(text) })
  }

  /** Press a hardware/device button: home | volumeUp | volumeDown | lock | snapshot. */
  async pressButton(name: string): Promise<void> {
    if (name === "home") {
      await this.req("POST", "/wda/homescreen")
      return
    }
    if (name === "lock") {
      await this.req("POST", this.sessionPath("/wda/lock"))
      return
    }
    await this.req("POST", this.sessionPath("/wda/pressButton"), { name })
  }

  // ── capture ──────────────────────────────────────────────────────────────────

  /** Full-resolution screenshot as base64 PNG (W3C global screenshot). */
  async screenshot(): Promise<string> {
    const r = await this.req<string>("GET", "/screenshot")
    const b64 = typeof r.value === "string" ? r.value : undefined
    if (!b64) throw new WdaError("WDA did not return screenshot data")
    return b64
  }

  // ── app lifecycle ──────────────────────────────────────────────────────────

  async launchApp(bundleId: string): Promise<void> {
    await this.req("POST", this.sessionPath("/wda/apps/launch"), { bundleId })
  }

  async activateApp(bundleId: string): Promise<void> {
    await this.req("POST", this.sessionPath("/wda/apps/activate"), { bundleId })
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.req("POST", this.sessionPath("/wda/apps/terminate"), { bundleId })
  }

  async activeAppInfo(): Promise<unknown> {
    const r = await this.req("GET", this.sessionPath("/wda/activeAppInfo"))
    return r.value ?? r
  }
}
