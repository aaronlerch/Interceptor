import Foundation
import ApplicationServices

// the one non-trapping typed codec.
//
// Every CF/AX value crossing the bridge is decoded here. Nothing force-casts an
// unverified `CFTypeRef`: we check `CFGetTypeID`, then (for AXValue) the
// `AXValueGetType`, then the typed extraction result. A failed extraction is a
// typed `decode_failed`, never a trap or an empty string. Output is an acyclic,
// JSON-safe tagged dictionary (`kind` + payload) — safe for
// `JSONSerialization` (finite numbers only; integers outside the ECMA safe
// range become decimal strings; elements become ref tokens, never nested
// handles, so cycles are impossible).
enum AXValueCodec {
    static let safeIntegerMax: Int64 = 9_007_199_254_740_991   // 2^53 - 1
    static let defaultMaxStringBytes = 64 * 1024
    static let defaultMaxArrayItems = 1024
    static let defaultMaxDepth = 16

    // MARK: - Full tagged DTO

    /// Decode a value to its acyclic tagged form. `secure == true` always yields
    /// `redacted` regardless of the underlying value. `elementToken` maps a live
    /// element to an exported ref token (never a pointer); nil ⇒ token omitted.
    static func tag(
        _ value: CFTypeRef?,
        secure: Bool = false,
        maxStringBytes: Int = defaultMaxStringBytes,
        maxArrayItems: Int = defaultMaxArrayItems,
        depth: Int = 0,
        maxDepth: Int = defaultMaxDepth,
        elementToken: ((AXUIElement) -> String?)? = nil
    ) -> [String: Any] {
        if secure { return ["kind": "redacted", "reason": "secure_value"] }
        guard let value = value else { return ["kind": "null"] }

        let typeID = CFGetTypeID(value)

        if typeID == CFNullGetTypeID() { return ["kind": "null"] }

        if typeID == CFBooleanGetTypeID() {
            return ["kind": "boolean", "value": CFBooleanGetValue(unsafeDowncast(value, to: CFBoolean.self))]
        }

        if typeID == AXValueGetTypeID() {
            return tagAXValue(unsafeDowncast(value, to: AXValue.self))
        }

        if typeID == AXUIElementGetTypeID() {
            var out: [String: Any] = ["kind": "element_ref"]
            if let token = elementToken?(unsafeDowncast(value, to: AXUIElement.self)) { out["ref"] = token }
            return out
        }

        if typeID == CFNumberGetTypeID() {
            return tagNumber(unsafeDowncast(value, to: CFNumber.self))
        }

        if typeID == CFStringGetTypeID() {
            let s = unsafeDowncast(value, to: CFString.self) as String
            return ["kind": "string", "value": boundedString(s, maxBytes: maxStringBytes)]
        }

        if typeID == CFURLGetTypeID() {
            let s = (value as? URL)?.absoluteString ?? (CFURLGetString(unsafeDowncast(value, to: CFURL.self)) as String)
            return ["kind": "url", "value": boundedString(s, maxBytes: maxStringBytes)]
        }

        if typeID == CFAttributedStringGetTypeID() {
            let attr = unsafeDowncast(value, to: CFAttributedString.self)
            let plain = CFAttributedStringGetString(attr) as String
            // Runs are optional (when available); omitted for now.
            return ["kind": "attributed_string", "value": boundedString(plain, maxBytes: maxStringBytes)]
        }

        if typeID == CFArrayGetTypeID() {
            return tagArray(value as? [CFTypeRef] ?? [],
                            secure: secure, maxStringBytes: maxStringBytes,
                            maxArrayItems: maxArrayItems, depth: depth, maxDepth: maxDepth,
                            elementToken: elementToken)
        }

        // Unknown CF type: name is safe (a class name, not content).
        var out: [String: Any] = ["kind": "unsupported", "typeId": Int(typeID)]
        if let name = CFCopyTypeIDDescription(typeID) as String? { out["typeName"] = name }
        return out
    }

