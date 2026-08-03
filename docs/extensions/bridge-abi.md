# Extension Bridge ABI + Signing Policy

A bridge-domain extension is a native dylib that the Interceptor bridge `dlopen`s
at startup and drives through a small, **serialized C ABI**. The bridge's
`DomainHandler` is a Swift protocol whose method takes `[String: Any]` and an
`@escaping @Sendable` closure — none of which is C-ABI-expressible — so an
extension does **not** vend a Swift existential. It exports flat C symbols; the
bridge wraps them in a Swift adapter that conforms to `DomainHandler`.

## Exported symbols

```c
// REQUIRED — must return the ABI version the bridge supports (currently 1).
uint32_t itc_ext_abi_version(void);

// REQUIRED — the manifest `entry` symbol. Handle one command and return a
// malloc'd, NUL-terminated JSON object string (the bridge result envelope).
char *itc_ext_handle(const char *commandJSON, const char *actionJSON);

// OPTIONAL — free a pointer returned by the entry. If absent, the bridge frees
// with free(). Export this if your handler does not allocate with malloc().
void itc_ext_free(char *ptr);
```

`itc_ext_abi_version` mismatch, a missing `entry` symbol, or a `dlopen` failure
causes the bridge to **skip + log** that domain (never fatal).

## Envelope format

- `commandJSON` — the verb envelope `{"command":"<verb>"}`. The bridge delivers
  the verb here, taken from the `Router`'s `command` (the third `_`-segment of the
  action type), **not** `action["sub"]`. For `macos_<prefix>_<cmd>` the verb is
  `<cmd>`.
- `actionJSON` — the full action object as JSON, e.g.
  `{"type":"macos_<prefix>_<cmd>","sub":"<cmd>","args":[…],"flags":{…}}`.
- **Return value** — a malloc'd JSON **object** string. Use the standard envelope:
  - success: `{"success":true,"data":<any-json>}`
  - error:   `{"success":false,"error":"<message>"}`
  A non-object or unparseable return is reported as an extension error.

## Ownership / async

- The bridge owns the returned pointer and frees it (`itc_ext_free` if exported,
  else `free`). Do not return a pointer to static or stack memory.
- `itc_ext_handle` is **synchronous**. The bridge adapter calls it on a background
  queue (it does not block the bridge's main pump) and then invokes the
  `DomainHandler` completion with the parsed result. If you need to do async work,
  block inside `itc_ext_handle` until you have the result, then return it.

## Minimal handler

```c
#include <stdlib.h>
#include <string.h>
uint32_t itc_ext_abi_version(void) { return 1; }
char *itc_ext_handle(const char *commandJSON, const char *actionJSON) {
    // parse commandJSON / actionJSON (any JSON lib), do the work, build a result
    const char *ok = "{\"success\":true,\"data\":{}}";
    char *out = (char *)malloc(strlen(ok) + 1);
    strcpy(out, ok);
    return out;
}
void itc_ext_free(char *p) { free(p); }
```

## Signing policy — software-imposed library validation (C19)

The shipped bridge is hardened-signed but carries
`com.apple.security.cs.disable-library-validation`, so the OS will load a
foreign-team dylib without an entitlement change. Because that OS guarantee is
off, the loader re-imposes it **in software** before `dlopen`:

0. **Policy** — an operator trust policy must exist. With none configured, every
   extension dylib is refused. *(Fork hardening — see below.)*
1. **Integrity** — `SecStaticCodeCreateWithPath` + `SecStaticCodeCheckValidity`
   with `kSecCSCheckAllArchitectures` (Apple's docs warn that without it only one
   slice of a universal binary is validated, and a slice could be ad-hoc/unsigned).
2. **Provenance** — the dylib's `kSecCodeInfoTeamIdentifier` (via
   `SecCodeCopySigningInformation`) must be in the operator's Team-ID allowlist.
   This check is **mandatory**, not conditional.
3. An **unsigned** dylib reports `errSecCSUnsigned`; it is loaded only under the
   explicit opt-in.

### Operator trust config

`~/.interceptor/extension-trust.json`:

```json
{ "teamIds": ["ABCDE12345"], "allowUnsigned": false }
```

Environment overrides:

- `INTERCEPTOR_EXT_TEAM_IDS="ABCDE12345,FGHIJ67890"` — comma-separated allowlist.
- `INTERCEPTOR_EXT_ALLOW_UNSIGNED=1` — the accept-anything opt-in. Skips both the
  unsigned rejection *and* the Team-ID requirement. Local development only.

**This fork fails closed.** Upstream ran the provenance check only when an
allowlist happened to be configured — and it is empty until an operator writes
one, so by default *any validly signed dylib loaded*. A valid signature says
nothing about who produced it: `codesign -s -` is a valid **ad-hoc** signature
that carries no Team Identifier at all, so ad-hoc signing any dylib dropped into
the user-writable `~/.interceptor/extensions/*/` was sufficient to get it
`dlopen`'d into the TCC-privileged bridge.

Now: no policy ⇒ nothing loads. To use an extension, sign it with your own
identity (`codesign -s "<identity>" handler.dylib`) and pin that Team ID in the
trust config. An ad-hoc signature can never satisfy an allowlist — it has no team
to match — so development fixtures need `INTERCEPTOR_EXT_ALLOW_UNSIGNED=1`.

## Prefix rules (recap)

- `bridgeDomains[].prefix` is one lowercase token `^[a-z][a-z0-9]*$`.
- It must not collide with a built-in domain — the loader reserves the live
  `Router` key set and skips collisions.
- `macos_<prefix>_<cmd>` routes to your handler with `command = <cmd>`.
