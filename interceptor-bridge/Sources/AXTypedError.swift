import Foundation
import ApplicationServices

// stable typed wire errors.
//
// Maps an `AXError` to a stable product error code while retaining the raw AX
// code + symbolic name, and keeps the old string `error` populated so existing
// consumers are unaffected. This is additive: `WireFormat.error(msg)` still
// works; `AXTypedError.errorDict(...)` layers `code`/`details.axError` on top.
enum AXTypedError {
    /// Apple's symbolic name for an AXError case (stable across OS versions).
    static func symbolicName(_ err: AXError) -> String {
        switch err {
        case .success: return "kAXErrorSuccess"
        case .failure: return "kAXErrorFailure"
        case .illegalArgument: return "kAXErrorIllegalArgument"
        case .invalidUIElement: return "kAXErrorInvalidUIElement"
        case .invalidUIElementObserver: return "kAXErrorInvalidUIElementObserver"
        case .cannotComplete: return "kAXErrorCannotComplete"
        case .attributeUnsupported: return "kAXErrorAttributeUnsupported"
        case .actionUnsupported: return "kAXErrorActionUnsupported"
        case .notificationUnsupported: return "kAXErrorNotificationUnsupported"
        case .notImplemented: return "kAXErrorNotImplemented"
        case .notificationAlreadyRegistered: return "kAXErrorNotificationAlreadyRegistered"
        case .notificationNotRegistered: return "kAXErrorNotificationNotRegistered"
        case .apiDisabled: return "kAXErrorAPIDisabled"
        case .noValue: return "kAXErrorNoValue"
        case .parameterizedAttributeUnsupported: return "kAXErrorParameterizedAttributeUnsupported"
        case .notEnoughPrecision: return "kAXErrorNotEnoughPrecision"
        @unknown default: return "kAXErrorUnknown"
        }
    }

    /// Stable product error code for an AXError. `nil` for success.
    static func productCode(_ err: AXError) -> String? {
        switch err {
        case .success: return nil
        case .apiDisabled: return "accessibility_unusable"
        case .invalidUIElement, .invalidUIElementObserver: return "invalid_ref"
        case .cannotComplete: return "cannot_complete"
        case .attributeUnsupported: return "unsupported_attribute"
        case .parameterizedAttributeUnsupported: return "unsupported_parameterized_attribute"
        case .actionUnsupported: return "unsupported_action"
        case .noValue: return "no_value"
        case .illegalArgument, .notEnoughPrecision: return "invalid_value"
        case .notificationUnsupported, .notImplemented,
             .notificationAlreadyRegistered, .notificationNotRegistered:
            return "capability_unavailable"
        case .failure:
            return "cannot_complete"
        @unknown default:
            return "cannot_complete"
        }
    }

    /// `cannot_complete` retryability is operation-dependent; action results
    /// default to false until verification proves no effect and policy permits
    /// retry. Non-action reads may treat it as retryable.
    static func defaultRetryable(_ err: AXError) -> Bool {
        switch err {
        case .cannotComplete: return false
        default: return false
        }
    }

    /// Build the additive typed error envelope. The old string `error`
    /// stays populated; `code`/`details.axError`/`retryable` are new fields.
    static func errorDict(
        _ message: String,
        code: String,
        axError: AXError? = nil,
        provider: String = "macos_ax",
        ref: String? = nil,
        dispatched: Bool = false,
        verified: Bool = false,
        retryable: Bool = false
    ) -> [String: Any] {
        var details: [String: Any] = ["provider": provider, "dispatched": dispatched, "verified": verified]
        if let ref = ref { details["ref"] = ref }
        if let axError = axError, axError != .success {
            details["axError"] = ["code": Int(axError.rawValue), "name": symbolicName(axError)]
        } else {
            details["axError"] = NSNull()
        }
        return [
            "success": false,
            "error": message,
            "code": code,
            "details": details,
            "retryable": retryable,
        ]
    }

    /// Convenience: derive code + retryable straight from an AXError.
    static func from(_ err: AXError, message: String, ref: String? = nil) -> [String: Any] {
        errorDict(message, code: productCode(err) ?? "cannot_complete", axError: err,
                  ref: ref, retryable: defaultRetryable(err))
    }
}
