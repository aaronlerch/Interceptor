# Accessibility And Input

## AX tree

Refs (`e1`, `e2`, ...) work the same as browser refs. AXObserver auto-invalidates the tree when the app changes — re-read before acting on a stale ref.

```bash
interceptor macos tree                           # Frontmost app, interactive elements only (default filter)
interceptor macos tree --app "Finder"            # Specific app (auto-wakes Electron via AXManualAccessibility)
interceptor macos tree --filter all              # Include non-interactive nodes (groups, static text)
interceptor macos tree --depth 5                 # Limit depth (default unbounded)
interceptor macos find "Save" --role button      # Find by accessible name + role
interceptor macos focused                        # Current focused element
interceptor macos windows                        # All windows with frames (top-left x/y, width/height)
interceptor macos windows --app "Brave Browser"
interceptor macos inspect e5                     # All AX attributes + actions for a ref
interceptor macos value e5                       # Read element value (text fields, sliders)
interceptor macos value e5 "new text"            # Set element value
interceptor macos action e5 press                # Perform a named AX action (press, increment, decrement, ...)
```

## Use the AX tree before raw input

- Use `tree`, `find`, `focused`, `value`, `action`, and `windows` to understand the frontmost app first.
- Use `click`, `type`, `keys`, `scroll`, `drag`, `move`, `resize` only when the AX tree has identified the right target.
- Let interceptor escalate to CGEvent click when an AX action is rejected — or pass coordinates to `click X,Y` directly when you need precision.

## Input (CGEvent — OS-level trusted)

```bash
interceptor macos click e5                       # Click AX element by ref (AX action; escalates to CGEvent at frame center on failure)
interceptor macos click 500,300                  # Click at viewport coordinates
interceptor macos click e5 --double              # Double-click
interceptor macos click e5 --right               # Right-click
interceptor macos type e5 "hello world"          # Focus + type
interceptor macos type "hello world"             # Type at current focus (no ref)
interceptor macos keys "Meta+C"                  # Keyboard shortcut (Meta = Command)
interceptor macos scroll e5 --down 300           # Scroll an AX-targeted element
interceptor macos scroll down 400 --app "Mail"   # Scroll a backgrounded app via CGEvent.postToPid
interceptor macos drag e5 e8                     # Drag between elements
```

## Window control

```bash
interceptor macos windows --app "Brave Browser"
interceptor macos move e1 --x 0 --y 25
interceptor macos resize e1 --width 672 --height 983
```

## Compound surface for AX

```bash
interceptor macos open "Finder"                  # Background open + tree + windows in one call
interceptor macos read                           # Tree + frontmost app info
interceptor macos act e5                         # Click + wait + updated tree
interceptor macos act e3 "hello"                 # Type + wait + updated tree
interceptor macos inspect                        # Tree + apps + frontmost info
```

`act` mirrors the browser side: read, change, re-read in one call. Use the narrower commands (`click`, `type`, `keys`) when you specifically don't want a follow-up tree read.

## Credentials: deliver by name, never by value

There is no frontmost-app denylist. Credentials come from 1Password and are delivered by reference:

```bash
interceptor macos type <ref> --secret op://<vault>/<item>/<field> --op-any-target   # AX value-set, then keystrokes; value resolved in the daemon
```

The vault is **1Password** (FORK-DELTA §7). `--secret` takes a reference: `op://<vault>/<item>/<field>`, where vault and item may each be a name or a UUID. The daemon checks the delivery target against the ITEM's own website URLs before `op read` runs; a mismatch fails with `target_denied`. A native-app target has no URL to match, so `macos type --secret` requires `--op-any-target`. Pass `--op-account <shorthand>` (or set `INTERCEPTOR_OP_ACCOUNT`) when more than one 1Password account is signed in. Never put a password in a literal `type` call: `--secret` and literal text are mutually exclusive. Store items with `op item create`; there is no `interceptor macos secret register|set`.

## Common mistakes

- Reflexively calling `interceptor macos app activate` before a capture / AX read / scroll. Not needed; the bridge has background paths for all of those (see Background First in the parent SKILL.md).
- Acting on a stale `eN` ref after the app changed. AXObserver invalidates refs aggressively — re-read.
- Trying to read browser tab content via `interceptor macos tree`. The AX tree of a Chrome window stops at the tab strip; switch to `interceptor-browser` for in-page content.
- Granting Accessibility but not Screen Recording, then expecting `screenshot --app "X"` to work. Run `interceptor macos trust` to confirm.
