/**
 * daemon/ios/device-services.ts — reusable, reference-counted device-service
 * broker shared by runner launch and Web Inspection.
 *
 * One session per (udid, transport mode). It exposes device services as byte
 * channels regardless of whether the device is reached over classic Lockdown
 * (StartService) or the RemoteXPC/RSD tunnel (`…shim.remote` ports). It is
 * reference counted so the runner disconnecting does not tear down a WIR session
 * the web manager still holds, and a device removal closes every owner exactly
 * once. The RemoteXPC bring-up is the SHARED `openRemoteXpcTunnel` extracted from
 * usertunnel.ts — not a duplicate.
 *
 * A pure-usbmux + Lockdown discovery path lets the web lane list a paired device
 * without `xcrun devicectl`, then reconcile by UDID with any richer descriptor
 * the native IosManager already knows.
 */

import type net from "node:net"
import type { TLSSocket } from "node:tls"
import { openRemoteXpcTunnel, type Tun } from "./usertunnel"
import { connectServiceSocket, readPairRecord, getValue } from "./lockdown"
import { usbmuxListDevices } from "./usbmux-forward"
import { iosContextId, iosUdidSlug, deviceNeedsTunnel } from "../../shared/ios-device"

/** The duplex the WIR transport frames over (matches transport's DuplexBytes). */
export interface DeviceByteChannel {
  write(b: Buffer): void
  onData(cb: (b: Buffer) => void): void
  onClose(cb: () => void): void
  close(): void
}

export type DeviceServiceMode = "lockdown" | "remotexpc"

export type DeviceServiceSession = {
  udid: string
  mode: DeviceServiceMode
  /** service name → RSD port (remotexpc) or "lockdown" (classic, port resolved on open). */
  services: ReadonlyMap<string, number | "lockdown">
  /** Open a device service as a byte channel. */
  open(serviceName: string): Promise<DeviceByteChannel>
  retain(owner: string): void
  release(owner: string): Promise<void>
  close(reason: string): Promise<void>
}

// ── owner reference counting (pure — tested standalone) ───────────────────────

/**
 * Tracks the named owners of a shared resource. When the last owner releases,
 * `onLastRelease` fires exactly once; an explicit close short-circuits further
 * fires. Runner + WIR are independent owners of one device-service session.
 */
export class OwnerRefCount {
  private owners = new Set<string>()
  private fired = false
  constructor(private onLastRelease: () => void | Promise<void>) {}
  retain(owner: string): void { if (!this.fired) this.owners.add(owner) }
  async release(owner: string): Promise<void> {
    if (!this.owners.delete(owner)) return
    if (this.owners.size === 0) await this.fire()
  }
  private async fire(): Promise<void> {
    if (this.fired) return
    this.fired = true
    this.owners.clear()
    await this.onLastRelease()
  }
  /** Mark closed without firing the callback (the closer already tore down). */
  markClosed(): void { this.fired = true; this.owners.clear() }
  get size(): number { return this.owners.size }
  get isClosed(): boolean { return this.fired }
}

// ── socket adapters ───────────────────────────────────────────────────────────

export function adaptNetSocket(sock: net.Socket | TLSSocket): DeviceByteChannel {
  return {
    write: (b) => { try { sock.write(b) } catch {} },
    onData: (cb) => { sock.on("data", (c: Buffer) => cb(c)) },
    onClose: (cb) => { sock.on("close", cb) },
    close: () => { try { sock.destroy() } catch {} },
  }
}

/** A usertunnel TcpChan already matches DeviceByteChannel structurally. */
type TcpChanLike = DeviceByteChannel

// ── the session implementations ───────────────────────────────────────────────

class RemoteXpcServiceSession implements DeviceServiceSession {
  readonly mode = "remotexpc" as const
  readonly services: ReadonlyMap<string, number | "lockdown">
  private refs = new OwnerRefCount(() => this.close("last owner released"))
  private closed = false

  constructor(
    readonly udid: string,
    private tun: Tun,
    private cdp: net.Socket,
    serviceMap: Record<string, number>,
    private onClosed: () => void,
  ) {
    this.services = new Map(Object.entries(serviceMap))
  }

  async open(serviceName: string): Promise<DeviceByteChannel> {
    if (this.closed) throw new Error("device-service session closed")
    const port = this.services.get(serviceName)
    if (typeof port !== "number") throw new Error(`service ${serviceName} not in RSD map`)
    return (await this.tun.connect(port)) as TcpChanLike
  }

  retain(owner: string): void { this.refs.retain(owner) }
  async release(owner: string): Promise<void> { await this.refs.release(owner) }

  async close(_reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.refs.markClosed()
    try { this.cdp.destroy() } catch {}
    this.onClosed()
  }
}

class LockdownServiceSession implements DeviceServiceSession {
  readonly mode = "lockdown" as const
  // Lockdown ports are resolved per-open (StartService), so the map only records
  // that services are reached via lockdown; individual names are opened lazily.
  readonly services: ReadonlyMap<string, number | "lockdown"> = new Map()
  private refs = new OwnerRefCount(() => this.close("last owner released"))
  private openChannels = new Set<DeviceByteChannel>()
  private closed = false

  constructor(readonly udid: string, private onClosed: () => void) {}

  async open(serviceName: string): Promise<DeviceByteChannel> {
    if (this.closed) throw new Error("device-service session closed")
    const { sock } = await connectServiceSocket(this.udid, serviceName)
    const chan = adaptNetSocket(sock)
    this.openChannels.add(chan)
    sock.on("close", () => this.openChannels.delete(chan))
    return chan
  }

