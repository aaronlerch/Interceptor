/**
 * daemon/ios/ddi.ts — Developer Disk Image mount.
 *
 * testmanagerd/instruments need the personalized DDI mounted; Xcode does this
 * today. We speak `mobile_image_mounter` over the tunnel: look up whether an
 * image is already mounted, and if not, for iOS 17+ fetch → TSS-personalize →
 * upload → MountImage. One-time per boot. go-ios `image auto` / pymobiledevice3
 * `mounter auto-mount` are the analog.
 *
 * REAL builders below; the fetch/personalize/mount is LIVE-GATED (needs the
 * tunnel M3 + Apple's TSS signing server) and throws rather than faking a mount.
 */

import { encodeLockdownFrame, type PlistDict } from "./lockdown"

export const IMAGE_TYPE = "Personalized"   // iOS 17+; "Developer" for <17

export function mounterLookupRequest(): PlistDict {
  return { Command: "LookupImage", ImageType: IMAGE_TYPE }
}
export function mounterQueryPersonalizationRequest(): PlistDict {
  return { Command: "QueryPersonalizationManifest", PersonalizedImageType: IMAGE_TYPE, ImageType: IMAGE_TYPE }
}
export function mounterMountRequest(imageSignature: Buffer, trustCache?: Buffer): PlistDict {
  const req: PlistDict = { Command: "MountImage", ImageType: IMAGE_TYPE, ImageSignature: imageSignature }
  if (trustCache) req.ImageTrustCache = trustCache
  return req
}
export function encodeMounterFrame(req: PlistDict): Buffer {
  return encodeLockdownFrame(req)
}

/** True if the DDI is already mounted (skip the whole dance). GATED on tunnel. */
export async function isImageMounted(_udid: string): Promise<boolean> {
  throw new Error("ddi: mount-state lookup runs over the tunnel (M3). Mounter requests are ready.")
}

/** Fetch/personalize/mount the matching DDI. GATED on tunnel (M3) + Apple TSS. */
export async function mountDeveloperDiskImage(_udid: string): Promise<void> {
  throw new Error(
    "ddi: DDI fetch + TSS personalization + mount lands in the M4 spike (needs the tunnel M3 and Apple's " +
    "TSS signing server). mobile_image_mounter requests are ready.",
  )
}
