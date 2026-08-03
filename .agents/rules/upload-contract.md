---
paths:
  - "cli/commands/actions.ts"
  - "cli/transport.ts"
  - "shared/upload.ts"
  - "extension/src/content/actions/file.ts"
  - "extension/src/inject-net.ts"
---

# File-upload contract

`interceptor upload` attaches a local file with no CDP and no OS dialog. These
files implement one path. Keep the invariants and extend
`extension/src/content/actions/file.test.ts` whenever you touch it.

1. **Bytes never ride an unchecked socket write.** Both the CLI (`transport.ts`)
   and the daemon frame length-prefixed messages, and `socket.write()` can
   partial-write a large frame — the remainder MUST be queued and flushed on the
   `drain` event. A single unchecked `socket.write()` silently truncates any
   frame past the socket send buffer, and the peer then blocks forever.
2. **Large files chunk; small files single-shot.** Above `UPLOAD_CHUNK_B64_BYTES`
   (`shared/platform.ts`) the CLI splits the base64 into sequential
   `file_upload_chunk` actions plus a final assemble message; each chunk stays
   under the browser's native-messaging limit so every transport carries it. Do
   not raise the chunk size past that limit, and do not send a whole large file
   in one frame.
3. **The content handler prefers the real input.** `findFileInput` searches the
   element, its descendants, a few ancestors, then the page's sole file input;
   setting `input.files` + firing `input`/`change` is `isTrusted`-independent.
   The dropzone/trusted-drop bridge and the picker-stage path are fallbacks, and
   success is reported honestly via a `verified` flag — never claim success on a
   fire-and-forget drop.
4. **MIME must satisfy the site's `accept`.** `inferMime` maps by extension; a
   missing entry falls to `application/octet-stream`, which MIME-checking
   dropzones silently reject. Add the type rather than shipping octet-stream.

A change to the wire protocol (chunk action shape, frame caps) must also update
the "Transport routing (daemon)" section of `ARCHITECTURE.md`.
