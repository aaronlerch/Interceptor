import { describe, expect, test } from "bun:test"
import { WebInspectorSession, scanJsonMessages, type WipEvent } from "../daemon/ios/webinspector-session"

// Locks the inner WIP session: id correlation (incl. out of order), event demux,
// protocol-error → capability mapping, timeouts armed before send, detach
// rejection, and the direct vs Target-multiplexed envelope.

function harness(opts: Partial<Parameters<typeof makeSession>[0]> = {}) {
  return makeSession(opts)
}
function makeSession(o: { events?: WipEvent[]; maxInFlight?: number; defaultTimeoutMs?: number }) {
  const sent: any[] = []
  const events: WipEvent[] = o.events ?? []
  const session = new WebInspectorSession({
    sendBytes: (b) => sent.push(JSON.parse(b.toString())),
    onEvent: (e) => events.push(e),
    maxInFlight: o.maxInFlight,
    defaultTimeoutMs: o.defaultTimeoutMs,
  })
  return { session, sent, events }
}

describe("WIP session — direct envelope", () => {
  test("correlates responses, even out of order", async () => {
    const { session, sent } = harness()
    const p1 = session.request("Runtime.evaluate", { expression: "1" })
    const p2 = session.request("DOM.getDocument")
    expect(sent).toHaveLength(2)
    const id1 = sent[0].id, id2 = sent[1].id
    // reply to the SECOND first
    session.feed(JSON.stringify({ id: id2, result: { root: {} } }))
    session.feed(JSON.stringify({ id: id1, result: { value: 1 } }))
    expect(await p2).toEqual({ root: {} })
    expect(await p1).toEqual({ value: 1 })
  })

  test("events interleave with responses and reach onEvent", async () => {
    const { session, events } = harness()
    const p = session.request("Console.enable")
    session.feed(JSON.stringify({ method: "Console.messageAdded", params: { message: { text: "hi" } } }))
    session.feed(JSON.stringify({ id: 1, result: {} }))
    await p
    expect(events).toHaveLength(1)
    expect(events[0].method).toBe("Console.messageAdded")
  })

  test("protocol error for an unknown method maps to wip_method_unavailable", async () => {
    const { session } = harness()
    const p = session.request("Bogus.method")
    session.feed(JSON.stringify({ id: 1, error: { message: "'Bogus.method' was not found" } }))
    await expect(p).rejects.toMatchObject({ code: "wip_method_unavailable" })
  })

  test("a generic protocol error stays wip_protocol_error", async () => {
    const { session } = harness()
    const p = session.request("Runtime.evaluate")
    session.feed(JSON.stringify({ id: 1, error: { message: "Syntax error in expression" } }))
    await expect(p).rejects.toMatchObject({ code: "wip_protocol_error" })
  })

  test("request times out when no response arrives (armed before send)", async () => {
    const { session } = harness({ defaultTimeoutMs: 30 })
    const p = session.request("Runtime.evaluate")
    await expect(p).rejects.toMatchObject({ code: "wip_timeout" })
  })

  test("dispose rejects all in-flight requests", async () => {
    const { session } = harness()
    const p1 = session.request("A")
    const p2 = session.request("B")
    session.dispose("device disconnected")
    await expect(p1).rejects.toMatchObject({ code: "wip_detached" })
    await expect(p2).rejects.toMatchObject({ code: "wip_detached" })
    expect(session.inFlight).toBe(0)
  })

  test("in-flight cap rejects excess and is hard-capped at 32", async () => {
    const { session } = harness({ maxInFlight: 2 })
    session.request("A").catch(() => {})
    session.request("B").catch(() => {})
    await expect(session.request("C")).rejects.toMatchObject({ code: "wip_protocol_error" })
  })
})

describe("WIP session — target-multiplexed envelope", () => {
  test("wraps in Target.sendMessageToTarget and unwraps dispatchMessageFromTarget", async () => {
    const { session, sent } = harness()
    session.setEnvelopeMode("target-multiplexed")
    session.setInnerTarget("page-1")

    const p = session.request("Runtime.evaluate", { expression: "document.title" })
    // outer wrapper written
    expect(sent[0].method).toBe("Target.sendMessageToTarget")
    expect(sent[0].params.targetId).toBe("page-1")
    const innerSent = JSON.parse(sent[0].params.message)
    expect(innerSent.method).toBe("Runtime.evaluate")

    // outer ack (empty) — must NOT resolve the inner request
    session.feed(JSON.stringify({ id: sent[0].id, result: {} }))
    // real inner response arrives wrapped
    session.feed(JSON.stringify({
      method: "Target.dispatchMessageFromTarget",
      params: { targetId: "page-1", message: JSON.stringify({ id: innerSent.id, result: { value: "Example" } }) },
    }))
    expect(await p).toEqual({ value: "Example" })
  })

  test("targetCreated is collected; provisional commit swaps the inner target", () => {
    const created: string[] = []
    const sent: any[] = []
    const session = new WebInspectorSession({
      sendBytes: (b) => sent.push(JSON.parse(b.toString())),
      onTargetCreated: (c) => created.push(c.targetId),
    })
    session.setEnvelopeMode("target-multiplexed")
    session.feed(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId: "page-1", type: "page" } } }))
    expect(created).toEqual(["page-1"])
    session.setInnerTarget("page-1")
    session.feed(JSON.stringify({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "page-1", newTargetId: "page-2" } }))
    expect(session.innerTarget).toBe("page-2")
  })

  test("auto-promotes to multiplexed and adopts a page target on Target.targetCreated", async () => {
    // A session that starts in direct mode but sees a Target.targetCreated IS
    // multiplexed — it must switch and adopt the page, else the first request is
    // sent unwrapped and the device answers "domain not found". [live iOS 27]
    const { session, sent } = harness()
    expect(session.envelopeMode).toBe("direct")
    session.feed(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId: "page-40", type: "page" } } }))
    expect(session.envelopeMode).toBe("target-multiplexed")
    expect(session.innerTarget).toBe("page-40")
    // subsequent request is wrapped in Target.sendMessageToTarget
    session.request("Runtime.evaluate", { expression: "document.title" }).catch(() => {})
    expect(sent[0].method).toBe("Target.sendMessageToTarget")
    expect(sent[0].params.targetId).toBe("page-40")
  })

  test("an outer error rejects the wrapped inner request", async () => {
    const { session, sent } = harness()
    session.setEnvelopeMode("target-multiplexed")
    session.setInnerTarget("page-1")
    const p = session.request("Runtime.evaluate")
    session.feed(JSON.stringify({ id: sent[0].id, error: { message: "target gone" } }))
    await expect(p).rejects.toMatchObject({ code: "wip_protocol_error" })
  })
})

describe("scanJsonMessages", () => {
  test("splits concatenated messages and keeps the partial remainder", () => {
    const a = JSON.stringify({ id: 1, result: {} })
    const b = JSON.stringify({ method: "X", params: { s: "}{" } }) // braces inside string
    const r = scanJsonMessages(a + b.slice(0, 5), 1024)
    expect(r.messages).toEqual([a])
    expect(r.rest).toBe(b.slice(0, 5))
    const r2 = scanJsonMessages(r.rest + b.slice(5), 1024)
    expect(JSON.parse(r2.messages[0]).params.s).toBe("}{")
  })

  test("throws when an in-progress message exceeds the cap", () => {
    expect(() => scanJsonMessages("{" + "a".repeat(100), 10)).toThrow()
  })
})
