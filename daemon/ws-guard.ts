// daemon/ws-guard.ts — who may open the daemon's control WebSocket.
//
// SECURITY (FORK-DELTA): the daemon WebSocket honors `delegate` frames that
// route arbitrary macos_* actions to the bridge (and CDP actions into Electron
// apps). Upstream 2.x binds it to 127.0.0.1 (#274); this check is the second
// layer, so a later change that drops the bind does not reopen the LAN. A
// WebSocket is exempt from same-origin policy, so a page can open one across
// origins, and a DNS-rebound page can make same-origin GETs (no Origin header)
// — hence the Host check. Kept in its own module so it is unit-testable:
// daemon/index.ts starts a live daemon on import.

/**
 * Decide whether a WebSocket upgrade may be accepted.
 *
 * @param peerAddr Bun's `server.requestIP(req)?.address` (may be "").
 * @param origin   the request's `Origin` header (may be "").
 * @param host     the request's `Host` header. When given (non-empty `port`),
 *                 it must name a loopback host on that port.
 * @param port     the daemon's WS port; omit to skip the Host check.
 *
 * Allow only a loopback peer (closes the LAN), and only a non-web origin: the
 * browser extension's chrome-/moz-/safari-web-extension origin, or an empty
 * origin — the CLI and the injected native agent are not browsers and send
 * none. A page-context http(s) origin is refused even from loopback, because a
 * web page reaches loopback too. An empty or non-loopback peer fails closed.
 */
export function wsUpgradeAllowed(peerAddr: string, origin: string, host?: string, port?: number): boolean {
  const isLoopback = peerAddr === "127.0.0.1" || peerAddr === "::1" || peerAddr === "::ffff:127.0.0.1"
  if (!isLoopback) return false
  if (port !== undefined && !loopbackHost(host ?? "", port)) return false
  return (
    origin === "" ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  )
}

/** Host header names a loopback host on `port` (127.0.0.1, localhost, [::1]). */
export function loopbackHost(host: string, port: number): boolean {
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`
}
