import Foundation
@preconcurrency import ScreenCaptureKit
import AppKit
import CoreMedia
import CoreGraphics

/// Window-scoped video recording: `capture record start|stop|status`.
///
/// ## Why this exists next to `capture start`
///
/// `MonitorDomain --video` already writes a continuous mp4 through
/// `SCRecordingOutput`, but its filter is always `content.displays.first` — the
/// whole screen — and it is welded to a monitor session that also records AX
/// events, mutations and network. Two things a *recording* caller needs and
/// cannot get from it:
///
/// 1. **One window, not the display.** A demo or a bug report wants the browser
///    window, not the reviewer's other monitor, Slack, or their inbox. Window
///    capture is also what makes recording usable while the machine is in use:
///    ScreenCaptureKit composites an occluded window's own surface, so the
///    window does not have to be frontmost. (Minimised is different — AppKit
///    stops backing an actually-minimised window, so restore it first.)
///
/// 2. **A first-frame timestamp the caller can trust.** `SCStream.startCapture`
///    returns when the stream *starts*, and the first sample buffer arrives
///    1500-2000ms later on macOS 14+ (the same documented gap
///    `CaptureDomain.handleFrame` already waits out). Any caller aligning an
///    external timeline — narration, a click log, subtitles — against this video
///    needs the wall clock of frame zero, not of the start call. `start` blocks
///    until a `.complete` frame lands and returns `startedAtMs`, so the caller
///    can compute its own offset arithmetically instead of guessing.
///
/// Everything else is deliberately absent. No frame files, no OCR, no speech,
/// no event log — this writes one mp4 and reports honestly about it.
final class WindowRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stream: SCStream?
    private var recordingOutput: SCRecordingOutput?
    private var recordingDelegate: RecordingLifecycleDelegate?
    private var probe: FirstCompleteFrameProbe?
    private var streamDelegate: CaptureStreamDelegateLogger?

    private var path: String?
    private var target: String?
    private var size: CGSize = .zero
    private var fps: Int = 0
    private var startedAt: Date?

    // MARK: - Wire entry point

    func handle(
        _ action: [String: Any],
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        switch action["recordOp"] as? String ?? "status" {
        case "start": start(action, completion: completion)
        case "stop": stop(action, completion: completion)
        case "status": completion(WireFormat.success(statusPayload()))
        default:
            completion(WireFormat.error("capture record: unknown op"))
        }
    }

    private func statusPayload() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var payload: [String: Any] = ["recording": stream != nil]
        if let path = path { payload["path"] = path }
        if let target = target { payload["target"] = target }
        if let startedAt = startedAt {
            payload["startedAtMs"] = Int(startedAt.timeIntervalSince1970 * 1000)
            payload["elapsedSec"] = Date().timeIntervalSince(startedAt)
        }
        if size != .zero {
            payload["width"] = Int(size.width)
            payload["height"] = Int(size.height)
        }
        if fps > 0 { payload["fps"] = fps }
        if let out = recordingOutput {
            payload["bytes"] = out.recordedFileSize
            payload["recordedSec"] = out.recordedDuration.seconds
        }
        return payload
    }

    // MARK: - Target resolution

    private struct Target {
        let filter: SCContentFilter
        let size: CGSize
        let describe: String
    }

    /// Everything the async start path needs, read off the wire dict on the
    /// calling thread. `[String: Any]` is not Sendable, so capturing `action`
    /// in a `Task` is a data race the compiler rejects — the same reason
    /// `CaptureDomain.startContinuousCapture` reads `--app` before its Task.
    private struct Request: Sendable {
        let out: String
        let app: String?
        let window: Int?
        let titleContains: String?
        let fps: Int
        let pixelScale: Int
        let showsCursor: Bool
        let firstFrameTimeoutMs: Int
    }

    /// Resolve what to record, in descending order of precision:
    /// explicit window id → app name (+ optional title substring) → display.
    ///
    /// For an app, the *largest* window wins. Apps register 0x0 helper windows
    /// and menu-bar items, and `content.windows.first(where: app)` picks
    /// whichever the list happens to yield — which is how you end up recording
    /// a 1x1 surface and only find out at assembly.
    private func resolveTarget(
        _ request: Request,
        content: SCShareableContent
    ) throws -> Target {
        let scale = request.pixelScale

        if let windowId = request.window,
           let window = content.windows.first(where: { Int($0.windowID) == windowId }) {
            return Target(
                filter: SCContentFilter(desktopIndependentWindow: window),
                size: CGSize(
                    width: window.frame.width * CGFloat(scale),
                    height: window.frame.height * CGFloat(scale)
                ),
                describe: "window \(windowId) (\(window.title ?? "untitled"))"
            )
        }

        if let appName = request.app {
            let titleNeedle = request.titleContains?.lowercased()
            var candidates = content.windows.filter {
                $0.owningApplication?.applicationName == appName
            }
            if candidates.isEmpty {
                throw RecorderError.message(
                    "no windows found for app \"\(appName)\". Open one, or pass "
                        + "--window <id>; `interceptor macos windows` lists them."
                )
            }
            if let needle = titleNeedle {
                let matched = candidates.filter {
                    ($0.title ?? "").lowercased().contains(needle)
                }
                if matched.isEmpty {
                    throw RecorderError.message(
                        "app \"\(appName)\" has no window whose title contains "
                            + "\"\(needle)\". Titles: "
                            + candidates.map { "\"\($0.title ?? "")\"" }
                                .joined(separator: ", ")
                    )
                }
                candidates = matched
            }
            candidates.sort {
                ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height)
            }
            let window = candidates[0]
            // A window AppKit has stopped backing reports a real frame but
            // composites nothing, so the mp4 comes out a solid colour. Saying
            // so here costs one line; finding it out from the finished video
            // costs a whole take.
            if window.frame.width < 2 || window.frame.height < 2 {
                throw RecorderError.message(
                    "the largest window for \"\(appName)\" is "
                        + "\(Int(window.frame.width))x\(Int(window.frame.height)) — "
                        + "it is minimised or has no backing surface. Restore it first."
                )
            }
            return Target(
                filter: SCContentFilter(desktopIndependentWindow: window),
                size: CGSize(
                    width: window.frame.width * CGFloat(scale),
                    height: window.frame.height * CGFloat(scale)
                ),
                describe: "\(appName) — \"\(window.title ?? "untitled")\""
            )
        }

        guard let display = content.displays.first else {
            throw RecorderError.message("no capturable content")
        }
        return Target(
            filter: SCContentFilter(
                display: display, excludingApplications: [], exceptingWindows: []
            ),
            size: CGSize(
                width: display.width * scale, height: display.height * scale
            ),
            describe: "display \(display.displayID)"
        )
    }

    // MARK: - Start

    private func start(
        _ action: [String: Any],
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        lock.lock()
        let alreadyRunning = stream != nil
        lock.unlock()
        if alreadyRunning {
            completion(WireFormat.error(
                "already recording — `capture record stop` first"
            ))
            return
        }

        guard let out = action["out"] as? String, !out.isEmpty else {
            completion(WireFormat.error("capture record start requires --out <path.mp4>"))
            return
        }
        let request = Request(
            out: out,
            app: action["app"] as? String,
            window: action["window"] as? Int,
            titleContains: action["titleContains"] as? String,
            fps: max(1, min(60, action["fps"] as? Int ?? 30)),
            pixelScale: max(1, action["pixelScale"] as? Int ?? 2),
            showsCursor: action["cursor"] as? Bool ?? false,
            firstFrameTimeoutMs: action["timeoutMs"] as? Int ?? 5000
        )
        let requestedFps = request.fps
        let showsCursor = request.showsCursor
        let firstFrameTimeoutMs = request.firstFrameTimeoutMs

        let outURL = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
        do {
            try FileManager.default.createDirectory(
                at: outURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            completion(WireFormat.error(
                "cannot create \(outURL.deletingLastPathComponent().path): "
                    + error.localizedDescription
            ))
            return
        }
        // SCRecordingOutput refuses to start if the file exists, and fails
        // through the delegate rather than the start call — which would look
        // like a successful start followed by an empty file.
        try? FileManager.default.removeItem(at: outURL)

        Task { [weak self] in
            guard let self = self else { return }
            do {
                let content = try await SCShareableContent.current
                let target = try self.resolveTarget(request, content: content)

                let config = SCStreamConfiguration()
                config.width = Int(target.size.width)
                config.height = Int(target.size.height)
                config.scalesToFit = true
                config.captureResolution = .best
                config.pixelFormat = kCVPixelFormatType_32BGRA
                config.showsCursor = showsCursor
                config.minimumFrameInterval = CMTime(
                    value: 1, timescale: CMTimeScale(requestedFps)
                )
                config.queueDepth = 6

                let streamDelegate = CaptureStreamDelegateLogger()
                let stream = SCStream(
                    filter: target.filter,
                    configuration: config,
                    delegate: streamDelegate
                )

                // The probe exists only to stamp frame zero's wall clock and
                // count frames. It does no pixel work — a per-frame encode at
                // 30fps would compete with the recorder for the same queue.
                let probe = FirstCompleteFrameProbe()
                try stream.addStreamOutput(
                    probe,
                    type: .screen,
                    sampleHandlerQueue: DispatchQueue.global(qos: .userInitiated)
                )

                let recCfg = SCRecordingOutputConfiguration()
                recCfg.outputURL = outURL
                recCfg.outputFileType = .mp4
                // Codec is not configurable on SCRecordingOutputConfiguration
                // (macOS 15); SCK picks the container's default, which for
                // .mp4 is H.264. Nothing to set, and nothing to assume beyond
                // "the container plays" — verified with ffprobe, not here.
                let recDelegate = RecordingLifecycleDelegate(path: outURL.path)
                let recOutput = SCRecordingOutput(
                    configuration: recCfg, delegate: recDelegate
                )
                try stream.addRecordingOutput(recOutput)

                try await stream.startCapture()

                self.lock.withLock {
                    self.stream = stream
                    self.recordingOutput = recOutput
                    self.recordingDelegate = recDelegate
                    self.probe = probe
                    self.streamDelegate = streamDelegate
                    self.path = outURL.path
                    self.target = target.describe
                    self.size = target.size
                    self.fps = requestedFps
                    self.startedAt = nil
                }

                // Block on frame zero. Reporting a start time taken from here
                // instead would be wrong by the whole cold-start gap, and every
                // offset the caller derives from it would inherit that error.
                guard let firstFrame = await probe.waitForFirstFrame(
                    timeoutMs: firstFrameTimeoutMs
                ) else {
                    // Tear down rather than leave a stream writing to a file
                    // nobody is going to trust.
                    try? stream.removeRecordingOutput(recOutput)
                    try? await stream.stopCapture()
                    self.lock.withLock { self.reset() }
                    completion(WireFormat.error(
                        "no frame arrived within \(firstFrameTimeoutMs)ms for "
                            + "\(target.describe). Screen Recording permission is "
                            + "the usual cause — check `interceptor macos trust`. "
                            + "A minimised window is the other."
                    ))
                    return
                }

                if let failure = recDelegate.failure {
                    try? await stream.stopCapture()
                    self.lock.withLock { self.reset() }
                    completion(WireFormat.error("recording failed to start: \(failure)"))
                    return
                }

                self.lock.withLock { self.startedAt = firstFrame }
                completion(WireFormat.success([
                    "recording": true,
                    "path": outURL.path,
                    "target": target.describe,
                    "width": Int(target.size.width),
                    "height": Int(target.size.height),
                    "fps": requestedFps,
                    "cursor": showsCursor,
                    // Wall clock of the first frame actually written. Anchor
                    // external timelines to THIS, not to when you called start.
                    "startedAtMs": Int(firstFrame.timeIntervalSince1970 * 1000),
                    "startLatencyMs": probe.latencyMs,
                ]))
            } catch let RecorderError.message(message) {
                completion(WireFormat.error(message))
            } catch {
                // By far the most common failure, and Apple's own string
                // ("The user declined TCCs for application, window, display
                // capture") names no remedy. Say where the switch is, and say
                // the thing that is not obvious: an ad-hoc-signed bridge is
                // pinned by cdhash, so a rebuild silently invalidates a grant
                // that is still listed as enabled.
                let description = error.localizedDescription
                if description.lowercased().contains("tcc")
                    || description.lowercased().contains("declined")
                {
                    completion(WireFormat.error(
                        """
                        Screen Recording permission is not granted to interceptor-bridge.
                          System Settings → Privacy & Security → Screen Recording → enable interceptor-bridge
                          Then restart it:  open -gj <path-to>/dist/interceptor-bridge.app
                        If the row is already enabled, this build is not the one it was granted to —
                        an ad-hoc-signed bridge is pinned by code hash, so any rebuild invalidates it.
                        Remove the row with (−) and re-add.
                          (\(description))
                        """
                    ))
                    return
                }
                completion(WireFormat.error(
                    "capture record start failed: \(description)"
                ))
            }
        }
    }

    // MARK: - Stop

    private func stop(
        _ action: [String: Any],
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        lock.lock()
        guard let stream = stream, let recOutput = recordingOutput else {
            lock.unlock()
            completion(WireFormat.success(["recording": false]))
            return
        }
        let path = self.path
        let target = self.target
        let startedAt = self.startedAt
        let delegate = self.recordingDelegate
        let frames = self.probe?.frameCount ?? 0
        let fps = self.fps
        let size = self.size
        lock.unlock()

        let finishTimeoutMs = action["timeoutMs"] as? Int ?? 10000

        Task { [weak self, finishTimeoutMs] in
            let stoppedAt = Date()

            // Stop the STREAM and let it finalise the recording output. Do NOT
            // removeRecordingOutput first: yanking the output from a running
            // stream races its finalisation, and the outcome is one of two
            // wrong answers — `didFailWithError` (so a complete file is
            // reported `finalized:false` with an error) or a `stopCapture()`
            // that never returns (so the verb wedges past the CLI's 15s
            // ceiling with the mp4 already whole on disk). Both were observed
            // on the same build, minutes apart, which is what a race looks
            // like. Stopping the stream is the documented way to close an
            // SCRecordingOutput cleanly. (2026-09-10)
            await Self.withTimeout(seconds: 10) {
                try? await stream.stopCapture()
            }

            // SCRecordingOutput finalises the container asynchronously even
            // after the stream is down. Return before that and the caller
            // reads a file whose moov atom has not been written — ffprobe
            // reports a broken duration, or nothing.
            let finished = await delegate?.waitForFinish(timeoutMs: finishTimeoutMs) ?? true

            let bytes = recOutput.recordedFileSize
            let recordedSec = recOutput.recordedDuration.seconds
            self?.lock.withLock { self?.reset() }

            var payload: [String: Any] = [
                "recording": false,
                "frames": frames,
                "fps": fps,
                "width": Int(size.width),
                "height": Int(size.height),
                "bytes": bytes,
                "recordedSec": recordedSec,
                "finalized": finished,
                "stoppedAtMs": Int(stoppedAt.timeIntervalSince1970 * 1000),
            ]
            if let path = path { payload["path"] = path }
            if let target = target { payload["target"] = target }
            if let startedAt = startedAt {
                payload["startedAtMs"] = Int(startedAt.timeIntervalSince1970 * 1000)
                payload["wallSec"] = stoppedAt.timeIntervalSince(startedAt)
            }
            if let failure = delegate?.failure { payload["error"] = failure }
            if !finished {
                payload["warning"] =
                    "the container was not confirmed finalised within "
                    + "\(finishTimeoutMs)ms; the file may be truncated"
            }
            completion(WireFormat.success(payload))
        }
    }

    /// Run `body`, giving up after `seconds`. ScreenCaptureKit calls are
    /// normally prompt, but one that hangs must not take the wire request with
    /// it — a caller that gets no reply cannot even find out where its file is.
    private static func withTimeout(
        seconds: Double,
        _ body: @escaping @Sendable () async -> Void
    ) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await body() }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
            await group.next()
            group.cancelAll()
        }
    }

    /// Caller holds `lock`.
    private func reset() {
        // Dropping the reference is the teardown. The stream has already been
        // stopped, which is what finalises the output — see stop().
        stream = nil
        recordingOutput = nil
        recordingDelegate = nil
        probe = nil
        streamDelegate = nil
        path = nil
        target = nil
        startedAt = nil
        size = .zero
        fps = 0
    }
}

