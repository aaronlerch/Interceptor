# Fork Delta

Every deliberate deviation of `valid/main` from upstream
`Hacker-Valley-Media/Interceptor` `main`, and why.

Read this before and after every upstream merge. A merge is exactly the moment
these can silently revert — each item below names the regression test or gate
that should catch it if it does.

Fork point: `86e7eb6` (upstream v0.16.9, 2026-06-07).
Last merged: `a1739f9` (upstream v0.22.37).

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
  directory's diff on every merge.

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
6. Update the "Last merged" line at the top of this file.
