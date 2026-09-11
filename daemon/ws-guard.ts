// daemon/ws-guard.ts — who may open the daemon's control WebSocket.
//
// SECURITY (FORK-DELTA): the daemon WebSocket honors `delegate` frames that
// route arbitrary macos_* actions to the bridge (and CDP actions into Electron
// apps). Its port is the daemon's singleton token, so it binds with no hostname
// and answers on every interface; and a WebSocket is exempt from same-origin
// policy, so a page can open one across origins. Both facts mean the daemon —
// not the OS, not the browser — must decide who may upgrade. Without this gate,
// any web page the browser loads and any host on the LAN reaches the delegate
// path. Kept in its own module so it is unit-testable: daemon/index.ts starts a
// live daemon on import.

/**
 * Decide whether a WebSocket upgrade may be accepted.
 *
 * @param peerAddr Bun's `server.requestIP(req)?.address` (may be "").
 * @param origin   the request's `Origin` header (may be "").
 *
 * Allow only a loopback peer (closes the LAN), and only a non-web origin: the
 * browser extension's chrome-/moz-/safari-web-extension origin, or an empty
 * origin — the CLI and the injected native agent are not browsers and send
 * none. A page-context http(s) origin is refused even from loopback, because a
 * web page reaches loopback too. An empty or non-loopback peer fails closed.
 */
export function wsUpgradeAllowed(peerAddr: string, origin: string): boolean {
  const isLoopback = peerAddr === "127.0.0.1" || peerAddr === "::1" || peerAddr === "::ffff:127.0.0.1"
  if (!isLoopback) return false
  return (
    origin === "" ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  )
}
