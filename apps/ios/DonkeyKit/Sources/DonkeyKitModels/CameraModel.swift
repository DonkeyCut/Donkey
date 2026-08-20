import Foundation

/// Commands the camera model sends to whatever owns the capture session.
/// The app target's CameraController conforms; the model never imports
/// AVFoundation.
public protocol CameraControlling: AnyObject {
    func activate()
    func deactivate()
    func setFacing(_ facing: CameraFacing)
    func setZoom(display: Double)
    func setTorch(_ on: Bool)
    func apply(_ settings: CameraSettings)
    func startRecording()
    func stopRecording()
}

nonisolated public enum CameraAvailability: Equatable, Sendable {
    case idle
    case starting
    case running
    case unavailable(reason: String)
}

@Observable
public final class CameraModel {
    public internal(set) var availability: CameraAvailability = .idle
    public private(set) var facing: CameraFacing = .front
    public private(set) var settings = CameraSettings()
    /// What the device could honor for the current request, shown in the badge.
    public private(set) var effectiveSettings = CameraSettings()
    public internal(set) var zoomMapping = ZoomMapping(wideBase: 1, minDisplay: 1, maxDisplay: 1)
    public private(set) var zoom: Double = 1
    public private(set) var isTorchOn = false
    public internal(set) var hasTorch = false
    public internal(set) var recordingStartedAt: Date?
    public var teleprompter = TeleprompterState()

    public var isRecording: Bool { recordingStartedAt != nil }

    public var controller: (any CameraControlling)?

    public init() {}

    // MARK: Intents

    public func appeared() {
        availability = .starting
        controller?.activate()
    }

    public func disappeared() {
        controller?.deactivate()
        availability = .idle
    }

    public func flip() {
        facing = facing.flipped
        zoom = 1
        isTorchOn = false
        controller?.setFacing(facing)
    }

    public func select(zoom display: Double) {
        zoom = display
        controller?.setZoom(display: display)
    }

    /// True when the flash button does anything: the hardware torch, or the
    /// screen fill light on cameras without one.
    public var flashAvailable: Bool { hasTorch || facing == .front }

    /// The screen stands in for a torch the current camera lacks.
    public var isFillLightOn: Bool { isTorchOn && !hasTorch }

    public func toggleTorch() {
        isTorchOn.toggle()
        if hasTorch {
            controller?.setTorch(isTorchOn)
        }
    }

    public func update(_ transform: (inout CameraSettings) -> Void) {
        transform(&settings)
        controller?.apply(settings)
    }

    public func toggleRecording() {
        if isRecording {
            controller?.stopRecording()
        } else {
            controller?.startRecording()
        }
    }

    /// Loads a note into the teleprompter and shows the card.
    public func loadTeleprompter(script: String) {
        teleprompter.script = script
        teleprompter.isCardShown = true
    }

    // MARK: Controller events

    public func sessionDidStart(zoomMapping: ZoomMapping, hasTorch: Bool, effective: CameraSettings) {
        self.zoomMapping = zoomMapping
        self.hasTorch = hasTorch
        effectiveSettings = effective
        availability = .running
    }

    public func sessionFailed(reason: String) {
        availability = .unavailable(reason: reason)
    }

    public func recordingDidStart() {
        recordingStartedAt = .now
    }

    public func recordingDidFinish() {
        recordingStartedAt = nil
    }
}

/// Formats a duration as m:ss for the recording timer and duration badges.
nonisolated public func formattedDuration(_ seconds: TimeInterval) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    return "\(whole / 60):" + String(format: "%02d", whole % 60)
}