  retain(owner: string): void { this.refs.retain(owner) }
  async release(owner: string): Promise<void> { await this.refs.release(owner) }

  async close(_reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.refs.markClosed()
    for (const c of this.openChannels) { try { c.close() } catch {} }
    this.openChannels.clear()
    this.onClosed()
  }
}

// ── the broker ────────────────────────────────────────────────────────────────

export class IosDeviceServiceBroker {
  private sessions = new Map<string, Promise<DeviceServiceSession>>() // slug → session

  /**
   * Get (or establish) the shared device-service session for a udid. Chooses
   * RemoteXPC for iOS 17+ (a pair record is required) and classic Lockdown
   * otherwise. The returned session is memoized and reference counted.
   */
  sessionFor(udid: string, log: (m: string) => void = () => {}): Promise<DeviceServiceSession> {
    const slug = iosUdidSlug(udid)
    const existing = this.sessions.get(slug)
    if (existing) return existing
    const p = this.establish(udid, slug, log).catch((err) => {
      this.sessions.delete(slug) // let a later call retry a transient failure
      throw err
    })
    this.sessions.set(slug, p)
    return p
  }

  private async establish(udid: string, slug: string, log: (m: string) => void): Promise<DeviceServiceSession> {
    const pair = await readPairRecord(udid)
    if (!pair?.HostID || !pair.SystemBUID) {
      const e = new Error(`no pair record for ${udid}`) as Error & { code?: string }
      e.code = "device_unpaired"
      throw e
    }
    let productVersion: string | undefined
    try { const v = await getValue(udid, undefined, "ProductVersion"); productVersion = typeof v === "string" ? v : undefined } catch {}

    const drop = () => { if (this.sessions.get(slug)) this.sessions.delete(slug) }

    if (deviceNeedsTunnel(productVersion)) {
      const { tun, cdp, services } = await openRemoteXpcTunnel(udid, log)
      return new RemoteXpcServiceSession(udid, tun, cdp, services, drop)
    }
    return new LockdownServiceSession(udid, drop)
  }

  /** Force-close every session (device removal / daemon shutdown). */
  async closeAll(reason: string): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(async (sp) => { try { await (await sp).close(reason) } catch {} }))
  }

  /** Close the session for one udid (device removed). */
  async closeDevice(udid: string, reason: string): Promise<void> {
    const slug = iosUdidSlug(udid)
    const sp = this.sessions.get(slug)
    if (!sp) return
    this.sessions.delete(slug)
    try { await (await sp).close(reason) } catch {}
  }
}

// ── pure-usbmux + Lockdown web-lane discovery ─────────────────────────────────

export type WebLaneDevice = {
  udid: string
  contextId: string
  name?: string
  productVersion?: string
  paired: boolean
  transport: string
}

/**
 * Discover paired physical devices for the web lane WITHOUT `xcrun devicectl`:
 * usbmux ListDevices for presence, then Lockdown GetValue for name/version and a
 * pair-record probe for `paired`.
 */
export async function discoverWebLaneDevices(): Promise<WebLaneDevice[]> {
  const mux = await usbmuxListDevices()
  const byUdid = new Map<string, WebLaneDevice>()
  for (const d of mux) {
    const prior = byUdid.get(d.udid)
    // Prefer the USB entry when a device appears twice (USB + network).
    if (prior && !/usb/i.test(d.connectionType)) continue
    let paired = false
    let name: string | undefined
    let productVersion: string | undefined
    try { const pair = await readPairRecord(d.udid); paired = !!pair?.HostID } catch {}
    if (paired) {
      try { const v = await getValue(d.udid, undefined, "DeviceName"); name = typeof v === "string" ? v : undefined } catch {}
      try { const v = await getValue(d.udid, undefined, "ProductVersion"); productVersion = typeof v === "string" ? v : undefined } catch {}
    }
    byUdid.set(d.udid, {
      udid: d.udid,
      contextId: iosContextId(d.udid),
      name,
      productVersion,
      paired,
      transport: d.connectionType,
    })
  }
  return [...byUdid.values()]
}

export type ManagerDescriptorLite = { udid: string; name?: string; productVersion?: string; contextId?: string }

/**
 * Reconcile pure-usbmux discovery with richer descriptors the native IosManager
 * already knows, keyed case-insensitively by UDID. Manager fields win when the
 * usbmux/lockdown probe left a gap; nothing is invented. (pure/tested)
 */
export function reconcileByUdid(
  webLane: WebLaneDevice[],
  managerDescriptors: ManagerDescriptorLite[],
): WebLaneDevice[] {
  const byUdidLower = new Map<string, ManagerDescriptorLite>()
  for (const m of managerDescriptors) byUdidLower.set(m.udid.toLowerCase(), m)
  const out = webLane.map((d) => {
    const m = byUdidLower.get(d.udid.toLowerCase())
    byUdidLower.delete(d.udid.toLowerCase())
    return m ? { ...d, name: d.name ?? m.name, productVersion: d.productVersion ?? m.productVersion } : d
  })
  // Devices the manager knows but usbmux did not surface (e.g. network-only).
  for (const m of byUdidLower.values()) {
    out.push({
      udid: m.udid,
      contextId: m.contextId ?? iosContextId(m.udid),
      name: m.name,
      productVersion: m.productVersion,
      paired: true,
      transport: "manager",
    })
  }
  return out
}
