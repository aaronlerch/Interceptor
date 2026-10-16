import Foundation
import CoreGraphics

// FORK-LOCAL: visible cursor glide for demo recordings. Window-addressed clicks
// never move the pointer and a bare positional click warps it, so a screen
// recording shows the cursor teleport. A glide posts real HID mouseMoved events
// along an eased path, so the pointer travels on screen and hover states fire.
// It moves the user's actual cursor: the `mouse` allowlist domain gates it
// (Router.route), and it is never part of the `recommended` set.

enum GlideEase: String {
    case inOut = "in-out"
    case linear

    func apply(_ t: Double) -> Double {
        switch self {
        case .linear: return t
        case .inOut: return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
        }
    }
}

struct GlidePlan {
    static let defaultMs = 700
    static let maxMs = 5000
    /// One step per ~8 ms (~120 Hz), at least 8 steps so short glides still read as motion.
    static func steps(forMs ms: Int) -> Int { max(8, ms / 8) }

    /// Points from just after `start` up to exactly `end` (the last point is `end`).
    static func path(from start: CGPoint, to end: CGPoint, ms: Int, ease: GlideEase) -> [CGPoint] {
        let n = steps(forMs: ms)
        return (1...n).map { i in
            if i == n { return end }
            let t = ease.apply(Double(i) / Double(n))
            return CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        }
    }

    /// Reads the glide options off an action. Accepts `glide: true` or
    /// `glide: {ms, ease}`, plus top-level `ms` / `ease` for `mouse move`.
    static func options(_ action: [String: Any]) -> (ms: Int, ease: GlideEase)? {
        var ms = (action["ms"] as? NSNumber)?.intValue
        var easeName = action["ease"] as? String
        if let g = action["glide"] as? [String: Any] {
            ms = (g["ms"] as? NSNumber)?.intValue ?? ms
            easeName = (g["ease"] as? String) ?? easeName
        }
        let clamped = min(max(ms ?? defaultMs, 0), maxMs)
        guard let ease = GlideEase(rawValue: easeName ?? "in-out") else { return nil }
        return (clamped, ease)
    }
}

enum CursorGlide {
    /// The cursor's current global position (top-left origin, all displays).
    static func currentPosition() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    /// Glides the visible cursor to `target` and blocks until the last event has
    /// landed, then returns the read-back position. Call off the main thread.
    @discardableResult
    static func glide(to target: CGPoint, ms: Int, ease: GlideEase) -> CGPoint {
        let start = currentPosition()
        let source = CGEventSource(stateID: .hidSystemState)
        let points = ms == 0 ? [target] : GlidePlan.path(from: start, to: target, ms: ms, ease: ease)
        let interval = points.count > 1 ? useconds_t(Double(ms) * 1000 / Double(points.count)) : 0
        for p in points {
            if let e = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
                e.post(tap: .cghidEventTap)
            } else {
                CGWarpMouseCursorPosition(p)
            }
            if interval > 0 { usleep(interval) }
        }
        // The HID tap is asynchronous: wait (bounded) for the read-back to reach
        // the target so the reported position is the real one, not a lagging one.
        let deadline = Date().addingTimeInterval(0.3)
        var now = currentPosition()
        while hypot(now.x - target.x, now.y - target.y) > 0.5, Date() < deadline {
            usleep(5_000)
            now = currentPosition()
        }
        return now
    }
}
