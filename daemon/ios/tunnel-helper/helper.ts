/**
 * daemon/ios/tunnel-helper/helper.ts — the privileged tunnel helper.
 *
 * Runs as root under com.interceptor.ios-tunnel (installed by the pkg). It is the
 * ONLY root piece (Part 7). It brings up and HOLDS the iOS-17+ developer tunnel
 * so the unprivileged user daemon can reach RemoteServiceDiscovery (RSD) →
 * testmanagerd over plain node:net. No Xcode, no vendored binary.
 *
 * Tunnel path (proven reachable on iOS 26.6; refs: go-ios ios/tunnel/tunnel_lockdown.go):
 *   1. StartService `com.apple.internal.devicecompute.CoreDeviceProxy` over our
 *      usbmux+TLS lockdown stack (coredeviced-independent).
 *   2. CDTunnel handshake -> device IPv6 (serverAddress), our IPv6, MTU, RSD port.
 *   3. Create a kernel `utun` via bun:ffi (root) + ifconfig the address/MTU/up.
 *   4. Pump bare back-to-back IPv6 packets between the utun and the CoreDeviceProxy
 *      TLS stream. The OS TCP/IP stack then routes normal connections to the
 *      device IPv6 through the utun — so RSD/testmanagerd are reachable with node:net.
 *
 * The helper exposes over /var/run/interceptor-ios-tunnel.sock:
 *   {op:"tunnel", udid}   -> {ok, deviceIp, rsdPort, ifname}   (idempotent; holds it)
 *   {op:"remotectl", args}-> diagnostic passthrough
 *   {op:"discover"}       -> remotectl list
 */

import { dlopen, ptr, CString, FFIType } from "bun:ffi"
import net from "node:net"
import { existsSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { HELPER_SOCKET } from "../tunnel"
import { connectServiceSocket } from "../lockdown"

const REMOTECTL = "/usr/libexec/remotectl"
function log(...a: unknown[]): void { console.error("[ios-tunnel]", ...a) }

// ── libc (bun:ffi) — utun creation + nonblocking IO ───────────────────────────
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
}).symbols

const PF_SYSTEM = 32, SOCK_DGRAM = 2, SYSPROTO_CONTROL = 2
const AF_SYSTEM = 32, AF_SYS_CONTROL = 2
const CTLIOCGINFO = 0xc0644e03n
const UTUN_OPT_IFNAME = 2
const UTUN_CONTROL_NAME = "com.apple.net.utun_control"
const F_SETFL = 4, O_NONBLOCK = 4
const AF_INET6 = 30
const AF_HDR = Buffer.from([0, 0, 0, AF_INET6]) // macOS utun 4-byte protocol prefix

function createUtun(): { fd: number; name: string } {
  const fd = libc.socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL)
  if (fd < 0) throw new Error("socket(PF_SYSTEM) failed")
  const ci = new Uint8Array(100)                          // struct ctl_info
  new TextEncoder().encodeInto(UTUN_CONTROL_NAME, ci.subarray(4))
  if (libc.ioctl(fd, CTLIOCGINFO, ptr(ci)) < 0) throw new Error("ioctl(CTLIOCGINFO) failed")
  const ctlId = new DataView(ci.buffer).getUint32(0, true)
  const sa = new Uint8Array(32)                           // struct sockaddr_ctl
  const dv = new DataView(sa.buffer)
  dv.setUint8(0, 32); dv.setUint8(1, AF_SYSTEM); dv.setUint16(2, AF_SYS_CONTROL, true)
  dv.setUint32(4, ctlId, true); dv.setUint32(8, 0, true)  // sc_unit=0 -> kernel picks utunN
  if (libc.connect(fd, ptr(sa), 32) < 0) throw new Error("connect(utun) failed (need root)")
  const nameBuf = new Uint8Array(32)
  const lenBuf = new Uint32Array([32])
  if (libc.getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, ptr(nameBuf), ptr(lenBuf)) < 0) throw new Error("getsockopt(IFNAME) failed")
  libc.fcntl(fd, F_SETFL, O_NONBLOCK)
  return { fd, name: new CString(ptr(nameBuf)).toString() }
}

type Tunnel = { cdp: net.Socket | import("node:tls").TLSSocket; fd: number; name: string; deviceIp: string; rsdPort: number }
const tunnels = new Map<string, Tunnel>() // udid -> live tunnel

async function cdtunnelHandshake(cdp: Tunnel["cdp"]): Promise<{ deviceIp: string; myIp: string; mtu: number; rsdPort: number }> {
  const rq = Buffer.from(JSON.stringify({ type: "clientHandshakeRequest", mtu: 1280 }))
  cdp.write(Buffer.concat([Buffer.from("CDTunnel\0"), Buffer.from([rq.length]), rq]))
  return await new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    const t = setTimeout(() => reject(new Error("CDTunnel handshake timeout")), 8000)
    const onData = (c: Buffer) => {
      acc = Buffer.concat([acc, c])
      if (acc.length < 10 || acc.length < 10 + acc[9]) return
      clearTimeout(t); cdp.off("data", onData)
      const p = JSON.parse(acc.subarray(10, 10 + acc[9]).toString())
      resolve({ deviceIp: p.serverAddress, myIp: p.clientParameters.address, mtu: p.clientParameters.mtu, rsdPort: p.serverRSDPort })
    }
    cdp.on("data", onData)
    cdp.on("error", reject)
  })
}

