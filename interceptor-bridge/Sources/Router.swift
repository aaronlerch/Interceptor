import Foundation
import ApplicationServices

final class Router: @unchecked Sendable {
    private var domains: [String: DomainHandler] = [:]
    private var lazyDomains: [String: @Sendable () -> DomainHandler] = [:]
    private let lock = NSLock()

    // Accessibility trust gate (issue #163). Every verb in this set reads or
    // drives the target app through the Accessibility API; without the TCC
    // grant those AX calls fail with kAXErrorAPIDisabled and the handlers
    // degrade into empty-success ("" trees, [] matches) instead of an error.
    // Gating here — the single dispatch choke point — fails loud once for
    // all of them, including the compound verbs that re-enter route().
    // Deliberately NOT gated: frontmost/apps/app (NSWorkspace, no TCC),
    // screenshot/capture (Screen Recording is a separate TCC service),
    // display (works without AX), monitor (has its own preflight), trust/tcc
    // (must always work), and extension-fabric prefixes (unknown AX usage).
    private static let axGatedDomains: Set<String> = [
        "tree", "find", "inspect", "value", "action", "focused", "windows",
        "resize", "move", "click", "type", "keys", "scroll", "drag",
        "menu", "text",
        // issue #244: the admin-prompt filler reads and drives SecurityAgent via AX.
    ]

    // FORK-DELTA: per-domain allowlist. "Full" mode is otherwise all-or-nothing
    // across ~60 domains (arbitrary AppleScript, whole-disk fs, personal data).
    // This is the AUTHORITATIVE gate: a direct write to the bridge socket and an
    // App Intents dispatch both reach route() without passing the daemon's
    // TypeScript gate, so the check has to live here. The provider returns the
    // allowed domain prefixes, or nil when no allowlist file exists (allow all).
    // `trust` is always allowed — it is the permission-walkthrough bootstrap.
    private static let alwaysAllowedDomains: Set<String> = ["trust"]
    private let allowedDomains: @Sendable () -> Set<String>?

    // Injectable so tests can force trusted/untrusted without live TCC state.
    private let axTrustCheck: @Sendable () -> Bool

    init(
        axTrustCheck: @escaping @Sendable () -> Bool = { AXIsProcessTrusted() },
        allowedDomains: @escaping @Sendable () -> Set<String>? = Router.readAllowlistFromFile,
    ) {
        self.axTrustCheck = axTrustCheck
        self.allowedDomains = allowedDomains
    }

    /// Read ~/.interceptor/macos-allow. nil when the file is absent (allow all);
    /// a set (possibly empty → deny all) when present. Mirrors the TypeScript
    /// reader in shared/surface-mode.ts so the two enforcers agree.
    static func readAllowlistFromFile() -> Set<String>? {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".interceptor/macos-allow")
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        var set = Set<String>()
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = line.trimmingCharacters(in: .whitespaces)
            if s.isEmpty || s.hasPrefix("#") { continue }
            set.insert(s.lowercased())
        }
        return set
    }

    func register(_ prefix: String, handler: DomainHandler) {
        lock.lock()
        domains[prefix] = handler
        lock.unlock()
    }

    func registerLazy(_ prefix: String, factory: @escaping @Sendable () -> DomainHandler) {
        lock.lock()
        lazyDomains[prefix] = factory
        lock.unlock()
    }

    /// Is `prefix` already claimed by a built-in (or earlier-loaded) domain?
    /// Reads BOTH maps so the Extension Fabric's collision check
    /// cannot let an extension clobber a registered or lazily-registered domain.
    func isRegistered(_ prefix: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return domains[prefix] != nil || lazyDomains[prefix] != nil
    }

    private func resolveHandler(for key: String) -> DomainHandler? {
        lock.lock()
        if let handler = domains[key] {
            lock.unlock()
            return handler
        }
        if let factory = lazyDomains[key] {
            let handler = factory()
            domains[key] = handler
            lazyDomains.removeValue(forKey: key)
            lock.unlock()
            return handler
        }
        lock.unlock()
        return nil
    }

    func route(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let type = action["type"] as? String else {
            completion(WireFormat.error("missing action type"))
            return
        }

        let parts = type.split(separator: "_", maxSplits: 2)
        guard parts.count >= 2, parts[0] == "macos" else {
            completion(WireFormat.error("invalid action type: \(type) — expected macos_ prefix"))
            return
        }

        let domainKey = String(parts[1])
        let command: String
        if parts.count > 2 {
            command = String(parts[2])
        } else {
            command = domainKey
        }

        if !Self.alwaysAllowedDomains.contains(domainKey), let allow = allowedDomains(), !allow.contains(domainKey) {
            completion(Self.domainNotAllowedError(domain: domainKey))
            return
        }

        if Self.axGatedDomains.contains(domainKey), !axTrustCheck() {
            completion(Self.accessibilityGateError(
                verb: domainKey,
                adhocSigned: LiveSigningInfoProvider.current.adhoc
            ))
            return
        }

        if let handler = resolveHandler(for: domainKey) {
            handler.handle(command, action: action, completion: completion)
            return
        }

        lock.lock()
        let allKeys = Array(domains.keys) + Array(lazyDomains.keys)
        lock.unlock()

        for prefix in allKeys {
            if type.hasPrefix("macos_\(prefix)") {
                if let handler = resolveHandler(for: prefix) {
                    handler.handle(command, action: action, completion: completion)
                    return
                }
            }
        }

        completion(WireFormat.error("no handler for domain: \(domainKey)"))
    }

    /// The actionable envelope an AX-gated verb returns when the bridge is
    /// not a trusted accessibility client. Pure function (adhoc passed in)
    /// so the message variants are unit-testable. Reuses the existing typed
    /// error code for this exact condition (kAXErrorAPIDisabled →
    /// "accessibility_unusable") plus the `remediation` field convention
    /// MonitorDomain's TCC preflight established.
    /// Returned when a domain is not in the configured allowlist. Pure so it is
    /// unit-testable; names the exact command to permit it.
    static func domainNotAllowedError(domain: String) -> [String: Any] {
        var err = WireFormat.error(
            "the '\(domain)' macOS domain is not in this install's allowlist. "
            + "Run 'interceptor surface allow \(domain)' to permit it, or "
            + "'interceptor surface allow all' to permit every domain."
        )
        err["code"] = "domain_not_allowed"
        return err
    }

    static func accessibilityGateError(verb: String, adhocSigned: Bool) -> [String: Any] {
        var message = "macos \(verb) needs Accessibility, which is not granted to interceptor-bridge. "
            + "Run 'interceptor macos trust --walkthrough' to fix."
        if adhocSigned {
            message += " Note: this bridge binary is ad-hoc signed; an existing 'interceptor-bridge' row in "
                + "System Settings → Privacy & Security → Accessibility may no longer match it. "
                + "Remove the row (−), re-grant, or install the signed build."
        }
        var err = AXTypedError.errorDict(message, code: "accessibility_unusable", axError: .apiDisabled)
        err["remediation"] = "interceptor macos trust --walkthrough"
        return err
    }
}
