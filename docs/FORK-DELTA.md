# Fork Delta

Every deliberate deviation of `valid/main` from upstream
`Hacker-Valley-Media/Interceptor` `main`, and why.

Read this before and after every upstream merge. A merge is exactly the moment
these can silently revert — each item below names the regression test or gate
that should catch it if it does.

Fork point: `86e7eb6` (upstream v0.16.9, 2026-06-07).
Last merged: `00ca85f` (upstream v0.24.2, 2026-09-05).

---

## 1. The iOS device surface is removed

**What.** 87 files: `daemon/ios/`, `ios/` (the InterceptorRunner XCUITest
project), `cli/commands/ios*.ts`, `shared/ios-*.ts`, the iOS test suite,
`docs/ios/`, the iOS release/staging steps, and
`.agents/skills/interceptor-ios`. The MCP `interceptor_ios` router and the
`"ios"` tier tables go with it.

**Why.** We don't do device control, and the subsystem carried the worst finding
in the audit: `daemon/ios/tunnel-helper/helper.ts` ran as root under the
`com.interceptor.ios-tunnel` LaunchDaemon, `chmod 666`'d
`/var/run/interceptor-ios-tunnel.sock`, and accepted `{op:"remotectl", args:[…]}`
— arbitrary argv to a root-executed binary from any local process, plus `utun`
interface creation. Removing the surface removes the class.

It also removed `daemon/ios/service-clients.ts`, the only source file in the tree
carrying raw NUL bytes (a literal `\x00` typed into a regex). Ripgrep classified
that file as binary and skipped it, which silently excluded it from every
grep-based audit — including ours, until a `--numstat` pass flagged it.

**Kept on purpose.** `scripts/release/postinstall-full` still boots out
`com.interceptor.ios-tunnel` and deletes its plist and socket. Machines upgraded
from an older install may still carry the root daemon; teardown must keep
running even though we never install it. `daemon/index.ts` still recognises
`--ios-tunnel-helper`, now to refuse it with teardown instructions rather than
fall through into normal daemon startup as root.

**Regression guard.** The `Surfaces`, `CommandSpec.surface`, and MCP `Surface`
unions no longer contain `"ios"`, so reintroducing it is a type error rather
than a silent route. `test/mcp-server.test.ts` asserts `interceptor_ios` is
absent from the registered tools.

---

## 2. The CSP / Trusted-Types header strip is opt-in

**What.** `runWithCspStripBypass` (`extension/src/background/capabilities/
evaluate.ts`) takes `opts.allowCspStrip`. Without it the escalation chain stops
before installing the header-strip rule and returns `CSP_STRIP_REFUSED`. The CLI
surfaces it as `--allow-csp-strip` on `interceptor eval` and `interceptor save`.

**Why.** Upstream reaches the strip automatically on any CSP or Trusted-Types
eval failure. That path installs a per-tab declarativeNetRequest rule removing
`content-security-policy` and `content-security-policy-report-only` — and with
them `require-trusted-types-for` — then reloads the page and retries. With
`<all_urls>` host permissions, page content that reaches `interceptor eval` could
therefore strip a logged-in site's own XSS defenses with no operator in the loop.

**Deliberately unchanged.** Steps 1 and 2 of the chain — the userScripts attempt
and the ISOLATED-world retry — stay automatic. They work *inside* the page's
policy and take nothing away from it, so strict-CSP pages remain readable by
default. Only the step that removes the policy is gated. This is the whole point
of the cut: we kept the capability and gated the cost.

**Regression guard.** `test/csp-strip-gate.test.ts`.

---

## 3. Extension Fabric requires an operator trust policy

**What.** `ExtensionFabric.validateSignature` refuses every dylib when no trust
policy is configured, and the Team-ID allowlist check is mandatory rather than
conditional. `allowUnsigned` / `INTERCEPTOR_EXT_ALLOW_UNSIGNED=1` is the single
explicit "accept anything" switch.

