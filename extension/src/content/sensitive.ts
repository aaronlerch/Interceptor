/**
 * extension/src/content/sensitive.ts — fields that received a vault secret.
 *
 * issue #244: when the daemon delivers a `--secret` value through `input_text`,
 * the action carries `sensitive: true`. The typed element is remembered here
 * so the content monitor masks its value even when the field is not
 * `type=password` (passcode sheets are often `type=text` or numeric).
 */

const sensitiveElements = new WeakSet<Element>()

export function markSensitive(el: Element): void {
  sensitiveElements.add(el)
}

export function isSensitive(el: Element): boolean {
  return sensitiveElements.has(el)
}

/**
 * True when an element's live value must never be reported in plaintext by a
 * read verb (`tree` / `forms` / `diff` / the element scan). Covers a marked
 * vault-delivery target (above) AND any password input — the daemon's 1Password
 * design keeps the value out of the CLI, but the field still holds it, so a
 * read verb would otherwise hand it straight back. The read paths substitute
 * SECURE_MASK for these. Non-password, unmarked fields stay readable.
 */
export function isValueSecret(el: Element): boolean {
  if (isSensitive(el)) return true
  const type = (el as HTMLInputElement).type
  return typeof type === "string" && type.toLowerCase() === "password"
}

export const SECURE_MASK = "***SECURE***"