async function bringUpTunnel(udid: string): Promise<{ deviceIp: string; rsdPort: number; ifname: string }> {
  const existing = tunnels.get(udid)
  if (existing) return { deviceIp: existing.deviceIp, rsdPort: existing.rsdPort, ifname: existing.name }

  const { sock: cdp } = await connectServiceSocket(udid, "com.apple.internal.devicecompute.CoreDeviceProxy")
  const hs = await cdtunnelHandshake(cdp)
  log(`CDTunnel: device=${hs.deviceIp} me=${hs.myIp} mtu=${hs.mtu} rsd=${hs.rsdPort}`)

  const { fd, name } = createUtun()
  log(`utun ${name} (fd ${fd})`)
  spawnSync("/sbin/ifconfig", [name, "inet6", "add", `${hs.myIp}/64`])
  spawnSync("/sbin/ifconfig", [name, "mtu", String(hs.mtu), "up"])
  spawnSync("/sbin/ifconfig", [name, "up"])

  const tun: Tunnel = { cdp, fd, name, deviceIp: hs.deviceIp, rsdPort: hs.rsdPort }
  tunnels.set(udid, tun)

  // device -> utun: CDP stream is bare IPv6 packets; reframe, prepend AF, write utun
  let racc = Buffer.alloc(0)
  cdp.on("data", (chunk: Buffer) => {
    racc = Buffer.concat([racc, chunk])
    while (racc.length >= 40) {
      if ((racc[0] >> 4) !== 6) { racc = Buffer.alloc(0); break }
      const total = 40 + racc.readUInt16BE(4)
      if (racc.length < total) break
      const out = Buffer.concat([AF_HDR, racc.subarray(0, total)])
      racc = racc.subarray(total)
      libc.write(fd, ptr(out), BigInt(out.length))
    }
  })
  cdp.on("close", () => { log(`tunnel ${udid} cdp closed`); teardown(udid) })
  cdp.on("error", (e) => log(`tunnel ${udid} cdp error: ${e.message}`))

  // utun -> device: nonblocking poll; strip 4-byte AF, write bare IPv6 to CDP
  const rbuf = new Uint8Array(hs.mtu + 4)
  const rptr = ptr(rbuf)
  const pump = () => {
    if (!tunnels.has(udid)) return
    for (let i = 0; i < 256; i++) {
      const n = Number(libc.read(fd, rptr, BigInt(rbuf.length)))
      if (n <= 4) break // EAGAIN (<0) or too small
      try { cdp.write(Buffer.from(rbuf.buffer, 4, n - 4)) } catch {}
    }
    setTimeout(pump, 1)
  }
  pump()

  return { deviceIp: hs.deviceIp, rsdPort: hs.rsdPort, ifname: name }
}

function teardown(udid: string): void {
  const t = tunnels.get(udid); if (!t) return
  tunnels.delete(udid)
  try { t.cdp.destroy() } catch {}
  try { libc.close(t.fd) } catch {}
  try { spawnSync("/sbin/ifconfig", [t.name, "destroy"]) } catch {}
}

function remotectlList(): string {
  const r = spawnSync(REMOTECTL, ["list"], { encoding: "utf-8" })
  return (r.stdout ?? "") + (r.stderr ? "\nERR:" + r.stderr : "")
}

export async function runTunnelHelper(): Promise<void> {
  try { if (existsSync(HELPER_SOCKET)) rmSync(HELPER_SOCKET) } catch {}
  const uid = typeof process.getuid === "function" ? process.getuid() : -1
  if (uid !== 0) { console.error("interceptor ios-tunnel: must run as root; exiting."); process.exit(1) }
  log("helper starting (root). remotectl list:")
  for (const line of remotectlList().split("\n")) if (line.trim()) log("  " + line)

  net.createServer((sock) => {
    let buf = ""
    sock.on("data", async (chunk) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: { op?: string; udid?: string; args?: unknown[] }
        try { msg = JSON.parse(line) } catch { sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n"); continue }
        try {
          if (msg.op === "ping") sock.write(JSON.stringify({ ok: true }) + "\n")
          else if (msg.op === "discover") sock.write(JSON.stringify({ ok: true, list: remotectlList() }) + "\n")
          else if (msg.op === "tunnel" && msg.udid) {
            const ep = await bringUpTunnel(msg.udid)
            log(`tunnel up for ${msg.udid}: [${ep.deviceIp}]:${ep.rsdPort} via ${ep.ifname}`)
            sock.write(JSON.stringify({ ok: true, ...ep }) + "\n")
          } else if (msg.op === "remotectl" && Array.isArray(msg.args)) {
            const r = spawnSync(REMOTECTL, msg.args.map(String), { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 })
            sock.write(JSON.stringify({ ok: r.status === 0, code: r.status, stdout: (r.stdout ?? "").slice(0, 60000), stderr: (r.stderr ?? "").slice(0, 8000) }) + "\n")
          } else sock.write(JSON.stringify({ ok: false, error: "unknown op" }) + "\n")
        } catch (e) { sock.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n") }
      }
    })
    sock.on("error", () => {})
  }).listen(HELPER_SOCKET, () => {
    try { spawnSync("/bin/chmod", ["666", HELPER_SOCKET]) } catch {}
    log(`listening at ${HELPER_SOCKET}`)
  })
  await new Promise<void>(() => {})
}
