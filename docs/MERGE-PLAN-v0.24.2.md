# Merge plan — upstream v0.22.37 → v0.24.2

Target: merge `origin/main` (fork mirror of `upstream/main`, 159 commits,
249 files, +16,606/−1,344) into `my-install`.

Evaluated 2026-09-05. Read alongside `docs/FORK-DELTA.md`.

Install context that shapes every call below: this machine runs
**browser-only** — `~/.local/bin/interceptor` 0.22.37 built from the fork,
daemon running out of the repo, **no `Interceptor Bridge.app`, no
`~/.interceptor`**. Every bridge-backed macOS verb is already inert here. The
one new privileged surface that does *not* need the bridge is `macos sudo`.

---

## 1. Security findings

### S1 — `macos sudo --secret` is root-by-daemon, and it does not need the bridge (BLOCKING)

`daemon/secrets.ts:356 runSudo()` spawns `/usr/bin/sudo -S -k -p "" -- <cmd>`
and writes the vault value to stdin. It runs **in the daemon**, using
`BunSecretsVault` (login keychain via `Bun.secrets`) — no bridge, no
entitlement, no Touch ID prompt required. On a browser-only install it works.

Two defaults make it sharp:

- `parseGate()` returns `"none"` when `--gate` is omitted (`daemon/secrets.ts:86`).
- `parseTargets()` returns `["any"]` when `--target` is omitted
  (`daemon/secrets.ts:98`), and `targetAllowed()` short-circuits `true` on
  `"any"` for every kind including `sudo` (`daemon/secrets.ts:~135`).

So `interceptor macos secret set mypw --stdin` with no flags produces an
unattended secret usable for `interceptor macos sudo --secret mypw -- <anything>`.
Any local process that can reach the daemon socket gets root with no prompt.
This is the same class as the iOS root tunnel helper the fork already removed
(FORK-DELTA §1), reachable through a shorter path.

Mitigations upstream *did* ship, for the record: the action log records the name
only, values never touch argv, MCP puts `macos:sudo` at `exec` (behind
`INTERCEPTOR_MCP_ALLOW`) and `macos:secret` family-floors at `destructive`. None
of that constrains a direct CLI/daemon caller, which is the actual threat here —
every coding agent on this box has Bash.

**Decision: cut it.** New fork delta.

### S2 — `macos authdialog fill --secret [--submit]` fills the admin prompt

`interceptor-bridge/Sources/Domains/AuthDialogDomain.swift` (+197) drives both
shapes of the macOS administrator prompt. Bridge-backed, so inert on this
install — but it is the same escalation class as S1 and should go with it rather
than sit dormant waiting for a bridge install.

**Decision: cut it.**

### S3 — implicit `any` target on secret registration

Independent of S1/S2. A secret with no `--target` is usable against every
delivery leg. Making `--target` mandatory bounds the blast radius of the vault
to what the operator actually named.

**Decision: drop the implicit `["any"]`; require an explicit target.**

### S4 — `net log` exports carry Authorization headers by default

