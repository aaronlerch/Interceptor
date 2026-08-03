import { describe, expect, test } from "bun:test"
import {
  SAFARI_NATIVE_RELAY_APPLICATION_ID,
  SAFARI_NATIVE_RELAY_MESSAGE_TYPE,
  SafariNativeRelayClient,
  type SafariNativeRelayRuntime,
} from "../extension/src/background/safari-native-relay"

describe("Safari native relay client", () => {
  test("exchanges queued responses and delivers daemon messages", async () => {
    let applicationId = ""
    let envelope: Record<string, unknown> = {}
    const delivered: unknown[] = []
    const runtime: SafariNativeRelayRuntime = {
      sendNativeMessage: async (appId, message) => {
        applicationId = appId
        envelope = message as Record<string, unknown>
        return {
          connected: true,
          messages: [
            { type: "context_registered", contextId: "safari" },
            { id: "request-1", action: { type: "tabs" } },
          ],
        }
      },
    }
    const client = new SafariNativeRelayClient({
      runtime,
      contextId: "safari",
      waitMilliseconds: 750,
      onMessage: (message) => { delivered.push(message) },
    })
    client.enqueue({ id: "response-0", result: { success: true } })

    const result = await client.exchangeOnce()

    expect(applicationId).toBe(SAFARI_NATIVE_RELAY_APPLICATION_ID)
    expect(envelope).toEqual({
      type: SAFARI_NATIVE_RELAY_MESSAGE_TYPE,
      contextId: "safari",
      outbound: [{ id: "response-0", result: { success: true } }],
      waitMilliseconds: 750,
    })
    expect(result).toEqual({ connected: true, received: 2 })
    expect(delivered).toHaveLength(2)
  })

  test("retains outbound messages when a native exchange fails", async () => {
    const envelopes: Array<Record<string, unknown>> = []
    let attempt = 0
    const runtime: SafariNativeRelayRuntime = {
      sendNativeMessage: async (_appId, message) => {
        envelopes.push(message as Record<string, unknown>)
        attempt += 1
        if (attempt === 1) throw new Error("appex unavailable")
        return { connected: true, messages: [] }
      },
    }
    const client = new SafariNativeRelayClient({
      runtime,
      contextId: "safari",
      onMessage: () => {},
    })
    client.enqueue({ id: "response-1" })

    await expect(client.exchangeOnce()).rejects.toThrow("appex unavailable")
    await client.exchangeOnce()

    expect(envelopes[0].outbound).toEqual([{ id: "response-1" }])
    expect(envelopes[1].outbound).toEqual([{ id: "response-1" }])
  })
})
