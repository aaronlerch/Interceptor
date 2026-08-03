/**
 * daemon/ios/tunnel-pool.ts — one shared, REF-COUNTED RemoteXPC tunnel per device.
 *
 *
 * CoreDeviceProxy admits only ONE tunnel per device at a time, and the XCUITest
 * runner opens its own tunnel to reach testmanagerd. So the dev/telemetry lanes
 * must NOT hold a tunnel open indefinitely — otherwise the runner can't launch
 * ("service com.apple.dt.testmanagerd.remote not found"). Callers acquire before
 * use and release when done; when the last user releases, the tunnel is closed
 * after a short idle grace (so rapid successive dev ops still reuse it) and the
 * runner can reclaim CoreDeviceProxy.
 */

import { openRemoteXpcTunnel, type RemoteXpcTunnel } from "./usertunnel"

type Entry = { tunnel: Promise<RemoteXpcTunnel>; refs: number; idle?: ReturnType<typeof setTimeout> }
const pool = new Map<string, Entry>()
const IDLE_CLOSE_MS = 1500

/** Acquire the shared tunnel (opening it if needed). Balance with releaseTunnel(). */
export function acquireTunnel(udid: string, log: (m: string) => void = () => {}): Promise<RemoteXpcTunnel> {
  let e = pool.get(udid)
  if (!e) {
    e = { tunnel: openRemoteXpcTunnel(udid, log).catch((err) => { pool.delete(udid); throw err }), refs: 0 }
    pool.set(udid, e)
  }
  if (e.idle) { clearTimeout(e.idle); e.idle = undefined }
  e.refs++
  return e.tunnel
}

/** Release a previously-acquired tunnel. Closes it (freeing CoreDeviceProxy for the
 *  runner) once no users remain, after a short idle grace. */
export function releaseTunnel(udid: string): void {
  const e = pool.get(udid)
  if (!e) return
  e.refs = Math.max(0, e.refs - 1)
  if (e.refs > 0) return
  e.idle = setTimeout(() => {
    pool.delete(udid)
    e.tunnel.then((t) => { try { t.cdp.destroy() } catch {} }).catch(() => {})
  }, IDLE_CLOSE_MS)
}

/** Force-close and forget a device's tunnel (device removal / error recovery). */
export function dropSharedTunnel(udid: string): void {
  const e = pool.get(udid)
  pool.delete(udid)
  if (e?.idle) clearTimeout(e.idle)
  e?.tunnel.then((t) => { try { t.cdp.destroy() } catch {} }).catch(() => {})
}
