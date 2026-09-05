# Interceptor Native — Safety

The native macOS tools are powerful. This page documents the guardrails and your escape hatches.

## Panic hotkey

`Ctrl+Opt+Cmd+Escape` closes every active overlay regardless of owning session or agent. Bridge-side handler — no agent involvement required. Keep it discoverable.

## Permission policy

- **Allow** (observational): `mac_ax_*`, `mac_apps_*`, `mac_frontmost`, `mac_screenshot`, `mac_vision_*`, `mac_nlp_*`, `mac_clipboard_read`, `mac_display_*`, `mac_monitor_*`, `interceptor macos overlay *`, `mac_capture_*`, `mac_audio_*`, `mac_sound_*`, `mac_speech_*`, `mac_scroll`.
- **Ask** (interactive): `mac_click`, `mac_type`, `mac_keys`, `mac_drag`, `mac_app_quit`, `mac_app_hide`, `mac_clipboard_write`.
- **Deny**: none by default — tune per environment.

## Credentials: the secret vault and per-secret target allowlists

There is no frontmost-app denylist. The control that keeps a credential out of the wrong field is the per-secret target allowlist in the vault (`interceptor macos secret`):

- Secrets are stored in the macOS keychain (login keychain via Bun.secrets, or the data protection keychain owned by the signed bridge when the build carries the keychain-access-groups entitlement). Nothing is written to a file; `~/.interceptor/secrets.json` holds names, gates, targets, and release counts only.
- Every delivery is by reference: `type --secret op://<vault>/<item>/<field>` and `macos type --secret op://<vault>/<item>/<field> --op-any-target`. The daemon logs the action first (the reference, which is a location rather than a credential), checks the target against the 1Password item's own URLs, then resolves the value and hands it to exactly one delivery leg. The value never appears in argv, the daemon log, the events file, a monitor transcript, an MCP result, or a diagnose bundle.
- Each secret carries targets: `sudo`, `macos:<bundleId>`, `browser:<host>`, `ios`, or `any`. The daemon checks the real target (frontmost or `--app` bundle id, the tab's URL host, the sudo verb) before the keychain read and refuses a mismatch with `target_denied`.
- The gate is 1Password's, not ours (FORK-DELTA §7). Touch ID, the unlock timeout and lock-on-sleep are the desktop app's settings, and they work with no Interceptor Bridge installed. `OP_SERVICE_ACCOUNT_TOKEN` is unsupported here on purpose: it bypasses biometrics and recreates the unattended-credential-store property that FORK-DELTA §5 exists to remove.
- Browser deliveries mark the field so the content monitor records `***SECURE***` even when the input is not `type=password`.

## TCC permissions (macOS)

`mac_trust` returns the current grant status. Recommended minimum:

- **Accessibility** — for AX + input
- **Screen Recording** — for capture + vision

Optional:

- **Microphone** — for `mac_listen`
- **Input Monitoring** — for `mac_monitor` global key/click capture

The dashboard surfaces a deep-link to `System Settings → Privacy & Security` when a grant is missing (`GET /api/native/permissions`).

## Overlay budget

- Prefer corner-anchored rects over full-screen.
- Set `timeout_seconds` on decorative overlays.
- `interactive: false` unless you need clicks (otherwise the overlay swallows them).

## Stop control

- Active overlays do NOT block session completion.
- Session shutdown tears down every overlay owned by the session.
- Engine crash recovery: orphan overlays are marked `closed_reason=crash` in `native_overlays` table.

## If something goes wrong

1. `Ctrl+Opt+Cmd+Escape` kills all overlays.
2. `/native-restart` restarts the bridge.
3. `kill $(cat /tmp/interceptor-bridge.pid)` if the bridge is unresponsive.
4. `tccutil reset Accessibility com.interceptor.bridge` as last resort (triggers re-grant on next run).
