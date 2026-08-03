import Foundation
import ApplicationServices

final class TextDomain: DomainHandler, @unchecked Sendable {
    private let refRegistry: RefRegistry
    // route AX calls through the transport + codec (removes the
    // `rangeValue as! AXValue` force cast) and apply central secure redaction so
    // a secure text field never returns its contents (a security correction).
    private let transport: any AXTransport

    init(refRegistry: RefRegistry = .shared, transport: any AXTransport = LiveAXTransport()) {
        self.refRegistry = refRegistry
        self.transport = transport
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "text":
            readText(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func readText(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String else {
            completion(WireFormat.error("text requires a ref"))
            return
        }

        guard let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("ref \(ref) not found"))
            return
        }

        // Secure-field correction: never emit the contents of a password field.
        if AXSecureRedaction.isSecureElement(element, transport: transport) {
            completion(WireFormat.success(AXSecureRedaction.placeholder))
            return
        }

        let mode = action["mode"] as? String ?? "full"

        switch mode {
        case "selection":
            let (result, value) = transport.copyAttributeValue(element, kAXSelectedTextAttribute as String)
            if result == .success, let text = AXValueCodec.displayString(value) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no selected text"))
            }
        case "visible":
            // Try visible character range, then fall back to full value
            let (rangeResult, rangeValue) = transport.copyAttributeValue(element, kAXVisibleCharacterRangeAttribute as String)
            if rangeResult == .success, var range = AXValueCodec.range(from: rangeValue) {
                // Use parameterized attribute to get text for range
                if let rangeVal = AXValueCreate(.cfRange, &range) {
                    let (textResult, textValue) = transport.copyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as String, rangeVal)
                    if textResult == .success, let text = AXValueCodec.displayString(textValue) {
                        completion(WireFormat.success(text))
                        return
                    }
                }
            }
            // Fallback to full value
            let (fullResult, fullValue) = transport.copyAttributeValue(element, kAXValueAttribute as String)
            if fullResult == .success, let text = AXValueCodec.displayString(fullValue) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no visible text"))
            }
        default: // "full"
            let (result, value) = transport.copyAttributeValue(element, kAXValueAttribute as String)
            if result == .success, let text = AXValueCodec.displayString(value) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no text value"))
            }
        }
    }
}
