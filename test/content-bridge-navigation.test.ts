/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { sendToContentScriptOnce } from "../extension/src/background/content-bridge"

type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void

let originalChrome: unknown
let updatedListeners: Set<UpdatedListener>
let sendMessageCallback: ((response: unknown) => void) | undefined
let runtimeState: { lastError?: { message?: string } }
let currentTab: chrome.tabs.Tab

beforeEach(() => {
  originalChrome = (globalThis as { chrome?: unknown }).chrome
  updatedListeners = new Set()
  sendMessageCallback = undefined
  runtimeState = {}
  currentTab = {
    id: 99,
    status: "complete",
    url: "https://example.com/",
  } as chrome.tabs.Tab
  ;(globalThis as { chrome: unknown }).chrome = {
    runtime: runtimeState,
    tabs: {
      get: async () => currentTab,
      onUpdated: {
        addListener: (listener: UpdatedListener) => updatedListeners.add(listener),
        removeListener: (listener: UpdatedListener) => updatedListeners.delete(listener),
      },
      sendMessage: (
        _tabId: number,
        _message: unknown,
        _options: unknown,
        callback: (response: unknown) => void,
      ) => {
        sendMessageCallback = callback
      },
    },
  }
})

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = originalChrome
})

describe("content bridge navigation acknowledgement", () => {
  test("resolves a click when Safari unloads the content script during navigation", async () => {
    const pending = sendToContentScriptOnce(99, { type: "click", ref: "e1" })
    await Promise.resolve()

    expect(updatedListeners.size).toBe(1)
    for (const listener of updatedListeners) {
      listener(99, { status: "loading", url: "https://www.iana.org/help/example-domains" }, {
        id: 99,
        url: "https://www.iana.org/help/example-domains",
      } as chrome.tabs.Tab)
    }

    expect(await pending).toEqual({
      success: true,
      data: {
        navigated: true,
        url: "https://www.iana.org/help/example-domains",
      },
    })
    expect(updatedListeners.size).toBe(0)
    expect(sendMessageCallback).toBeDefined()
  })

  test("keeps the navigation listener after Chromium reports a closed channel", async () => {
    const pending = sendToContentScriptOnce(99, { type: "click", ref: "e1" })
    await Promise.resolve()

    runtimeState.lastError = { message: "message channel is closed" }
    sendMessageCallback?.(undefined)
    currentTab = {
      id: 99,
      status: "loading",
      url: "https://www.iana.org/help/example-domains",
    } as chrome.tabs.Tab
    for (const listener of updatedListeners) {
      listener(99, { status: "loading", url: currentTab.url }, currentTab)
    }

    expect(await pending).toEqual({
      success: true,
      data: {
        navigated: true,
        url: "https://www.iana.org/help/example-domains",
      },
    })
    expect(updatedListeners.size).toBe(0)
  })

  test("ordinary actions still require the content script response", async () => {
    const pending = sendToContentScriptOnce(99, { type: "extract_text" })

    expect(updatedListeners.size).toBe(0)
    sendMessageCallback?.({ success: true, data: "Example Domain" })

    expect(await pending).toEqual({ success: true, data: "Example Domain" })
  })
})