**Why.** The bridge ships with `com.apple.security.cs.disable-library-validation`
and re-imposes library validation in software. Upstream ran the provenance step
only `if !trust.teamIds.isEmpty` — and that list is empty until an operator
writes `~/.interceptor/extension-trust.json`, so the effective default was no
provenance check. A valid signature does not establish provenance: `codesign -s -`
is a valid **ad-hoc** signature carrying no Team Identifier, and it passes
`SecStaticCodeCheckValidity`. Ad-hoc signing any dylib and dropping it into the
user-writable `~/.interceptor/extensions/<name>/bridge/` was therefore enough to
get it `dlopen`'d into the bridge process, which holds the TCC grants.

This fork ships no first-party extension dylibs, so failing closed costs nothing
out of the box.

**Regression guard.** `testDefaultTrustPolicyDeniesAdHocSignedDylib` and
`testTeamAllowlistRejectsAdHocSignature` in `ExtensionFabricTests`. Note the two
pre-existing routing tests now opt in via `INTERCEPTOR_EXT_ALLOW_UNSIGNED` —
if a future merge makes them pass *without* that, the gate has regressed.

---

## 4. Local feature: dormant-until-attached content scripts

Predates the audit (commit `24e2d26`). The four `<all_urls>` content scripts ran
always-on in every tab and froze heavy React/chart pages while Interceptor was
idle. They are now dormant by default and active only while a tab is being
driven. Not a security change — kept here because it is the other reason
`valid/main` diverges, and it is the piece most likely to conflict on merge
(`extension/src/background/message-dispatch.ts` did).

---

## 5. `macos sudo` is removed

**What.** `runSudo()` and its helpers in `daemon/secrets.ts`, the `macos_sudo`
action type and delivery leg in `daemon/index.ts`, the CLI verb, the transport
timeout, the MCP tier row, and the `"sudo"` member of `SecretTargetKind`.

**Why.** Upstream's `interceptor macos sudo --secret <name> -- <cmd>` ran an
arbitrary command as root, and — unlike every other verb added in the 0.24
secret-vault work — it did **not** need the bridge. `runSudo()` executed in the
daemon, spawning `sudo -S -k -p "" -- <cmd>` and writing the vault value to
stdin, reading the value through `Bun.secrets` from the login keychain. On a
browser-only install (no `Interceptor Bridge.app`) it worked.

Two upstream defaults made that sharp. `parseGate()` returned `"none"` when
`--gate` was omitted, and `parseTargets()` returned `["any"]` when `--target`
was omitted, with `targetAllowed()` short-circuiting `true` on `"any"` for every
kind including `sudo`. So `macos secret set pw --stdin` with no flags produced
an unattended root credential usable by any local process that could reach the
daemon socket. Upstream's mitigations — name-only logging, values off argv, MCP
tiering — all constrain the MCP lane; none of them constrain a direct CLI or
daemon caller, which is what every coding agent on this machine is.

Same call as §1, for the same reason: removing the surface removes the class.

**Regression guard.** `SecretTargetKind` no longer contains `"sudo"`, so
reintroducing it is a type error. `test/secret-delivery-cli.test.ts` asserts the
verb no longer parses; `test/mcp-tiers.test.ts` asserts it carries no dedicated
tier, so a reintroduction cannot inherit `exec` and look sanctioned.

---

## 6. `macos authdialog` is removed

**What.** `interceptor-bridge/Sources/Domains/AuthDialogDomain.swift`, its
registration in `main.swift`, its entry on `Router.swift`'s AX-gated list, the
`macos_authdialog` delivery leg, the CLI verb, and both tier rows.

**Why.** Same escalation class as §5 — it filled the macOS administrator prompt
(both shapes: the Touch ID sheet via "Use Password", and the password form) from
the vault, with `--submit` pressing confirm. It is bridge-backed and therefore
inert on this install, but leaving it in place means the class returns the day a
bridge is installed. Removed rather than left dormant.

**Regression guard.** `test/secret-delivery-cli.test.ts` asserts the verb does
not parse. `shared/extensions.ts` no longer lists the `authdialog` capability.

---

## 7. The vault is 1Password, not a hand-rolled keychain store

