# Merge plan — upstream v0.24.2 → v0.25.0

Target: merge `upstream/main` (`1a0291a`, 10 non-merge commits, 114 files,
+4717/−537) into `my-install`.

Evaluated 2026-09-10. Read alongside `docs/FORK-DELTA.md`.

Fork point of this merge: `452d6fb` (my-install, carries the WS-gate fix below).
Last upstream merged before this: `00ca85f` (v0.24.2).

Install context unchanged from the prior plan: this machine runs from the
source tree — `~/.local/bin/interceptor` symlinked into `dist/`, daemon and
bridge running out of the repo. The bridge IS present here (unlike the v0.24.2
plan's assumption), so bridge-backed surfaces are live, not inert.

---

## 1. Decisions

### D1 — CUT the saved-login credential surface (BLOCKING)

`daemon/browser-creds.ts` (new, 322 lines) reads a Chromium browser's `Login
Data` SQLite DB, decrypts via `/usr/bin/security`, and fills the value into a
page. Daemon-side, **no bridge required** — it works on a browser-only install.
The only gate upstream shipped is `INTERCEPTOR_MCP=1` on *enumeration*, defeated
by `unset INTERCEPTOR_MCP`; the fill (`type --browser-login <host>`) is ungated
by design. Combined with the read-back leak (§3 below) the exfil chain is two
default-allowed CLI calls, no operator. Same escalation class as the removed
`macos sudo`, reachable through a shorter path (needs only the user's browsing
history, not a pre-registered secret). `hostMatches` also accepts a subdomain,
so `attacker.example.com` can request `example.com`'s credential.

**Cut:** `daemon/browser-creds.ts`; `deliverWithBrowserLogin` / browser-creds
handling in `daemon/index.ts`; `cli/commands/browser.ts` + its `BROWSER_CMDS`
wiring in `cli/index.ts`; the `--browser-login` / `--browser` / `--user` rows in
`cli/normalize.ts` and their handling in `cli/commands/actions.ts`; the three
`test/browser-creds*.test.ts` / `test/browser-login-parse.test.ts`; the
`--browser-login` instruction in the browser skill. New fork delta.

### D2 — Hand-resolve the CSP gate; keep it opt-in (BLOCKING)

Upstream inverted the fork's opt-in CSP-strip: strip now runs by default unless
`noCspReload` is set, and `--allow-csp-strip` was dropped from `eval`. Upstream
also deleted both safe fallback steps and its automatic strip lacks the
tab-id-reuse cleanup added in `432017c`. Taking upstream wholesale removes the
gate AND reintroduces the leak.

**Resolve:** keep the fork's `allowCspStrip` threading and `CSP_STRIP_REFUSED`;
take upstream's `frameId` plumbing and `userScriptForms` (Chrome-152 honest
eval-result wrapping). Re-run `test/csp-strip-gate.test.ts` after.

### D3 — Reject the store-identity widening (HIGH)

Upstream adds the public Chrome Web Store extension id to the native-host
`allowed_origins` and pins the store's key into `extension/manifest.json` — so
the fork's own build would share the store id and the public store build would
be authorized to drive the daemon. This install loads unpacked from the repo and
needs neither.

**Reject:** do not add the store id to `daemon/com.interceptor.host.json`; keep
the fork's own `key` in `extension/manifest.json`. New fork delta:
the native-host allowlist names only the fork's own extension identity.

### D4 — iOS stays removed (BLOCKING, mechanical)

The merge deletes the fork's iOS removal on 20 files and *adds* ~45 new iOS
files (including the root `com.interceptor.ios-tunnel` LaunchDaemon and the
NUL-byte `service-clients.ts`). All removed. Verified after: 0 iOS files, root
tunnel helper absent, NUL-byte file absent.

### D5 — Reject iOS agent instructions (HIGH)

Upstream re-adds `.agents/skills/interceptor-ios/**` and two routing directives
in `.agents/skills/interceptor/SKILL.md` pointing agents at the removed surface.
Rejected — these are instructions agents execute, not docs.

### D6 — Take the rest

`monitor task` durable state (stored author JS, MCP-tiered `exec`, fails closed);
tab-group home-window placement; honest eval results; `frameId`; `--frame`
strict-flag additions; identity metadata on the context socket (descriptive,
no authz decision). No new deps, `dist-mv2` re-scan clean, zero new hosts.

---

## 2. Also fixed in this branch (pre-existing, not from the merge)

- **WS control-plane gate** (`452d6fb`, already committed): the daemon WebSocket
  routed `delegate` frames to the bridge as arbitrary `macos_*` actions, bound
  all-interfaces with no Origin check — reachable by any web page and any LAN
  host. Gated to loopback + non-web origin in `daemon/ws-guard.ts`. New fork
  delta. Upstream is still vulnerable.

## 3. Deferred (tracked, not in this merge)

- **Password read-back**: `tree` / `forms` / element reads print `input.value`
  for password fields (`extension/src/content/{data/forms,element-tree,element-discovery,snapshot-diff}.ts`);
  masking (`isSensitive` / `SECURE_MASK`) is consumed only by `monitor.ts`.
  Proven with a sentinel. Undermines the 1Password design. Fix = mask on
  `isSensitive(el) || type === "password"` at the four read sites.
- **`macos cdp raw`** is daemon-resident; reachable by a local caller (no longer
  by a web page, post WS gate). Arbitrary CDP into a relaunched Electron app.

---

## 4. Guards to re-run after merge

`bun run typecheck && bun test`; `bash scripts/audit-capability-blind.sh`;
`cd interceptor-bridge && swift test --filter ExtensionFabricTests`;
iOS grep (`git grep -in '\bios\b' -- cli daemon shared`);
removed-surface grep (`runSudo|macos_sudo|authdialog|BunSecretsVault|secrets.json`);
flag inventory (`test/strict-flags.test.ts` + the four fork flags by hand);
CSP gate (`test/csp-strip-gate.test.ts`); WS gate (`test/ws-guard.test.ts`).