    private static func tagAXValue(_ ax: AXValue) -> [String: Any] {
        switch AXValueGetType(ax) {
        case .cgPoint:
            var p = CGPoint.zero
            guard AXValueGetValue(ax, .cgPoint, &p) else { return ["kind": "decode_failed"] }
            return ["kind": "point", "x": p.x, "y": p.y]
        case .cgSize:
            var s = CGSize.zero
            guard AXValueGetValue(ax, .cgSize, &s) else { return ["kind": "decode_failed"] }
            return ["kind": "size", "width": s.width, "height": s.height]
        case .cgRect:
            var r = CGRect.zero
            guard AXValueGetValue(ax, .cgRect, &r) else { return ["kind": "decode_failed"] }
            return ["kind": "rect", "x": r.origin.x, "y": r.origin.y, "width": r.size.width, "height": r.size.height]
        case .cfRange:
            var range = CFRange(location: 0, length: 0)
            guard AXValueGetValue(ax, .cfRange, &range) else { return ["kind": "decode_failed"] }
            return ["kind": "range", "location": intOrString(Int64(range.location)), "length": intOrString(Int64(range.length))]
        case .axError:
            var err = AXError.success
            guard AXValueGetValue(ax, .axError, &err) else { return ["kind": "decode_failed"] }
            return ["kind": "ax_error", "code": Int(err.rawValue), "name": AXTypedError.symbolicName(err)]
        case .illegal:
            return ["kind": "unsupported", "typeName": "AXValueIllegal"]
        @unknown default:
            return ["kind": "unsupported", "typeName": "AXValueUnknown"]
        }
    }

    private static func tagNumber(_ num: CFNumber) -> [String: Any] {
        if CFNumberIsFloatType(num) {
            var d = 0.0
            CFNumberGetValue(num, .doubleType, &d)
            if d.isFinite { return ["kind": "number", "value": d] }
            let special = d.isNaN ? "nan" : (d > 0 ? "infinity" : "-infinity")
            return ["kind": "number", "finite": false, "special": special]
        }
        var i: Int64 = 0
        CFNumberGetValue(num, .sInt64Type, &i)
        return intOrString(i)
    }

    /// Integers inside the ECMA safe range serialize as Number; outside, as a
    /// decimal string under the `integer` tag.
    private static func intOrString(_ i: Int64) -> [String: Any] {
        if abs(i) <= safeIntegerMax { return ["kind": "number", "value": Int(i)] }
        return ["kind": "integer", "value": String(i)]
    }

    private static func tagArray(
        _ items: [CFTypeRef], secure: Bool, maxStringBytes: Int, maxArrayItems: Int,
        depth: Int, maxDepth: Int, elementToken: ((AXUIElement) -> String?)?
    ) -> [String: Any] {
        if depth >= maxDepth { return ["kind": "array", "items": [], "truncated": true] }
        let slice = items.prefix(maxArrayItems)
        let tagged: [[String: Any]] = slice.map {
            tag($0, secure: secure, maxStringBytes: maxStringBytes, maxArrayItems: maxArrayItems,
                depth: depth + 1, maxDepth: maxDepth, elementToken: elementToken)
        }
        var out: [String: Any] = ["kind": "array", "items": tagged]
        if items.count > maxArrayItems {
            out["truncated"] = true
            out["cursor"] = String(maxArrayItems)
        }
        return out
    }

    // MARK: - Compatibility / safe-extraction helpers
    //
    // These replace the current force casts (`as! AXValue`, `as! AXUIElement`,
    // `unsafeBitCast`) with type-ID-checked downcasts. The compat display path
    // keeps the current String/NSNumber behavior exactly, just without a trap.

    /// Display string for compatibility commands. Matches the previous
    /// `getStringAttribute` contract (String or NSNumber → String, else nil),
    /// but non-trapping.
    static func displayString(_ value: CFTypeRef?) -> String? {
        guard let value = value else { return nil }
        if let str = value as? String { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    /// Type-checked downcast to `AXUIElement` (replaces `as!` / `unsafeBitCast`).
    static func asElement(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    /// Type-checked downcast to `AXValue` (replaces `as! AXValue`).
    static func asAXValue(_ value: CFTypeRef?) -> AXValue? {
        guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXValue.self)
    }

    static func point(from value: CFTypeRef?) -> CGPoint? {
        guard let ax = asAXValue(value), AXValueGetType(ax) == .cgPoint else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(ax, .cgPoint, &p) ? p : nil
    }

    static func size(from value: CFTypeRef?) -> CGSize? {
        guard let ax = asAXValue(value), AXValueGetType(ax) == .cgSize else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(ax, .cgSize, &s) ? s : nil
    }

    static func range(from value: CFTypeRef?) -> CFRange? {
        guard let ax = asAXValue(value), AXValueGetType(ax) == .cfRange else { return nil }
        var r = CFRange(location: 0, length: 0)
        return AXValueGetValue(ax, .cfRange, &r) ? r : nil
    }

    /// Truncate a string to a UTF-8 byte budget without splitting a scalar.
    static func boundedString(_ s: String, maxBytes: Int) -> String {
        guard s.utf8.count > maxBytes else { return s }
        var result = ""
        var bytes = 0
        for ch in s {
            let n = String(ch).utf8.count
            if bytes + n > maxBytes { break }
            result.append(ch)
            bytes += n
        }
        return result + "…"
    }
}
