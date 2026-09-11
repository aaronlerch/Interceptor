import XCTest
@testable import interceptor_bridge

// FORK-DELTA: per-domain allowlist. The Router is the authoritative gate (a
// direct bridge-socket write and an App Intents dispatch both bypass the
// daemon's TypeScript gate), so these tests pin it: nil allowlist = allow all;
// a present set denies unlisted domains; 'trust' is always allowed; and the
// allowlist check precedes the AX gate.

private final class RecordingHandler: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var _invocations: [String] = []
    var invocations: [String] { lock.lock(); defer { lock.unlock() }; return _invocations }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); _invocations.append(command); lock.unlock()
        completion(WireFormat.success("handled"))
    }
}

final class RouterAllowlistTests: XCTestCase {
    // Assert on the routed result inside the Sendable completion (the captured
    // var pattern trips strict concurrency checking).
    private func assertRoute(_ router: Router, _ type: String, _ check: @escaping @Sendable ([String: Any]) -> Void) {
        let exp = expectation(description: type)
        router.route(action: ["type": type]) { result in check(result); exp.fulfill() }
        wait(for: [exp], timeout: 1.0)
    }

    func testNilAllowlistAllowsEveryDomain() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { true }, allowedDomains: { nil })
        for key in ["screenshot", "intent", "fs"] { router.register(key, handler: handler) }
        for key in ["screenshot", "intent", "fs"] {
            assertRoute(router, "macos_\(key)") { XCTAssertEqual($0["success"] as? Bool, true, "\(key) must pass with no allowlist") }
        }
    }

    func testPresentAllowlistDeniesUnlistedDomains() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { true }, allowedDomains: { ["screenshot"] })
        router.register("screenshot", handler: handler)
        router.register("intent", handler: handler)

        assertRoute(router, "macos_screenshot") { XCTAssertEqual($0["success"] as? Bool, true, "listed domain passes") }
        assertRoute(router, "macos_intent_dispatch") { result in
            XCTAssertEqual(result["success"] as? Bool, false, "unlisted domain is denied")
            XCTAssertEqual(result["code"] as? String, "domain_not_allowed")
            let msg = result["error"] as? String ?? ""
            XCTAssertTrue(msg.contains("intent"), "message names the domain")
            XCTAssertTrue(msg.contains("surface allow"), "message names the fix")
        }
        XCTAssertEqual(handler.invocations, ["screenshot"], "a denied domain never reaches its handler")
    }

    func testEmptyAllowlistDeniesAllButTrust() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { true }, allowedDomains: { [] })
        router.register("screenshot", handler: handler)
        router.register("trust", handler: handler)
        assertRoute(router, "macos_screenshot") { XCTAssertEqual($0["success"] as? Bool, false, "empty allowlist denies screenshot") }
        assertRoute(router, "macos_trust") { XCTAssertEqual($0["success"] as? Bool, true, "trust is always allowed") }
    }

    func testAllowlistCheckPrecedesAxGate() {
        let router = Router(axTrustCheck: { false }, allowedDomains: { ["screenshot"] })
        router.register("tree", handler: RecordingHandler())
        assertRoute(router, "macos_tree") { XCTAssertEqual($0["code"] as? String, "domain_not_allowed", "allowlist denial wins over the AX gate") }
    }

    func testDomainNotAllowedErrorIsPureAndActionable() {
        let err = Router.domainNotAllowedError(domain: "fs")
        XCTAssertEqual(err["success"] as? Bool, false)
        XCTAssertEqual(err["code"] as? String, "domain_not_allowed")
        let msg = err["error"] as? String ?? ""
        XCTAssertTrue(msg.contains("'fs'"))
        XCTAssertTrue(msg.contains("surface allow fs"))
    }
}