**What.** `daemon/secrets.ts`, `interceptor-bridge/Sources/Domains/SecretsDomain.swift`,
the `BunSecretsVault` / `BridgeVault` / `LayeredVault` stack, `gateViaBridge`,
the memory-only unlock windows, `~/.interceptor/secrets.json`, and the
`register|set|list|rm|unlock|lock|reveal` verbs are all gone. `daemon/op.ts`
replaces them. `--secret` keeps its name and changes its meaning: it now takes a
1Password secret reference, `op://<vault>/<item>/<field>`.

**Why.** Upstream built four things 1Password already provides — a keychain
store, a biometric gate, unlock windows, and a per-secret target allowlist — and
three of those needed the bridge, which a browser-only install does not have.
`op` provides all four with no bridge at all. The reference form also answers
"address an item by ID or by vault + item name" with one syntax rather than two
flags, because 1Password already lets each segment be a name or a UUID.

**Design.** Resolution stays in the **daemon**. `deliverWithSecret()` is already
the single choke point, and the `os_type` leg is specifically built so the value
never leaves that process; moving resolution into the CLI would put the value in
a second process and give up the check-before-read ordering for nothing. The CLI
forwards a reference; only the daemon ever holds a value.

The target allowlist is the 1Password **item's own `urls`**. The daemon derives
the real target, reads the item's metadata with `op item get` (never a field
value), and matches host-or-subdomain **before** `op read` runs — so a wrong
destination never causes a read. Upstream kept a second copy of that allowlist
in `~/.interceptor/secrets.json`, which could drift from the item it described.
An item with no URLs fails closed; `--op-any-target` is the explicit override
and is *required* for `macos type --secret`, since an item URL cannot describe a
native app.

The gate is 1Password's: Touch ID, unlock timeout and lock-on-sleep are the
desktop app's settings, already configured, and independent of the bridge.

**Two verified environment facts** (probed 2026-09-05; both are load-bearing):

- The daemon's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — read off the running
  daemon, not assumed. Homebrew is **not** on it, so `op` is resolved from an
  absolute-path candidate list (`INTERCEPTOR_OP_BIN` overrides, absolute only).
  A bare-name lookup would fail at delivery time, the worst moment to find out.
- `op` authenticates against the desktop app on the user's session, not on
  inherited environment. Probed with a disowned `env -i` child holding only
  HOME/PATH/USER: it returned vault JSON with no prompt. A long-lived daemon
  therefore authorizes once, where a fresh CLI process per command would prompt
  every time.

**Deliberately unsupported.** `OP_SERVICE_ACCOUNT_TOKEN` — it bypasses
biometrics and recreates exactly the unattended-credential-store property §5
exists to remove.

**Ambiguity fails closed.** `op read` with several accounts signed in and no
`--account` resolves against one of them silently (verified: a bogus reference
got past auth and failed on vault lookup, not on ambiguity). With more than one
account signed in, `--op-account` or `INTERCEPTOR_OP_ACCOUNT` is required.

**Regression guard.** `test/op-secrets.test.ts` (25 cases) covers reference
parsing, absolute-path binary resolution, account disambiguation, the item-URL
target check, and — most importantly — the **ordering**: three cases assert that
a refused target, a URL-less item, and an ambiguous account each fail *before*
`op read` appears in the recorded argv.

---

## 8. `net log` exports redact credential headers by default

**What.** `--redact-auth` (upstream, opt-in) becomes the default;
`--no-redact-auth` is the opt-out.

**Why.** Agents write net-log exports into repos and scratch directories. A file
that silently carries `Authorization` headers is the wrong default whatever its
mode bits are, and the safe direction costs a flag on the rare capture that
genuinely needs credentials in it.

---

## Accepted, not fixed

Findings from the audit we chose to live with. Listed so the decision is
revisitable rather than forgotten.

