import XCTest
import ApplicationServices
@testable import interceptor_bridge

// secure canary. A unique secure-field value must never appear in
// any product output: not through the codec, the redaction helper, a typed
// error, or the TextDomain read path.
final class AXSecureCanaryTests: XCTestCase {
    static let canary = "CANARY-a7f3e9c1-9d2b-4e10-secret-password"

    private func containsCanary(_ obj: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return false }
        return s.contains(Self.canary)
    }

    func testCodecRedactsSecureValue() {
        let t = AXValueCodec.tag(FakeAX.string(Self.canary), secure: true)
        XCTAssertEqual(t["kind"] as? String, "redacted")
        XCTAssertFalse(containsCanary(t))
    }

    func testRedactionHelperReplacesSecureDisplayString() {
        let out = AXSecureRedaction.displayString(FakeAX.string(Self.canary), secure: true)
        XCTAssertEqual(out, AXSecureRedaction.placeholder)
        XCTAssertNotEqual(out, Self.canary)
    }

    func testTypedErrorNeverCarriesCanary() {
        let err = AXTypedError.errorDict("read failed", code: "secure_value_redacted")
        XCTAssertFalse(containsCanary(err))
    }

    // The load-bearing path: TextDomain reading a secure field returns the
    // placeholder, never the field contents.
    func testTextDomainRedactsSecureField() {
        let registry = RefRegistry()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)

        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXSecureTextField")
        fake.attributeResponses["AXValue"] = FakeAX.string(Self.canary)

        let domain = TextDomain(refRegistry: registry, transport: fake)
        let holder = TestResultHolder()
        domain.handle("text", action: ["ref": ref, "mode": "full"]) { holder.set($0) }
        let captured = holder.value

        XCTAssertEqual(captured["data"] as? String, AXSecureRedaction.placeholder)
        XCTAssertFalse(containsCanary(captured))
    }

    func testSecureClassificationBySubrole() {
        XCTAssertTrue(AXSecureRedaction.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(AXSecureRedaction.isSecure(role: "AXTextField", subrole: nil))
    }
}
