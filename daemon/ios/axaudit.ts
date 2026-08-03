/**
 * daemon/ios/axaudit.ts — runner-free accessibility via axAuditDaemon.
 *
 * A bonus surface found in the live RSD map: `axAuditDaemon.remoteserver` /
 * `remoteAXService` is the accessibility-audit daemon Xcode's Accessibility
 * Inspector drives. Reaching it over the tunnel would give a SYSTEM accessibility
 * element tree WITHOUT the XCUITest runner.
 *
 * The AX-audit XPC message schema is undocumented and the `.shim.remote` variant
 * carries the iOS-27 handshake regression. So this ships the reachable,
 * honest core — open the service over the tunnel and run the RemoteXPC handshake,
 * reporting which transport answered — and scopes the full tree query as a live
 * protocol-discovery follow-up. No fabricated AX data.
 */

import { XpcService } from "./usertunnel"
import { acquireTunnel, releaseTunnel } from "./tunnel-pool"

const AX_NAMES = [
  "com.apple.accessibility.axAuditDaemon.remoteAXService",
  "com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote",
]

export type AxAuditProbe = {
  reachable: boolean
  transport?: string
  handshake?: unknown
  note: string
}

/** Probe the AX-audit daemon: open + RemoteXPC handshake over the tunnel. */
export async function axAuditProbe(udid: string, log: (m: string) => void = () => {}): Promise<AxAuditProbe> {
  const { tun, services } = await acquireTunnel(udid, log)
  try {
    const name = AX_NAMES.find((n) => services[n])
    if (!name) return { reachable: false, note: "axAuditDaemon not present in the RSD service map on this OS build." }
    try {
      const chan = await tun.connect(services[name])
      const xpc = new XpcService(chan, "axaudit")
      await xpc.handshake()
      return {
        reachable: true,
        transport: name,
        note: "AX-audit XPC handshake completed. System element-tree query is a live protocol-discovery follow-up (schema undocumented).",
      }
    } catch (e) {
      return {
        reachable: false,
        transport: name,
        note: `AX-audit open/handshake failed: ${(e as Error).message}${name.endsWith(".shim.remote") ? " (shim.remote regressed on iOS 27)" : ""}`,
      }
    }
  } finally {
    releaseTunnel(udid)
  }
}
