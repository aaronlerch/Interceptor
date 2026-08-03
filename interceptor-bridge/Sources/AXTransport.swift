import Foundation
import ApplicationServices

// the single AX C-call boundary.
//
// One protocol owns every Accessibility C function the product uses. After this seam lands
// no domain calls an AX C function directly; each goes through an injected
// `AXTransport`. `LiveAXTransport` (below) is the only production implementation
// that touches ApplicationServices; `FakeAXTransport` (test target) drives the
// same surface with deterministic graphs, delays, per-slot errors, and
// cannotComplete-after-effect fixtures.
//
// Return shape: every fallible read returns `(AXError, T?)` so callers branch on
// the status and never force-unwrap. Values cross as `CFTypeRef` and are decoded
// through `AXValueCodec` — the bridge never force-casts an unverified value.
protocol AXTransport: Sendable {
    // element creation
    func createApplication(pid: pid_t) -> AXUIElement
    func createSystemWide() -> AXUIElement

    // attribute reads
    func copyAttributeValue(_ element: AXUIElement, _ attribute: String) -> (AXError, CFTypeRef?)
    func copyMultipleAttributeValues(_ element: AXUIElement, _ attributes: [String], stopOnError: Bool) -> (AXError, [CFTypeRef]?)
    func copyAttributeNames(_ element: AXUIElement) -> (AXError, [String]?)
    func attributeValueCount(_ element: AXUIElement, _ attribute: String) -> (AXError, Int?)
    func copyAttributeValues(_ element: AXUIElement, _ attribute: String, index: Int, maxValues: Int) -> (AXError, [CFTypeRef]?)

    // settability + mutation
    func isAttributeSettable(_ element: AXUIElement, _ attribute: String) -> (AXError, Bool?)
    func setAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError

    // parameterized
    func copyParameterizedAttributeNames(_ element: AXUIElement) -> (AXError, [String]?)
    func copyParameterizedAttributeValue(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef) -> (AXError, CFTypeRef?)

    // actions
    func copyActionNames(_ element: AXUIElement) -> (AXError, [String]?)
    func copyActionDescription(_ element: AXUIElement, _ action: String) -> (AXError, String?)
    func performAction(_ element: AXUIElement, _ action: String) -> AXError

    // hit test + identity + timeout
    func copyElementAtPosition(_ application: AXUIElement, x: Float, y: Float) -> (AXError, AXUIElement?)
    func pid(_ element: AXUIElement) -> (AXError, pid_t?)
    func setMessagingTimeout(_ element: AXUIElement, seconds: Float) -> AXError

    // observers
    func observerCreate(pid: pid_t, callback: @escaping AXObserverCallback) -> (AXError, AXObserver?)
    func observerAddNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String, _ refcon: UnsafeMutableRawPointer?) -> AXError
    func observerRemoveNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String) -> AXError
    func observerGetRunLoopSource(_ observer: AXObserver) -> CFRunLoopSource

    // process trust (global predicate — no element, cannot hang)
    func isProcessTrusted() -> Bool
    func isProcessTrustedWithOptions(_ options: CFDictionary) -> Bool
}

// The only production implementation. Stateless, so trivially Sendable. Each
// method is a faithful, thin wrapper over the AX C function — no policy, no
// budget, no decoding lives here. Budgets/deadlines/codec are layered above it
// (a later layer) precisely because this seam exists.
struct LiveAXTransport: AXTransport {
    func createApplication(pid: pid_t) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    func createSystemWide() -> AXUIElement {
        AXUIElementCreateSystemWide()
    }

    func copyAttributeValue(_ element: AXUIElement, _ attribute: String) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return (err, value)
    }

    func copyMultipleAttributeValues(_ element: AXUIElement, _ attributes: [String], stopOnError: Bool) -> (AXError, [CFTypeRef]?) {
        var values: CFArray?
        let options: AXCopyMultipleAttributeOptions = stopOnError ? .stopOnError : AXCopyMultipleAttributeOptions(rawValue: 0)
        let err = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, options, &values)
        return (err, values as? [CFTypeRef])
    }

    func copyAttributeNames(_ element: AXUIElement) -> (AXError, [String]?) {
        var names: CFArray?
        let err = AXUIElementCopyAttributeNames(element, &names)
        return (err, names as? [String])
    }

    func attributeValueCount(_ element: AXUIElement, _ attribute: String) -> (AXError, Int?) {
        var count: CFIndex = 0
        let err = AXUIElementGetAttributeValueCount(element, attribute as CFString, &count)
        return (err, err == .success ? Int(count) : nil)
    }

    func copyAttributeValues(_ element: AXUIElement, _ attribute: String, index: Int, maxValues: Int) -> (AXError, [CFTypeRef]?) {
        var values: CFArray?
        let err = AXUIElementCopyAttributeValues(element, attribute as CFString, CFIndex(index), CFIndex(maxValues), &values)
        return (err, values as? [CFTypeRef])
    }

    func isAttributeSettable(_ element: AXUIElement, _ attribute: String) -> (AXError, Bool?) {
        var settable: DarwinBoolean = false
        let err = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return (err, err == .success ? settable.boolValue : nil)
    }

    func setAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(element, attribute as CFString, value)
    }

    func copyParameterizedAttributeNames(_ element: AXUIElement) -> (AXError, [String]?) {
        var names: CFArray?
        let err = AXUIElementCopyParameterizedAttributeNames(element, &names)
        return (err, names as? [String])
    }

    func copyParameterizedAttributeValue(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let err = AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, parameter, &value)
        return (err, value)
    }

    func copyActionNames(_ element: AXUIElement) -> (AXError, [String]?) {
        var names: CFArray?
        let err = AXUIElementCopyActionNames(element, &names)
        return (err, names as? [String])
    }

    func copyActionDescription(_ element: AXUIElement, _ action: String) -> (AXError, String?) {
        var desc: CFString?
        let err = AXUIElementCopyActionDescription(element, action as CFString, &desc)
        return (err, desc as String?)
    }

    func performAction(_ element: AXUIElement, _ action: String) -> AXError {
        AXUIElementPerformAction(element, action as CFString)
    }

    func copyElementAtPosition(_ application: AXUIElement, x: Float, y: Float) -> (AXError, AXUIElement?) {
        var element: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(application, x, y, &element)
        return (err, element)
    }

    func pid(_ element: AXUIElement) -> (AXError, pid_t?) {
        var p: pid_t = 0
        let err = AXUIElementGetPid(element, &p)
        return (err, err == .success ? p : nil)
    }

    func setMessagingTimeout(_ element: AXUIElement, seconds: Float) -> AXError {
        AXUIElementSetMessagingTimeout(element, seconds)
    }

    func observerCreate(pid: pid_t, callback: @escaping AXObserverCallback) -> (AXError, AXObserver?) {
        var observer: AXObserver?
        let err = AXObserverCreate(pid, callback, &observer)
        return (err, observer)
    }

    func observerAddNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String, _ refcon: UnsafeMutableRawPointer?) -> AXError {
        AXObserverAddNotification(observer, element, notification as CFString, refcon)
    }

    func observerRemoveNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String) -> AXError {
        AXObserverRemoveNotification(observer, element, notification as CFString)
    }

    func observerGetRunLoopSource(_ observer: AXObserver) -> CFRunLoopSource {
        AXObserverGetRunLoopSource(observer)
    }

    func isProcessTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    func isProcessTrustedWithOptions(_ options: CFDictionary) -> Bool {
        AXIsProcessTrustedWithOptions(options)
    }
}
