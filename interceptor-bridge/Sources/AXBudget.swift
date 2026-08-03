import Foundation

// per-command budget + deadline meter.
//
// Bounds a traversal by wall-clock deadline, nodes visited, and AX calls issued,
// so a large or slow target cannot stall a command (the exact unbounded-walk
// gap). Cancellation is cooperative: the walker checks `shouldStop()`
// between synchronous AX calls. A per-element messaging timeout
// (`AXTransport.setMessagingTimeout`) is the in-flight bound for a single call
// already inside the C API — a Swift deadline cannot interrupt that.
//
// Created per command and used only within that command's synchronous flow, so
// it needs no Sendable conformance.
final class AXBudget {
    let deadline: Date
    let maxNodes: Int
    let maxCalls: Int
    private(set) var nodesVisited = 0
    private(set) var callsUsed = 0
    private(set) var limitHit: String?

    init(maxMs: Int, maxNodes: Int, maxCalls: Int, now: Date = Date()) {
        self.deadline = now.addingTimeInterval(Double(maxMs) / 1000.0)
        self.maxNodes = maxNodes
        self.maxCalls = maxCalls
    }

    func countNode() { nodesVisited += 1 }
    func countCalls(_ n: Int) { callsUsed += n }

    /// True once any bound is exceeded; records the first reason and sticks.
    func shouldStop(now: Date = Date()) -> Bool {
        if limitHit != nil { return true }
        if nodesVisited >= maxNodes { limitHit = "max_nodes"; return true }
        if callsUsed >= maxCalls { limitHit = "budget_exceeded"; return true }
        if now >= deadline { limitHit = "deadline_exceeded"; return true }
        return false
    }

    /// A short human marker for the compatibility text outputs. Empty when no
    /// limit was hit. (The structured snapshot command emits this in `meta`.)
    var stopMarker: String {
        guard let reason = limitHit else { return "" }
        return "… (stopped: \(reason); visited \(nodesVisited) nodes, \(callsUsed) AX calls)"
    }

    // Product-safety defaults + hard caps for scan-class commands.
    static let defaultMaxMs = 5_000
    static let hardMaxMs = 10_000
    static let defaultMaxNodes = 2_000
    static let hardMaxNodes = 10_000
    static let defaultMaxCalls = 12_000
    static let hardMaxCalls = 50_000
    static let scanMessagingTimeoutSeconds: Float = 0.5

    /// Clamp a caller-supplied value into `[1, hard]`, falling back to `def`.
    static func clamp(_ value: Int?, def: Int, hard: Int) -> Int {
        guard let v = value, v > 0 else { return def }
        return min(v, hard)
    }
}