`--redact-auth` is opt-in (commit `fbb0b07`, issue #160). Export files are
mode 0600, which is right, but the default content is credential-bearing. Agents
export net logs into repos and scratch dirs.

**Decision: flip the default to redacted; add `--no-redact-auth` to opt out.**
Low-cost, one-file change.

### S5 — patched `@modelcontextprotocol/sdk` (accepted, clean)

New `patchedDependencies` entry + `patches/@modelcontextprotocol%2Fsdk@1.29.0.patch`.
Read in full: four `import process from "node:process"` → `globalThis.process`
rewrites in the stdio transports. No injected behavior. Rationale is a real Bun
`--compile` bug that truncates piped stdout at 64 KiB (issue #183).

**Accept.** Note it in FORK-DELTA's accepted list — the patch must be
regenerated, not deleted, on any SDK bump.

### S6 — scans that came back clean

- **New remote hosts across the whole diff (added lines, code only):** none.
  Only `example.com`/`.invalid`/`.example` fixtures, `x.com`, `github.com`,
  `registry.npmjs.org`, `api.nuget.org`, `aka.ms`, `timestamp.acs.microsoft.com`
  (the last four are Windows/winget/signtool build plumbing), `127.0.0.1`.
- **`extension/dist-mv2/*.js` rescan (FORK-DELTA merge checklist step 3):** the
  upstream bundles reference only `example.invalid` and `www.w3.org` — the same
  two as before. No behavioral surprise hiding in build output.
- **`.agents/rules/**` and `.agents/skills/**` (checklist step 2):** 19 files.
  All engineering guidance (flag contract, MCP control plane, the SDK patch
  rule, group/reuse semantics). Nothing instruction-shaped that redirects an
  agent's behavior against the operator.
- **`websearch` (`extension/src/background/capabilities/search.ts`):** uses
  `chrome.search.query` against the browser's own configured default provider
  into an already-managed tab. No third-party API, no key, no new egress.
  Correctly demoted out of the MCP `READ` tier because it changes tab state.
- **Stealth de-branding (#178, `extension/src/inject-keys.ts`):** moves MAIN-world
  guards, the canvas-observer channel and the Trusted-Types policy names to
  `Symbol.for()` keys with opaque registry strings. Strictly reduces the
  fingerprint. Honest about scope in its own comments
  (`getOwnPropertySymbols` still lists them).

### S7 — fork deltas: exposure check

| Fork delta | Upstream touched it? | Risk |
|---|---|---|
| §1 iOS surface removed | Yes — 12 iOS files modified | **modify/delete conflicts only.** Resolve = stay deleted. |
| §2 CSP strip opt-in | `evaluate.ts` +9/−7 | **Low.** Change is the TT-policy de-branding; `merge-tree` auto-merges it clean. Re-assert `test/csp-strip-gate.test.ts` after. |
| §3 Extension Fabric fail-closed | `ExtensionFabric.swift` **untouched** | **None.** |
| §4 dormant-until-attached | `message-dispatch.ts` +82/−22 | **Highest.** Real content conflict, hand-resolve. |

---

## 2. Efficacy — what is worth taking

Ranked by what actually bites this install.

**Take, high value:**

- **Non-zero exit codes on browser verb failure (#237)** — scripted/agent use
  currently cannot tell success from failure. Single biggest correctness win.
- **Derived per-session tab groups + named-group reuse + guarded idle sweep**
  (`e35204e`, `c808891`, `a0aeda5`, `f678c41`, `6075426`) — upstream's own
  trigger was one research session piling up 224 tabs. Sweep guards are sound:
  managed groups only, never the focused window's active tab, never pinned or
  audible, never a window's last tab, and an injected dirty-form check because
  `chrome.tabs.remove` bypasses `beforeunload`.
- **`os_*` window-ownership fix (#166, `33e1725`)** — `os_click`/`os_move`/
  `os_type`/`os_key` derived screen coordinates from
  `chrome.windows.getCurrent()`, i.e. the last-focused window, not the window
  owning the target tab. A `--trusted` click at a background tab landed in
  whatever was frontmost **and reported success**; `os_type` leaked keystrokes
  the same way. Now refuses with a hint. This is a silent-wrong-action bug fixed.
- **64 KiB piped-stdout truncation in compiled binaries (#183)** and **WS
  `maxPayloadLength` raised to the 64 MiB frame cap** — both bite large reads
  and screenshots.
- **Daemon singleton + self-heal + partial-socket-write backpressure**
  (#227/#228/#229) — the port is the singleton token, the owner answers
  `/health` and restores its own runtime files; orphaned unix listener is
  stopped before re-listening. Directly relevant given the two daemon processes
  currently live on this box.
- **Strict flag contract (#212, `fbb0b07`)** — unknown flags now exit 1 naming
  the flag instead of being swallowed. **This retires a known local gotcha:**
  flags after `act eN` were silently typed as literal text. Also fixes
  `type e1 999 --frame 4897` typing the flags.
- **Stale-extension detection (#241)** — extensions report version at
  registration; `diagnose` names a stale snapshot and the reload fix.
- **Canvas realm fixes** (`9854e56`, `e619e72`, `2e4b151`, `0cade95`) — the
  observer reads from the page-canonical realm; `undefined` args survive the
  userScripts hop.
- **`click --selector`, `query`→`e<ref>` bridge, delivered-input no-replay**
  (`d54f790`, `e009192`, `ff26a9d`).
- **`websearch` + hybrid framed find** (#213).
- **`back`/`forward` page-side `history.go` fallback** when the tabs API refuses
  Interceptor-created entries.
- **Idle-spin watchdog (#216)** — recycles a daemon burning CPU with nothing to
  do. `INTERCEPTOR_SPIN_WATCHDOG=off` disables.

**Take but irrelevant here (no action, just carried):** the Windows installer
lane (`scripts/installer/**` +1,386, `install.ps1` +312, winget manifests,
signtool quoting, runner pins), and `bench-head-to-head/**` (a dev-only
head-to-head harness driven by the codex CLI; nothing ships).

**Do not take:** the iOS runner work (`ios/InterceptorRunner/**`,
`daemon/ios/**`, `cli/commands/ios.ts`, `shared/ios-device.ts`,
`.agents/skills/interceptor-ios/**`) — FORK-DELTA §1 stands.

---

## 3. Adherence to the fork's principles

| Principle | Verdict |
|---|---|
| No device control | Upheld, mechanically — every iOS path is a modify/delete conflict resolved as "stay deleted". Re-run the grep guard after. |
| Privileged capability fails closed | **Violated by S1/S2/S3.** `sudo` + `any` + `gate:none` is open-by-default root. Fixed by the cuts below. |
| Chrome-first, browser-only in practice | Upheld. No bridge installed; the new macOS surface is inert apart from `macos sudo`. |
| Keep the capability, gate the cost (FORK-DELTA §2's framing) | Applied to S3/S4 (require a target, redact by default). **Not** applied to S1/S2 — for root escalation, removing the surface removes the class, same call as iOS. |

---

## 4. Execution

### Phase 0 — prep

```
git checkout -b merge/v0.24.2 my-install
bun run typecheck && bun test          # record the pre-merge baseline
```

### Phase 1 — the merge

```
git merge origin/main
```

25 conflicted paths, expected resolution policy:

| Group | Files | Resolution |
|---|---|---|
| iOS modify/delete | `cli/commands/ios.ts`, `daemon/ios/{channel,keychain,manager,usbmux-forward}.ts`, `ios/InterceptorRunner/Sources/{InterceptorRunnerUITests.swift,ObjCSupport.h,ObjCSupport.m}`, `shared/ios-device.ts`, `test/ios-keychain.test.ts`, `.agents/skills/interceptor-ios/{SKILL.md,references/command-catalog.md}` | `git rm` — stay deleted (11 files) |
| dist-mv2 | `extension/dist-mv2/{background-electron,inject-canvas}.js` | take upstream, then **regenerate from fork source** in Phase 3 |
| Fork-delta content | `extension/src/background/message-dispatch.ts` (dormant-until-attached, §4) | hand-resolve; keep dormancy, absorb upstream's dispatch additions |
| Tier table | `cli/mcp/tiers.ts` | take upstream's new families, drop every `ios:*` row |
| CLI surface | `cli/index.ts`, `cli/help.ts`, `cli/transport.ts`, `cli/commands/diagnose.ts` | take upstream, strip iOS + (Phase 2) sudo/authdialog entries |
| Daemon | `daemon/index.ts` | take upstream, strip iOS routes; Phase 2 strips the sudo leg |
| Extension | `extension/src/inject-canvas.ts` | take upstream (canvas realm + inject-keys) |
| Docs / release | `README.md`, `ARCHITECTURE.md`, `scripts/release.sh` | take upstream, strip iOS sections and steps |

### Phase 2 — replace the keychain vault with 1Password

Upstream hand-rolled a vault, a biometric gate, unlock windows and a target
allowlist. 1Password already provides all four, and provides them **without the
bridge this install does not have**. The whole `daemon/secrets.ts` store layer,
`SecretsDomain.swift`, the `AuthDomain` LAContext gate and
`~/.interceptor/secrets.json` get deleted; `op` replaces them.

#### Verified environment facts (2026-09-05)

- `op` 2.34.1 at **`/opt/homebrew/bin/op`**.
- Two accounts signed in (one work tenant, one personal), which is what makes
  the account-ambiguity handling load-bearing rather than theoretical.
- **The daemon's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`** (read off the running daemon)
  — `/opt/homebrew/bin` is not on it. `op` must be invoked by absolute path,
  resolved from a candidate list, never by bare name.
- **`op` works from a detached, stripped-environment process.** Probed with
  `nohup env -i HOME=... PATH=/usr/bin:/bin:/usr/sbin:/sbin op vault list` and
  a disowned child: 1,840 bytes of vault JSON, empty stderr, no prompt. The
  desktop-app integration authenticates on the user session, not on inherited
  env, so **the daemon can resolve secrets itself**.
- **`op read` with no `--account` silently picks one account.** A bogus
  reference got past auth and failed on vault lookup rather than on account
  ambiguity. With two accounts signed in, an unqualified reference can resolve
  against the wrong one.

#### Design

**Resolution stays in the daemon.** `deliverWithSecret()` (`daemon/index.ts`,
~line 655) is already the single choke point: it derives the real target,
resolves, emits `secret_release`, and hands the value to exactly one delivery
leg — and the `os_type` leg is deliberately built so the value never leaves the
daemon process at all. Moving resolution into the CLI would put the value in a
second process and give up the check-before-read ordering for nothing. The CLI
forwards a *reference*; only the daemon ever holds a value.

**The flag keeps its name and changes its meaning.** `--secret` now takes a
1Password secret reference, which already covers both forms asked for — vault
and item may each be a name or a UUID:

```
interceptor type e5 --secret "op://Private/Gmail/password"
interceptor type e5 --secret "op://Private/kqp3s.../password"
```

Every existing `--secret` call site (`browser type`, `macos type`) keeps
working unchanged. No new flag surface.

**Account is explicit or it fails.** `--op-account <shorthand>`, defaulting to
`INTERCEPTOR_OP_ACCOUNT`. With neither set and more than one account signed in,
refuse — do not let `op` guess. Single-account machines need no flag.

**The target allowlist moves into 1Password.** Before reading the field, the
daemon runs `op item get <item> --format json` (metadata only, no secret) and
checks the derived real target — the tab's URL host, the frontmost bundle id —
against the item's own `urls`. The item already knows which site it belongs to;
a parallel allowlist in `~/.interceptor/secrets.json` was duplicate state.
An item with **no** `urls` refuses browser delivery unless `--op-any-target` is
passed. Fail closed on missing metadata.

**The gate is 1Password's.** Touch ID, unlock timeout, and lock-on-sleep are
the desktop app's, already configured, and work with no bridge.
`secret register|set|list|rm|status|unlock|lock|reveal`, `openUnlock`,
`isUnlocked`, `gateViaBridge` and the `SecretGate` type all delete — `op item
create` / `op item list` / `op item delete` are the store commands, and
`reveal` becomes `op read`, run by the operator, never by the daemon.

**`OP_SERVICE_ACCOUNT_TOKEN` is a deliberate non-goal.** It bypasses biometrics
and turns the vault back into an unattended credential store, which is the
thing S1 is about. Document it as unsupported.

#### What still gets cut outright

- **`macos sudo`** (S1) — `runSudo()`, the `macos_sudo` action type, the CLI
  verb, the transport timeout, the MCP tier row, and the `"sudo"` member of
  `SecretTargetKind`. Removing the union member makes reintroduction a type
  error, the guard shape FORK-DELTA §1 already uses. 1Password does not change
  this call: the problem is a root escalation path reachable from any local
  process, not where the password was stored.
- **`authdialog`** (S2) — `AuthDialogDomain.swift`, the `macos_authdialog`
  delivery leg, the CLI verb, both tier rows.
- **`ios_type` / `ios_keys` / `ios_unlock` legs** — already gone with FORK-DELTA §1.
- **S3 is obsolete** — there is no `parseTargets` default to fix once the
  allowlist is 1Password's.
- **S4 still applies** — invert `net log --redact-auth` to `--no-redact-auth`.

#### New module

`daemon/op.ts`, pure and unit-testable, mirroring the shape of the
`daemon/secrets.ts` it replaces:

- `resolveOpBinary()` — candidate list (`/opt/homebrew/bin/op`,
  `/usr/local/bin/op`, `INTERCEPTOR_OP_BIN`), absolute paths only, no PATH search.
- `parseSecretRef(s)` — validates `op://<vault>/<item>/<field>`, rejects
  anything else with an actionable error.
- `itemMetadata(ref, account)` — `op item get --format json`, returns `urls`.
- `targetAllowedByItem(urls, target)` — host match with subdomain support,
  reusing the existing `hostMatches` semantics.
- `readSecret(ref, account)` — `op read`, value returned to the caller and
  never logged.

Every `op` invocation uses `Bun.spawn` with an **argument array**, never string
interpolation, and the value is read from stdout into memory only.

#### Redaction stays

`daemon/redact.ts` (`actionLogSummary`, `outboundLogSummary`) keeps reducing the
action to the reference. An `op://` reference is safe to log — it names a
location, not a value — which is a small improvement over logging a bare
secret name.

#### Regression tests

- `parseSecretRef` rejects a bare name, a `file://`, and a 2-segment `op://`.
- `resolveOpBinary` refuses a relative path and refuses to fall back to PATH.
- Multi-account with no `--op-account` and no `INTERCEPTOR_OP_ACCOUNT` refuses.
- An item with no `urls` refuses browser delivery; passes with `--op-any-target`.
- Host mismatch refuses **before** any `op read` runs (assert call ordering).
- `macos sudo` exits non-zero as an unknown verb; `git grep runSudo` is empty.

### Phase 3 — verification (FORK-DELTA checklist + this merge's additions)

```
bun run typecheck && bun test
bash scripts/audit-capability-blind.sh
git grep -in '\bios\b' -- cli daemon shared        # must stay empty
git grep -n 'runSudo\|macos_sudo\|authdialog'      # must stay empty
git grep -n 'BunSecretsVault\|secrets.json\|SecretGate'  # must stay empty
```

- `test/csp-strip-gate.test.ts` still green (FORK-DELTA §2 intact).
- `swift test --filter ExtensionFabricTests` — skip-able: the file is untouched
  upstream and no bridge is installed. Note it as `[DEFERRED]` rather than
  claiming it passed.
- Rebuild `extension/dist-mv2` from fork source and re-run the host scan.
- Rebuild + reinstall the CLI, then browser-probe: `interceptor open`, a
  `--group` run, `act` with a flag (must now error, not type it), `screenshot`,
  `net log` export (confirm redaction), and a non-zero exit on a failing verb.

### Phase 4 — memory reconciliation

Post-merge, these recorded local gotchas change and need re-verification:

- `interceptor-act-flags-and-screenshot-cwd` — the "flags after `act eN` are
  typed as text" half is **fixed** by #212.
- `interceptor-tab-attachment-and-minimized-window` — "`navigate` hits the
  newest managed tab" is now mediated by the derived session group.
- `interceptor-background-tab-freezes-animations` — unchanged, still applies.

---

## 5. Sequencing

Phase 2 depends on Phase 1: none of this code exists in `my-install` until the
merge lands it. Order is merge → cut → rewire → verify, in separate commits, so
a bisect can tell an upstream regression from a fork decision.
