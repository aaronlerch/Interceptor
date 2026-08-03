/**
 * daemon/ios/screenstream.ts — live screen (CoreMediaIO / QuickTime).
 *
 * HONEST CEILING. The QuickTime/CoreMediaIO screen stream is NOT a lockdown or
 * RSD service — it is exposed only after a raw-USB vendor control transfer
 * (bmRequestType 0x21, bRequest 0x01) flips the device into its alternate
 * "QT config" USB configuration, after which an H.264 + audio packet stream is
 * bulk-read from a dedicated endpoint. A live RSD enumeration on iOS 27 confirms
 * NO screen-video service is reachable over the tunnel (only PurpleReverseProxy
 * [CarPlay] and corecaptured [WiFi/BT diag]).
 *
 * Pure-Bun over usbmux cannot issue USB control transfers, and adding a native
 * USB addon violates the no-new-dependency rule. The two real paths
 * are: (a) a native libusb addon, or (b) macOS AVFoundation/CoreMediaIO capture
 * via the interceptor-bridge Swift app once QT config is enabled. Both are native
 * follow-ups; this module ships the honest capability gate plus the Annex-B frame
 * writer (unit-testable) that either path would feed.
 */

export type ScreenCapability = {
  available: false
  code: "unsupported_on_os"
  reason: string
  paths: string[]
}

/** Report the live-screen capability. Always an honest gate in pure-Bun. */
export function screenCapability(): ScreenCapability {
  return {
    available: false,
    code: "unsupported_on_os",
    reason: "Live H.264 screen requires a raw-USB alternate-config switch (CoreMediaIO/QuickTime), which pure-Bun over usbmux cannot perform.",
    paths: [
      "Native libusb addon to issue the 0x21/0x01 'enable QT config' control transfer + bulk-read the H.264 endpoint.",
      "macOS AVFoundation/CoreMediaIO capture via interceptor-bridge once QT config is enabled (the iPhone then appears as an AVCaptureDevice).",
      "Interim: poll runner screenshots (Lane C) or screenshotr (Lane S, DDI-gated) for a frame feed.",
    ],
  }
}

// ── Annex-B H.264 frame writer (the reusable, testable half) ──────────────────
// The QT stream delivers length-prefixed NAL units + separate SPS/PPS. A consumer
// (either native path) hands us those; we emit a standard Annex-B elementary
// stream (00 00 00 01 start codes) that ffmpeg/VLC play directly.

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

/** Wrap one NAL unit (no start code) into an Annex-B chunk. */
export function annexBNal(nal: Buffer): Buffer {
  return Buffer.concat([START_CODE, nal])
}

/** Concatenate SPS/PPS + a sequence of NAL units into an Annex-B stream. */
export function annexBStream(params: { sps?: Buffer; pps?: Buffer; nals: Buffer[] }): Buffer {
  const parts: Buffer[] = []
  if (params.sps) parts.push(annexBNal(params.sps))
  if (params.pps) parts.push(annexBNal(params.pps))
  for (const n of params.nals) parts.push(annexBNal(n))
  return Buffer.concat(parts)
}
