/**
 * daemon/ios/testmanagerd.ts — launch the XCUITest runner via testmanagerd
 *. Replaces `xcodebuild test-without-building` (manager.ts:415).
 *
 * A test host can't just be `process launch`ed and yield an XCUIApplication — it
 * needs the test-coordinator handshake. testmanagerd speaks DTX (the same binary
 * message protocol instruments uses). We connect over the RemoteXPC tunnel (M3),
 * open the `dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface`
 * channels, and start executing the test plan with an `XCTestConfiguration`,
 * injecting our per-session env (INTERCEPTOR_WS_URL/TOKEN/UDID/CONTEXT_ID — the
 * same payload prepareXctestrunWithEnv builds, tools.ts:314). go-ios `runwda`/
 * `runtest` and pymobiledevice3 `dvt` are the exact analog.
 *
 * REAL + offline-testable: the DTX message-header codec. LIVE-GATED: the launch
 * itself needs the tunnel (M3) + DDI (M4); it throws an explicit error until the
 * M5 spike wires the channels — no silent success.
 */

import type { RunnerEnv } from "./tunnel"
import { launchRunnerOverUserspaceTunnel, type UserspaceRunnerHandle } from "./usertunnel"

export const DTX_MAGIC = 0x1f3d5b79
export const DTX_HEADER_SIZE = 32

export type DtxHeader = {
  fragmentIndex: number
  fragmentCount: number
  length: number          // payload length (bytes after this header)
  identifier: number
  conversationIndex: number
  channelCode: number
  expectsReply: boolean
}

/** Encode a 32-byte DTX message header (all little-endian). */
export function encodeDtxHeader(h: DtxHeader): Buffer {
  const b = Buffer.alloc(DTX_HEADER_SIZE)
  b.writeUInt32LE(DTX_MAGIC, 0)
  b.writeUInt32LE(DTX_HEADER_SIZE, 4)          // header length (cb)
  b.writeUInt16LE(h.fragmentIndex, 8)
  b.writeUInt16LE(h.fragmentCount, 10)
  b.writeUInt32LE(h.length, 12)
  b.writeUInt32LE(h.identifier, 16)
  b.writeUInt32LE(h.conversationIndex, 20)
  b.writeUInt32LE(h.channelCode >>> 0, 24)
  b.writeUInt32LE(h.expectsReply ? 1 : 0, 28)
  return b
}

export function decodeDtxHeader(buf: Buffer): DtxHeader | undefined {
  if (buf.length < DTX_HEADER_SIZE) return undefined
  if (buf.readUInt32LE(0) !== DTX_MAGIC) return undefined
  return {
    fragmentIndex: buf.readUInt16LE(8),
    fragmentCount: buf.readUInt16LE(10),
    length: buf.readUInt32LE(12),
    identifier: buf.readUInt32LE(16),
    conversationIndex: buf.readUInt32LE(20),
    channelCode: buf.readInt32LE(24),
    expectsReply: buf.readUInt32LE(28) !== 0,
  }
}

export type LaunchRunnerOpts = {
  bundleId: string
  /** Per-session env injected into the test process (WS_URL/TOKEN/UDID/CONTEXT_ID). */
  env: RunnerEnv
}

const activeLaunches = new Map<string, UserspaceRunnerHandle>()

function debugLog(message: string): void {
  if (!process.env.DEBUG_IOS && !process.env.DBG) return
  console.error(`[ios-testmanagerd] ${message}`)
}

/**
 * Start the XCUITest session for `*.xctrunner`. The runner then dials back over
 * WebSocket exactly as before (manager.registerRunner unchanged).
 */
export async function launchRunner(udid: string, opts: LaunchRunnerOpts): Promise<void> {
  closeRunner(udid)
  const observeMs = Number(process.env.INTERCEPTOR_IOS_LAUNCH_OBSERVE_MS ?? 0)
  const handle = await launchRunnerOverUserspaceTunnel(udid, {
    bundleId: opts.bundleId,
    env: opts.env,
    observeMs: Number.isFinite(observeMs) && observeMs > 0 ? observeMs : 0,
    log: debugLog,
  })
  activeLaunches.set(udid.toUpperCase(), handle)
}

export function closeRunner(udid: string): void {
  const key = udid.toUpperCase()
  const handle = activeLaunches.get(key)
  if (!handle) return
  activeLaunches.delete(key)
  try { handle.close() } catch {}
}

export function closeAllRunners(): void {
  for (const udid of [...activeLaunches.keys()]) closeRunner(udid)
}
