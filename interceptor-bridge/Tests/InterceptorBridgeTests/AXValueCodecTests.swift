import XCTest
import ApplicationServices
@testable import interceptor_bridge

// codec matrix. Every supported CF/AX type and every
// unsupported/malformed value produces a tagged result without a force-cast
// trap, and the whole matrix is acyclic + JSON-safe.
final class AXValueCodecTests: XCTestCase {

    func testString() {
        let t = AXValueCodec.tag(FakeAX.string("hello"))
        XCTAssertEqual(t["kind"] as? String, "string")
        XCTAssertEqual(t["value"] as? String, "hello")
    }

    func testBoolean() {
        let t = AXValueCodec.tag(kCFBooleanTrue)
        XCTAssertEqual(t["kind"] as? String, "boolean")
        XCTAssertEqual(t["value"] as? Bool, true)
    }

    func testFiniteNumber() {
        let t = AXValueCodec.tag(FakeAX.number(NSNumber(value: 3.5)))
        XCTAssertEqual(t["kind"] as? String, "number")
        XCTAssertEqual(t["value"] as? Double, 3.5)
    }

    func testNonFiniteNumberIsJSONSafe() {
        let t = AXValueCodec.tag(FakeAX.number(NSNumber(value: Double.infinity)))
        XCTAssertEqual(t["kind"] as? String, "number")
        XCTAssertEqual(t["finite"] as? Bool, false)
        XCTAssertEqual(t["special"] as? String, "infinity")
        XCTAssertNil(t["value"])   // no non-finite number leaks into JSON
    }

    func testSafeInteger() {
        let t = AXValueCodec.tag(FakeAX.number(NSNumber(value: 42)))
        XCTAssertEqual(t["kind"] as? String, "number")
        XCTAssertEqual(t["value"] as? Int, 42)
    }

    func testUnsafeIntegerBecomesDecimalString() {
        let big = Int64(9_007_199_254_740_993)   // 2^53 + 1
        let t = AXValueCodec.tag(FakeAX.number(NSNumber(value: big)))
        XCTAssertEqual(t["kind"] as? String, "integer")
        XCTAssertEqual(t["value"] as? String, "9007199254740993")
    }

    func testPointSizeRectRange() {
        let p = AXValueCodec.tag(FakeAX.point(1, 2))
        XCTAssertEqual(p["kind"] as? String, "point")
        XCTAssertEqual(p["x"] as? CGFloat, 1)

        let s = AXValueCodec.tag(FakeAX.size(3, 4))
        XCTAssertEqual(s["kind"] as? String, "size")
        XCTAssertEqual(s["width"] as? CGFloat, 3)

        let r = AXValueCodec.tag(FakeAX.rect(5, 6, 7, 8))
        XCTAssertEqual(r["kind"] as? String, "rect")
        XCTAssertEqual(r["height"] as? CGFloat, 8)

        let rng = AXValueCodec.tag(FakeAX.range(10, 20))
        XCTAssertEqual(rng["kind"] as? String, "range")
    }

    func testAXError() {
        let t = AXValueCodec.tag(FakeAX.axError(.cannotComplete))
        XCTAssertEqual(t["kind"] as? String, "ax_error")
        XCTAssertEqual(t["name"] as? String, "kAXErrorCannotComplete")
    }

    func testURL() {
        let t = AXValueCodec.tag(FakeAX.url("https://example.com/x"))
        XCTAssertEqual(t["kind"] as? String, "url")
        XCTAssertTrue((t["value"] as? String ?? "").contains("example.com"))
    }

    func testAttributedString() {
        let t = AXValueCodec.tag(FakeAX.attributed("styled"))
        XCTAssertEqual(t["kind"] as? String, "attributed_string")
        XCTAssertEqual(t["value"] as? String, "styled")
    }

    func testNestedElementBecomesRefNeverPointer() {
        let t = AXValueCodec.tag(FakeAX.element())
        XCTAssertEqual(t["kind"] as? String, "element_ref")
        XCTAssertNil(t["ref"])   // no token provider ⇒ no token, and never an address
        // Emit a token when a provider is supplied.
        let withToken = AXValueCodec.tag(FakeAX.element(), elementToken: { _ in "e7" })
        XCTAssertEqual(withToken["ref"] as? String, "e7")
    }

    func testArrayOfMixedItems() {
        let arr = FakeAX.array([FakeAX.string("a"), FakeAX.number(NSNumber(value: 1)), FakeAX.element()])
        let t = AXValueCodec.tag(arr)
        XCTAssertEqual(t["kind"] as? String, "array")
        let items = t["items"] as? [[String: Any]]
        XCTAssertEqual(items?.count, 3)
        XCTAssertEqual(items?[0]["kind"] as? String, "string")
        XCTAssertEqual(items?[2]["kind"] as? String, "element_ref")   // element ⇒ terminal, no cycle
    }

    func testNullAndNil() {
        XCTAssertEqual(AXValueCodec.tag(FakeAX.null)["kind"] as? String, "null")
        XCTAssertEqual(AXValueCodec.tag(nil)["kind"] as? String, "null")
    }

    func testUnsupportedCFType() {
        let t = AXValueCodec.tag(NSDate() as CFTypeRef)
        XCTAssertEqual(t["kind"] as? String, "unsupported")
        XCTAssertNotNil(t["typeName"])
    }

    func testSecureAlwaysRedacted() {
        let t = AXValueCodec.tag(FakeAX.string("hunter2"), secure: true)
        XCTAssertEqual(t["kind"] as? String, "redacted")
        XCTAssertNil(t["value"])
    }

    // The whole matrix must serialize with no throw (acyclic, JSON-safe).
    func testEntireMatrixIsJSONSafe() {
        let matrix: [[String: Any]] = [
            AXValueCodec.tag(FakeAX.string("s")),
            AXValueCodec.tag(kCFBooleanTrue),
            AXValueCodec.tag(FakeAX.number(NSNumber(value: 3.5))),
            AXValueCodec.tag(FakeAX.number(NSNumber(value: Double.nan))),
            AXValueCodec.tag(FakeAX.number(NSNumber(value: Int64(9_007_199_254_740_993)))),
            AXValueCodec.tag(FakeAX.point(1, 2)),
            AXValueCodec.tag(FakeAX.rect(0, 0, 10, 10)),
            AXValueCodec.tag(FakeAX.axError(.cannotComplete)),
            AXValueCodec.tag(FakeAX.url("https://example.com")),
            AXValueCodec.tag(FakeAX.attributed("a")),
            AXValueCodec.tag(FakeAX.element()),
            AXValueCodec.tag(FakeAX.array([FakeAX.string("x"), FakeAX.element()])),
            AXValueCodec.tag(FakeAX.null),
            AXValueCodec.tag(NSDate() as CFTypeRef),
        ]
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: ["matrix": matrix]))
    }
}