enum RecorderError: Error {
    case message(String)
}

/// Stamps the wall clock of the first `.complete` sample buffer and counts the
/// rest. Deliberately does no pixel work.
final class FirstCompleteFrameProbe: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var first: Date?
    private var count = 0
    private let createdAt = Date()

    var frameCount: Int { lock.withLock { count } }

    /// Milliseconds between constructing the probe and frame zero — the
    /// ScreenCaptureKit cold start, measured rather than assumed.
    var latencyMs: Int {
        lock.withLock {
            guard let first = first else { return -1 }
            return Int(first.timeIntervalSince(createdAt) * 1000)
        }
    }

    /// Polled, not semaphored. `DispatchSemaphore.wait` inside a Swift
    /// concurrency `Task` blocks a cooperative thread the runtime is entitled
    /// to reuse, and ScreenCaptureKit delivers both sample buffers and
    /// recording-lifecycle callbacks on queues of its own choosing — so a
    /// blocking wait here can outlive its own timeout and never return. It did:
    /// `capture record stop` hung past the CLI's 15s ceiling with the mp4
    /// already complete on disk (2026-09-10). 20ms polling costs nothing next
    /// to a 1.5s cold start and cannot wedge.
    func waitForFirstFrame(timeoutMs: Int) async -> Date? {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while true {
            if let existing = lock.withLock({ first }) { return existing }
            if Date() >= deadline { return nil }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen else { return }
        // Only `.complete` carries pixels. An unchanged window delivers `.idle`
        // forever, so counting those would report frame zero before anything
        // had actually been composited.
        if let attachments = (CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]])?.first,
            let raw = attachments[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw),
            status != .complete
        {
            return
        }
        lock.withLock {
            count += 1
            if first == nil { first = Date() }
        }
    }
}

