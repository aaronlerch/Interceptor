/**
 * shared/upload.ts — helpers for the `interceptor upload` file-attach verb.
 */

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  "3gp": "video/3gpp",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  // Audio — the set real upload areas (e.g. ElevenLabs voice-clone) gate on.
  // A missing entry falls to application/octet-stream, which MIME-checking
  // dropzones (react-dropzone / attr-accept) silently reject.
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  weba: "audio/webm",
}

/** Infer a MIME type from a file name's extension. Defaults to octet-stream. */
export function inferMime(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  if (dot < 0 || dot === fileName.length - 1) return "application/octet-stream"
  const ext = fileName.slice(dot + 1).toLowerCase()
  return EXT_MIME[ext] || "application/octet-stream"
}

/** Basename of a path, handling both / and \ separators. */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || "file"
}

/**
 * Split a base64 payload into fixed-size pieces for chunked upload.
 * Lossless: `chunkBase64(s, n).join("") === s`. Kept here (not inline in the CLI)
 * so the split is unit-testable and matches the extension-side reassembly.
 */
export function chunkBase64(full: string, chunkSize: number): string[] {
  const out: string[] = []
  for (let i = 0; i < full.length; i += chunkSize) out.push(full.slice(i, i + chunkSize))
  return out
}
