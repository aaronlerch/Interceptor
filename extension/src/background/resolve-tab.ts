// Working-tab resolution for daemon requests.
//
// Tab-targeted actions (`tab close <id>`, `tab switch <id>`) name their target
// in `action.tabId`; the top-level `msg.tabId` carries only the global `--tab`
// override. The tab handlers act on `action.tabId` whenever it is present, so
// the dispatcher must validate that same tab: an explicit well-formed
// `action.tabId` wins over `--tab`. NaN (the CLI's `parseInt` of a missing
// argument) never counts as explicit — those requests keep the override /
// auto-target semantics.
//
// Import-free on purpose: unit-testable without any chrome stubbing.
export function resolveWorkingTabId(
  msgTabId: number | undefined,
  actionTabId: unknown
): number | undefined {
  if (typeof actionTabId === "number" && !Number.isNaN(actionTabId)) return actionTabId
  return msgTabId
}