/// Bridges `SCRecordingOutput`'s async lifecycle into something a synchronous
/// wire call can wait on.
final class RecordingLifecycleDelegate: NSObject, SCRecordingOutputDelegate,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var failureMessage: String?
    private var finishedFlag = false
    let path: String

    init(path: String) {
        self.path = path
    }

    var failure: String? { lock.withLock { failureMessage } }
    var finished: Bool { lock.withLock { finishedFlag } }

    /// Polled for the same reason as the probe above — see waitForFirstFrame.
    /// A failure counts as finished: the caller wants to stop waiting and
    /// report, and `failure` carries the reason.
    func waitForFinish(timeoutMs: Int) async -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while true {
            let (done, failed) = lock.withLock {
                (finishedFlag, failureMessage != nil)
            }
            if done { return true }
            if failed { return false }
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        Platform.log("capture record: writing \(path)")
    }

    func recordingOutput(
        _ recordingOutput: SCRecordingOutput, didFailWithError error: Error
    ) {
        lock.withLock { failureMessage = error.localizedDescription }
        Platform.log("capture record: FAILED \(path) — \(error.localizedDescription)")
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        lock.withLock { finishedFlag = true }
        Platform.log(
            "capture record: finished \(path) "
                + "(\(recordingOutput.recordedFileSize) bytes, "
                + "\(recordingOutput.recordedDuration.seconds)s)"
        )
    }
}
