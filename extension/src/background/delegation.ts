import { emitEvent } from "./transport"

// Human→agent intent handoff. A right-click menu item or a keyboard command
// packages what the human pointed at (selection, link, image, page) into a
// `delegation_intent` event on the daemon's event bus, which an agent reads via
// `interceptor delegate log`. No page instrumentation, no CDP.

type Ctx = `${chrome.contextMenus.ContextType}`
type MenuItem = { id: string; title: string; contexts: [Ctx, ...Ctx[]] }

const MENU_ITEMS: MenuItem[] = [
  { id: "delegate-selection", title: "Hand this selection to the agent", contexts: ["selection"] },
  { id: "delegate-link", title: "Hand this link to the agent", contexts: ["link"] },
  { id: "delegate-image", title: "Hand this image to the agent", contexts: ["image"] },
  { id: "delegate-page", title: "Hand this page to the agent", contexts: ["page"] },
]

function emitDelegation(
  source: "context_menu" | "command",
  fields: Record<string, unknown>
): void {
  const payload: Record<string, unknown> = { source }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") payload[k] = v
  }
  emitEvent("delegation_intent", payload)
}

function createMenus(): void {
  // removeAll first so re-install/update doesn't throw duplicate-id.
  chrome.contextMenus.removeAll(() => {
    // Reading lastError clears the "unchecked runtime.lastError" console noise.
    void chrome.runtime.lastError
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({ id: item.id, title: item.title, contexts: item.contexts })
    }
  })
}

async function getSelectionText(tabId: number): Promise<string | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() || "",
    })
    const text = results[0]?.result as string | undefined
    return text || undefined
  } catch {
    return undefined
  }
}

export function registerDelegationListeners(): void {
  // Menus are created on install/update and persist across SW restarts, so this
  // is the only place they're created (creating them on every SW wake would
  // throw duplicate-id).
  chrome.runtime.onInstalled.addListener(createMenus)

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    emitDelegation("context_menu", {
      menuItemId: info.menuItemId,
      selectionText: info.selectionText,
      linkUrl: info.linkUrl,
      srcUrl: info.srcUrl,
      mediaType: info.mediaType,
      editable: info.editable,
      pageUrl: info.pageUrl ?? tab?.url,
      tabId: tab?.id,
      tabTitle: tab?.title,
    })
  })

  chrome.commands.onCommand.addListener(async (command, tab) => {
    const fields: Record<string, unknown> = {
      command,
      tabId: tab?.id,
      pageUrl: tab?.url,
      tabTitle: tab?.title,
    }
    if (command === "delegate-selection" && tab?.id !== undefined) {
      fields.selectionText = await getSelectionText(tab.id)
    }
    emitDelegation("command", fields)
  })
}
