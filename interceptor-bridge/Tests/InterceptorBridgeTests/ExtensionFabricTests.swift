// Extension Fabric end-to-end. Compiles a tiny fixture
// bridge dylib, ad-hoc signs it, points the discovery root at a temp dir, and
// verifies ExtensionFabric.loadAll registers the prefix and routes a verb through
// the serialized C-ABI adapter — plus the prefix-collision guard.
//
// NOTE: an ad-hoc signature (`codesign -s -`) is VALID but carries no Team
// Identifier, so it cannot satisfy a Team-ID allowlist. This fork denies dylib
// loading unless the operator configured a trust policy, so the routing tests
// below must opt in explicitly via INTERCEPTOR_EXT_ALLOW_UNSIGNED — that is the
// point of testDefaultTrustPolicyDeniesAdHocSignedDylib.

import XCTest
import Foundation
@testable import interceptor_bridge

final class ExtensionFabricTests: XCTestCase {

    private var root: String!

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "itc-ext-fabric-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        setenv("INTERCEPTOR_EXTENSIONS_DIR", root, 1)
        unsetenv("INTERCEPTOR_EXT_ALLOW_UNSIGNED")
        unsetenv("INTERCEPTOR_EXT_TEAM_IDS")
    }

    override func tearDownWithError() throws {
        unsetenv("INTERCEPTOR_EXTENSIONS_DIR")
        unsetenv("INTERCEPTOR_EXT_ALLOW_UNSIGNED")
        unsetenv("INTERCEPTOR_EXT_TEAM_IDS")
        try? FileManager.default.removeItem(atPath: root)
    }

    /// Opt in to loading the ad-hoc-signed fixtures. Without this the fabric
    /// fails closed (no operator trust policy configured).
    private func allowFixtureLoading() {
        setenv("INTERCEPTOR_EXT_ALLOW_UNSIGNED", "1", 1)
    }

    /// Compile + ad-hoc sign a fixture bridge dylib under <root>/<name>/bridge/h.dylib
    /// and write its manifest. Returns false (and the test should skip) if the
    /// toolchain isn't available.
    private func makeFixture(name: String, prefix: String) throws -> Bool {
        let dir = (root as NSString).appendingPathComponent(name)
        let bridgeDir = (dir as NSString).appendingPathComponent("bridge")
        try FileManager.default.createDirectory(atPath: bridgeDir, withIntermediateDirectories: true)

        let csrc = (dir as NSString).appendingPathComponent("h.c")
        let dylib = (bridgeDir as NSString).appendingPathComponent("h.dylib")
        let cSource = """
        #include <stdlib.h>
        #include <string.h>
        #include <stdio.h>
        unsigned int itc_ext_abi_version(void) { return 1; }
        char *itc_ext_handle(const char *commandJSON, const char *actionJSON) {
            const char *a = "{\\"success\\":true,\\"data\\":{\\"commandEnvelope\\":";
            const char *b = ",\\"actionEnvelope\\":";
            const char *c = "}}";
            size_t n = strlen(a)+strlen(commandJSON)+strlen(b)+strlen(actionJSON)+strlen(c)+1;
            char *out = (char*)malloc(n);
            snprintf(out, n, "%s%s%s%s%s", a, commandJSON, b, actionJSON, c);
            return out;
        }
        void itc_ext_free(char *p) { free(p); }
        """
        try cSource.write(toFile: csrc, atomically: true, encoding: .utf8)

        guard run("/usr/bin/clang", ["-dynamiclib", "-o", dylib, csrc]) == 0 else { return false }
        // Ad-hoc sign so SecStaticCodeCheckValidity passes without the unsigned opt-in.
        guard run("/usr/bin/codesign", ["-s", "-", "-f", dylib]) == 0 else { return false }

        let manifest = """
        {"name":"\(name)","version":"1.0.0","bridgeDomains":[{"prefix":"\(prefix)","dylib":"bridge/h.dylib","entry":"itc_ext_handle"}]}
        """
        try manifest.write(toFile: (dir as NSString).appendingPathComponent("manifest.json"), atomically: true, encoding: .utf8)
        return true
    }

    @discardableResult
    private func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }

    func testFixtureExtensionLoadsAndRoutes() throws {
        guard try makeFixture(name: "fixture", prefix: "fixturex") else {
            throw XCTSkip("clang/codesign unavailable")
        }
        allowFixtureLoading()
        let router = Router()
        ExtensionFabric.loadAll(into: router)
        XCTAssertTrue(router.isRegistered("fixturex"), "extension bridge domain should be registered")

        let exp = expectation(description: "route")
        let box = ResultBox()
        router.route(action: ["type": "macos_fixturex_run", "app": "Target.app"]) { result in
            box.value = result
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)

        let captured = box.value
        XCTAssertEqual(captured["success"] as? Bool, true)
        let data = captured["data"] as? [String: Any]
        let cmd = (data?["commandEnvelope"] as? [String: Any])?["command"] as? String
        XCTAssertEqual(cmd, "run", "Router must deliver the verb as `command`, not action[sub]")
    }

    func testPrefixCollisionWithBuiltinIsSkipped() throws {
        // A sentinel built-in already owns "fixturex"; the extension claiming it
        // must be skipped (router.isRegistered guard), leaving the sentinel intact.
        guard try makeFixture(name: "evil", prefix: "fixturex") else {
            throw XCTSkip("clang/codesign unavailable")
        }
        allowFixtureLoading()
        let router = Router()
        let sentinel = SentinelDomain()
        router.register("fixturex", handler: sentinel)
        ExtensionFabric.loadAll(into: router)

        let exp = expectation(description: "route")
        let box = ResultBox()
        router.route(action: ["type": "macos_fixturex_ping"]) { result in
            box.value = result
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5)
        XCTAssertTrue((box.value["sentinel"] as? Bool) == true, "the built-in sentinel must not be clobbered by a colliding extension prefix")
    }

    /// The hardening this fork adds. The bridge runs with library validation
    /// disabled, so it re-imposes the check in software — but upstream ran the
    /// Team-ID check only `if !trust.teamIds.isEmpty`, and that list is empty
    /// until an operator writes one. An ad-hoc `codesign -s -` on any dylib
    /// dropped into the user-writable extensions dir therefore loaded straight
    /// into the TCC-privileged bridge. With no trust policy configured, it must
    /// now be refused.
    func testDefaultTrustPolicyDeniesAdHocSignedDylib() throws {
        guard try makeFixture(name: "adhoc", prefix: "adhocx") else {
            throw XCTSkip("clang/codesign unavailable")
        }
        // deliberately NOT calling allowFixtureLoading()
        let router = Router()
        ExtensionFabric.loadAll(into: router)
        XCTAssertFalse(router.isRegistered("adhocx"),
                       "an ad-hoc-signed dylib must not load without an operator trust policy")
    }

    /// A configured Team-ID allowlist must still reject an ad-hoc signature,
    /// which has no Team Identifier to match.
    func testTeamAllowlistRejectsAdHocSignature() throws {
        guard try makeFixture(name: "adhoc2", prefix: "adhocy") else {
            throw XCTSkip("clang/codesign unavailable")
        }
        setenv("INTERCEPTOR_EXT_TEAM_IDS", "ABCDE12345", 1)
        let router = Router()
        ExtensionFabric.loadAll(into: router)
        XCTAssertFalse(router.isRegistered("adhocy"),
                       "ad-hoc signature carries no Team Identifier and cannot match an allowlist")
    }

    func testNoExtensionsIsNoOp() {
        // Empty root → loadAll registers nothing, never throws.
        let router = Router()
        ExtensionFabric.loadAll(into: router)
        XCTAssertFalse(router.isRegistered("fixturex"))
    }
}

private final class SentinelDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(["success": true, "sentinel": true])
    }
}

/// Thread-safe capture box for the @Sendable route completion (strict concurrency).
private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: [String: Any] = [:]
    var value: [String: Any] {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}
