/**
 * cli/commands/group.ts — named per-agent tab groups.
 *
 *   interceptor group list             All live tab groups (label, title, color, tab count)
 *   interceptor group close <label>    Atomically close every tab in a named group
 *
 * Scoping day-to-day work into a group is the global `--group <label>` flag
 * (or $INTERCEPTOR_GROUP), not a subcommand here.
 */

import { GROUP_LABEL_RE } from "../parse"

type Action = { type: string; [key: string]: unknown }

export function parseGroupCommand(filtered: string[]): Action {
  const sub = filtered[1]

  if (sub === "list" || sub === undefined) {
    return { type: "group_list" }
  }

  if (sub === "close") {
    const label = filtered[2]
    if (!label || !GROUP_LABEL_RE.test(label)) {
      console.error("error: usage: interceptor group close <label>   (label: [A-Za-z0-9_-]{1,32})")
      process.exit(1)
    }
    return { type: "group_close", label }
  }

  console.error("error: usage: interceptor group list | interceptor group close <label>")
  process.exit(1)
}
