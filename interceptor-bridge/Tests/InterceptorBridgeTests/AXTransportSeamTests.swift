import XCTest
import ApplicationServices
@testable import interceptor_bridge

// the transport seam. Bulk positional value/null/error
// order is preserved through the codec; a domain routes through the injected
// transport; and the cannotComplete-after-effect fixture is representable.
final class AXTransportSeamTests: XCTestCase {

    func testBulkPositionalValueNullErrorOrder() {
        let fake = FakeAXTransport()
        fake.multiAttributeResponse = [
            FakeAX.string("v0"),
            FakeAX.null,
            FakeAX.axError(.cannotComplete),
        ]
        let el = AXUIElementCreateSystemWide()
        let (err, values) = fake.copyMultipleAttributeValues(el, ["a", "b", "c"], stopOnError: false)
        XCTAssertEqual(err, .success)
        XCTAssertEqual(values?.count, 3)

        let tagged = values!.map { AXValueCodec.tag($0) }
        XCTAssertEqual(tagged[0]["kind"] as? String, "string")
        XCTAssertEqual(tagged[1]["kind"] as? String, "null")
        XCTAssertEqual(tagged[2]["kind"] as? String, "ax_error")   // per-slot error, not flattened
        XCTAssertEqual(tagged[2]["name"] as? String, "kAXErrorCannotComplete")
    }

    func testTextDomainRoutesThroughInjectedTransport() {
        let registry = RefRegistry()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)

        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextArea")   // non-secure
        fake.attributeResponses["AXValue"] = FakeAX.string("hello world")

        let domain = TextDomain(refRegistry: registry, transport: fake)
        let holder = TestResultHolder()
        domain.handle("text", action: ["ref": ref, "mode": "full"]) { holder.set($0) }
        let captured = holder.value

        XCTAssertEqual(captured["success"] as? Bool, true)
        XCTAssertEqual(captured["data"] as? String, "hello world")
        XCTAssertGreaterThan(fake.callCount, 0)   // proves it went through the seam
    }

    func testCannotCompleteAfterEffectIsRepresentable() {
        let fake = FakeAXTransport()
        fake.performResult = .cannotComplete
        fake.actionEffectHappened = true

        let el = AXUIElementCreateSystemWide()
        let result = fake.performAction(el, "AXPress")

        // The API reports cannotComplete even though the effect was recorded —
        // exactly the ambiguity the verified-action engine (G3) must handle.
        XCTAssertEqual(result, .cannotComplete)
        XCTAssertEqual(fake.performedActions, ["AXPress"])
    }

    func testTypedErrorMapsCannotComplete() {
        let dict = AXTypedError.from(.cannotComplete, message: "nope")
        XCTAssertEqual(dict["success"] as? Bool, false)
        XCTAssertEqual(dict["code"] as? String, "cannot_complete")
        XCTAssertEqual(dict["retryable"] as? Bool, false)   // action cannotComplete: verify before retry
        let details = dict["details"] as? [String: Any]
        let axError = details?["axError"] as? [String: Any]
        XCTAssertEqual(axError?["name"] as? String, "kAXErrorCannotComplete")
    }

    func testProductCodeMapping() {
        XCTAssertEqual(AXTypedError.productCode(.attributeUnsupported), "unsupported_attribute")
        XCTAssertEqual(AXTypedError.productCode(.actionUnsupported), "unsupported_action")
        XCTAssertEqual(AXTypedError.productCode(.noValue), "no_value")
        XCTAssertEqual(AXTypedError.productCode(.apiDisabled), "accessibility_unusable")
        XCTAssertNil(AXTypedError.productCode(.success))
    }
}
