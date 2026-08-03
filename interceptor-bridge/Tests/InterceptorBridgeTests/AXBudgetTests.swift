import XCTest
import ApplicationServices
@testable import interceptor_bridge

// budget meter + bounded traversal.
final class AXBudgetTests: XCTestCase {

    func testNodeBudgetStopsWithReason() {
        let b = AXBudget(maxMs: 60_000, maxNodes: 3, maxCalls: 1_000)
        for _ in 0..<3 { XCTAssertFalse(b.shouldStop()); b.countNode() }
        XCTAssertTrue(b.shouldStop())
        XCTAssertEqual(b.limitHit, "max_nodes")
        XCTAssertTrue(b.stopMarker.contains("max_nodes"))
    }

    func testCallBudgetStopsWithReason() {
        let b = AXBudget(maxMs: 60_000, maxNodes: 1_000_000, maxCalls: 10)
        b.countCalls(10)
        XCTAssertTrue(b.shouldStop())
        XCTAssertEqual(b.limitHit, "budget_exceeded")
    }

    func testDeadlineStopsWithReason() {
        let t0 = Date()
        let b = AXBudget(maxMs: 10, maxNodes: 1_000, maxCalls: 1_000, now: t0)
        XCTAssertFalse(b.shouldStop(now: t0))                       // not yet
        XCTAssertTrue(b.shouldStop(now: t0.addingTimeInterval(1)))  // 1s later
        XCTAssertEqual(b.limitHit, "deadline_exceeded")
    }

    func testNoLimitNoMarker() {
        let b = AXBudget(maxMs: 60_000, maxNodes: 100, maxCalls: 100)
        b.countNode(); b.countCalls(1)
        XCTAssertFalse(b.shouldStop())
        XCTAssertEqual(b.stopMarker, "")
    }

    func testFirstReasonSticks() {
        let b = AXBudget(maxMs: 0, maxNodes: 1, maxCalls: 1)
        b.countNode()                     // hits max_nodes first
        XCTAssertTrue(b.shouldStop())
        XCTAssertEqual(b.limitHit, "max_nodes")
        _ = b.shouldStop()                // deadline also blown, but reason must not change
        XCTAssertEqual(b.limitHit, "max_nodes")
    }

    func testClamp() {
        XCTAssertEqual(AXBudget.clamp(nil, def: 2000, hard: 10000), 2000)
        XCTAssertEqual(AXBudget.clamp(0, def: 2000, hard: 10000), 2000)      // non-positive ⇒ default
        XCTAssertEqual(AXBudget.clamp(500, def: 2000, hard: 10000), 500)
        XCTAssertEqual(AXBudget.clamp(999999, def: 2000, hard: 10000), 10000) // clamp to hard cap
    }

    // Integration: the real buildTree walker must stop on the node budget when
    // fed a wide, self-referential graph — proving the budget actually bounds an
    // otherwise-unbounded traversal (the live Finder-timeout case). Calls the
    // walker directly so it doesn't depend on a live NSRunningApplication.
    func testTreeBoundsWideCyclicGraphWithoutHanging() {
        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXButton")   // interactive ⇒ renders
        let kids = (0..<10).map { _ in FakeAX.element() }
        fake.attributeResponses["AXChildren"] = FakeAX.array(kids)      // every node returns 10 children

        let domain = AccessibilityDomain(transport: fake)
        let budget = AXBudget(maxMs: 60_000, maxNodes: 30, maxCalls: 1_000_000)
        var output = ""
        // maxDepth huge + maxChars huge ⇒ only the node budget can stop it.
        domain.buildTree(element: AXUIElementCreateSystemWide(), pid: 4242, depth: 0,
                         maxDepth: 100, filter: "all", output: &output, maxChars: 100_000_000, budget: budget)

        XCTAssertEqual(budget.limitHit, "max_nodes", "budget must stop the otherwise-infinite walk")
        XCTAssertGreaterThanOrEqual(budget.nodesVisited, 30)
        XCTAssertLessThan(budget.nodesVisited, 100, "must not blow far past the cap")
    }
}