- **MCP default tier allows READ without opt-in.** `cli/mcp/tiers.ts` fail-closes
  DESTRUCTIVE and EXEC behind `INTERCEPTOR_MCP_ALLOW`, but READ and MUTATE run by
  default, and READ includes `macos:screenshot`, `macos:files`, `macos:log`,
  `macos:contacts` (list/find/vcard) and `macos:photos` (assets/export). Any MCP
  client reaching the server can read the screen, contacts and photos, gated only
  by macOS TCC. We keep MCP and accept this; the tier design itself is sound
  (unknown sub-verbs default to the family's highest tier).
- **~115 transitive packages** arrive with `@modelcontextprotocol/sdk` (express,
  body-parser, cors, jose, eventsource, hono). The transport is stdio-only
  (`cli/commands/mcp.ts`), so no HTTP server starts — but the code is installed.
- **`extension/dist-mv2/*.js`** are ~11k lines of prebuilt bundle committed to
  git and shipped as the MV2/Electron extension with `webRequestBlocking` +
  `<all_urls>`. Scanned clean at merge time (only `example.invalid` and `w3.org`
  appear), but they are not reproducible from source at install time. **Re-scan
  these on every upstream merge** — a behavioral change there reads as
  build-output churn in review.
- **`interceptor skills` / `interceptor mcp install` write into `~/.claude`.**
  Both are explicit user commands and write atomically, but upstream-authored
  `.agents/skills/**` becomes instructions our agents follow. Review that
  directory's diff on every merge. The v0.24.2 merge is the proof this matters:
  the skills still told agents to run `macos secret register`, to fill the admin
  prompt with `authdialog fill --secret … --submit`, and to reach for
  `interceptor macos sudo` — all removed here. Stale *instructions* outlive
  removed *code*, and they are what a future session will actually follow.
- **`interceptor skills` may still install `interceptor-ios`.** The skill
  package is deleted from this tree, but a previously-installed copy in
  `~/.claude/skills/` is not removed by merging. Check for and delete it.
- **The dormancy events are branded strings on `document`.**
  `__interceptor_canvas_set` and `__interceptor_set_active` (fork-local, §4) are
  the kind of vendor-named identifier upstream's #178 de-branding removed
  everywhere else. `document` CustomEvent types are not enumerable the way
  `window` properties are, so the one-line `Object.keys` grep does not find
  them — but a targeted detector still can. Not fixed; recorded so it is a
  decision rather than an oversight.
- **`validateContextRouting` still accepts an optional `iosContexts`** and
  carries iOS-labeled disambiguation strings (`daemon/outbound-routing.ts`).
  Dead since §1; harmless, and left alone rather than widening this merge.

---

## Merge checklist

1. `git fetch origin && git log --oneline valid/main..origin/main`
2. Review `.agents/skills/**` and `.agents/rules/**` diffs — these are agent
   instructions, not docs.
3. Re-scan `extension/dist-mv2/*.js` for new remote hosts.
4. Merge, then confirm each guard above still holds:
   - `bun run typecheck && bun test`
   - `bash scripts/audit-capability-blind.sh`
   - `cd interceptor-bridge && swift test --filter ExtensionFabricTests`
5. Re-grep for a reintroduced iOS surface: `git grep -in '\bios\b' -- cli daemon shared`
6. Re-grep for the removed escalation surfaces:
   `git grep -n 'runSudo\|macos_sudo\|authdialog\|BunSecretsVault\|secrets.json'`
7. **Check the flag inventory.** Upstream's strict flag contract (#212) rejects
   any `--flag` missing from `cli/normalize.ts`'s tables, so a fork-local flag
   that is not declared there stops working *silently* at the CLI boundary
   rather than failing in a way a type-check catches. Ours:
   `--allow-csp-strip` (§2), `--op-account` and `--op-any-target` (§7),
   `--no-redact-auth` (§8). `test/strict-flags.test.ts` walks the inventory in
   both directions and is the guard — do not skip it.
8. **Re-read `.agents/skills/**` for stale instructions, not just stale code.**
   A merge can leave an agent-facing doc telling agents to run a verb this fork
   deleted. Grep the skills for every removed verb by name.
9. Update the "Last merged" line at the top of this file.
