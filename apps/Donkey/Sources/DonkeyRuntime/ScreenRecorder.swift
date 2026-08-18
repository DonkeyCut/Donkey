import CoreGraphics
import Foundation

/// What a screen recording captures: a whole display, a cropped region of a display, or a single
/// window. `region` is in display-local points with a top-left origin (the coordinate space
/// `SCStreamConfiguration.sourceRect` expects); `nil` means the full display.
public enum ScreenCaptureTarget: Equatable, Sendable {
    case display(displayID: CGDirectDisplayID, region: CGRect?)
    case window(windowID: CGWindowID)
}

/// Everything a recorder needs to start: what to capture, which audio sources to mix in, and where
/// the finished file goes. System audio is on by default; the microphone is off by default.
public struct ScreenRecordingConfiguration: Sendable {
    public var target: ScreenCaptureTarget
    public var capturesSystemAudio: Bool
    public var capturesMicrophone: Bool
    /// The microphone device to capture, when `capturesMicrophone` is set. `nil` uses the system default.
    public var microphoneDeviceID: String?
    /// Whether the pointer is burned into the video. Off: the recording carries the cursor as a
    /// `CursorTrack` sidecar instead, so an editor can draw it, follow it, or leave it out.
    public var showsCursor: Bool
    public var frameRate: Int
    /// Window IDs to keep out of the capture — our own control bar, so it never appears in the file.
    public var excludedWindowIDs: [CGWindowID]
    public var outputURL: URL

    public init(
        target: ScreenCaptureTarget,
        capturesSystemAudio: Bool = true,
        capturesMicrophone: Bool = false,
        microphoneDeviceID: String? = nil,
        showsCursor: Bool = false,
        frameRate: Int = 30,
        excludedWindowIDs: [CGWindowID] = [],
        outputURL: URL
    ) {
        self.target = target
        self.capturesSystemAudio = capturesSystemAudio
        self.capturesMicrophone = capturesMicrophone
        self.microphoneDeviceID = microphoneDeviceID
        self.showsCursor = showsCursor
        self.frameRate = frameRate
        self.excludedWindowIDs = excludedWindowIDs
        self.outputURL = outputURL
    }
}

public enum ScreenRecordingError: Error, Equatable, Sendable {
    case screenRecordingPermissionDenied
    case unsupportedOSVersion
    case displayUnavailable
    case windowUnavailable
    case notRecording
    case startFailed(String)
    case finalizeFailed(String)
}

/// A live screen recorder. `start` begins capture; `stop` finalizes and resolves only once the file
/// is on disk and playable (its `moov` atom written). Main-actor isolated so it pairs cleanly with the
/// AppKit controllers that drive it. The concrete engine is `SCRecordingScreenRecorder` (macOS 15+);
/// the protocol leaves room for an `AVAssetWriter` fallback on older systems.
@MainActor
public protocol ScreenRecording: AnyObject {
    var isRecording: Bool { get }
    /// Called if the stream stops on its own (display unplugged, permission revoked) rather than via `stop()`.
    var onUnexpectedStop: ((Error) -> Void)? { get set }
    func start(_ configuration: ScreenRecordingConfiguration) async throws
    func stop() async throws -> URL
}
