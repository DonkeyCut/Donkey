import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// The macOS 15+ screen recorder. ScreenCaptureKit's `SCRecordingOutput` owns the encoder and the
/// audio/video mux, so this class only assembles the content filter + stream configuration, starts the
/// stream, and awaits a finalized file on stop. System audio and (optionally) the microphone are mixed
/// into the same `.mov`. A sub-region is captured with `sourceRect` — the GPU crops, so no full-frame
/// re-encode.
@available(macOS 15.0, *)
@MainActor
public final class SCRecordingScreenRecorder: ScreenRecording {
    public private(set) var isRecording = false
    public var onUnexpectedStop: ((Error) -> Void)?

    private var stream: SCStream?
    private var recordingOutput: SCRecordingOutput?
    private var delegate: RecorderDelegate?
    private var outputURL: URL?
    private var pendingFinish: CheckedContinuation<URL, Error>?

    public init() {}

    public func start(_ configuration: ScreenRecordingConfiguration) async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw ScreenRecordingError.screenRecordingPermissionDenied
        }

        let content = try await SCShareableContent.current
        let filter = try Self.makeFilter(for: configuration, content: content)
        let info = SCShareableContent.info(for: filter)
        let scale = CGFloat(info.pointPixelScale)

        let streamConfig = SCStreamConfiguration()
        // Geometry: crop to the region for a display target, else capture the whole content rect.
        let capturePoints: CGRect
        if case .display(_, let region) = configuration.target, let region {
            streamConfig.sourceRect = region
            capturePoints = region
        } else {
            capturePoints = info.contentRect
        }
        streamConfig.width = Self.evenPixels(capturePoints.width, scale: scale)
        streamConfig.height = Self.evenPixels(capturePoints.height, scale: scale)
        streamConfig.scalesToFit = false
        streamConfig.ignoreShadowsSingleWindow = true

        // System audio (default on) — never record our own UI sounds.
        streamConfig.capturesAudio = configuration.capturesSystemAudio
        streamConfig.sampleRate = 48_000
        streamConfig.channelCount = 2
        streamConfig.excludesCurrentProcessAudio = true
        streamConfig.captureMicrophone = configuration.capturesMicrophone
        if configuration.capturesMicrophone, let deviceID = configuration.microphoneDeviceID {
            streamConfig.microphoneCaptureDeviceID = deviceID
        }

        // Video.
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(configuration.frameRate))
        streamConfig.showsCursor = configuration.showsCursor
        streamConfig.queueDepth = 6
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA

        let recordingConfig = SCRecordingOutputConfiguration()
        recordingConfig.outputURL = configuration.outputURL
        recordingConfig.outputFileType = .mov
        // HEVC is ~2x more efficient than H.264 for screen content and is what QuickTime records — half
        // the file at equal or better quality. Every macOS 15 Mac has a hardware HEVC encoder; fall back
        // to H.264 only if the encoder can't offer HEVC for this container.
        recordingConfig.videoCodecType =
            recordingConfig.availableVideoCodecTypes.contains(.hevc) ? .hevc : .h264

        let delegate = RecorderDelegate()
        delegate.owner = self
        let output = SCRecordingOutput(configuration: recordingConfig, delegate: delegate)
        let stream = SCStream(filter: filter, configuration: streamConfig, delegate: delegate)
        do {
            try stream.addRecordingOutput(output)
            try await stream.startCapture()
        } catch {
            throw ScreenRecordingError.startFailed(error.localizedDescription)
        }

        self.stream = stream
        self.recordingOutput = output
        self.delegate = delegate
        self.outputURL = configuration.outputURL
        isRecording = true
    }

    public func stop() async throws -> URL {
        guard let stream, isRecording else { throw ScreenRecordingError.notRecording }
        return try await withCheckedThrowingContinuation { continuation in
            pendingFinish = continuation
            Task { @MainActor in
                do {
                    try await stream.stopCapture()
                    // Success is delivered by the recording-output delegate once the file is finalized.
                } catch {
                    finish(with: .failure(ScreenRecordingError.finalizeFailed(error.localizedDescription)))
                }
            }
        }
    }

    // MARK: - Delegate callbacks (hopped to the main actor)

    fileprivate func handleRecordingFinished(error: Error?) {
        if let error {
            finish(with: .failure(ScreenRecordingError.finalizeFailed(error.localizedDescription)))
        } else {
            finish(with: .success(()))
        }
    }

    fileprivate func handleStreamStopped(error: Error) {
        if pendingFinish != nil {
            // A stop is in flight; an error stop may not deliver a finish callback, so resolve it here.
            finish(with: .failure(ScreenRecordingError.finalizeFailed(error.localizedDescription)))
        } else if isRecording {
            isRecording = false
            teardown()
            onUnexpectedStop?(error)
        }
    }

    private func finish(with result: Result<Void, Error>) {
        guard let continuation = pendingFinish else { return }
        pendingFinish = nil
        isRecording = false
        let url = outputURL
        teardown()
        switch result {
        case .success:
            if let url {
                continuation.resume(returning: url)
            } else {
                continuation.resume(throwing: ScreenRecordingError.finalizeFailed("missing output URL"))
            }
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private func teardown() {
        stream = nil
        recordingOutput = nil
        delegate = nil
        outputURL = nil
    }

    // MARK: - Helpers

    private static func makeFilter(
        for configuration: ScreenRecordingConfiguration,
        content: SCShareableContent
    ) throws -> SCContentFilter {
        switch configuration.target {
        case .display(let displayID, _):
            guard let display = content.displays.first(where: { $0.displayID == displayID })
                ?? content.displays.first else {
                throw ScreenRecordingError.displayUnavailable
            }
            let excluded = content.windows.filter { configuration.excludedWindowIDs.contains($0.windowID) }
            return SCContentFilter(display: display, excludingWindows: excluded)
        case .window(let windowID):
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                throw ScreenRecordingError.windowUnavailable
            }
            return SCContentFilter(desktopIndependentWindow: window)
        }
    }

    /// Pixel dimension for `points × scale`, rounded down to an even number — H.264 requires even
    /// width/height, and a stray odd pixel otherwise fails the encoder.
    private static func evenPixels(_ points: CGFloat, scale: CGFloat) -> Int {
        let pixels = Int((points * scale).rounded())
        return max(2, pixels - (pixels % 2))
    }
}

/// A nonisolated bridge for ScreenCaptureKit's delegate callbacks, which arrive on a background queue.
/// It forwards each event to the main-actor recorder; keeping it off the recorder means the recorder
/// can stay `@MainActor` without ScreenCaptureKit calling main-actor methods from the wrong thread.
@available(macOS 15.0, *)
private final class RecorderDelegate: NSObject, SCStreamDelegate, SCRecordingOutputDelegate, @unchecked Sendable {
    weak var owner: SCRecordingScreenRecorder?

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let owner = self.owner
        Task { @MainActor in owner?.handleStreamStopped(error: error) }
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        let owner = self.owner
        Task { @MainActor in owner?.handleRecordingFinished(error: error) }
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        let owner = self.owner
        Task { @MainActor in owner?.handleRecordingFinished(error: nil) }
    }
}
