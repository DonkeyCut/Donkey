import Foundation

/// The camera as the watch sees it. The phone sends one of these whenever
/// the camera's state changes and in reply to a hello.
///
/// A take's age travels as elapsed seconds, so the watch starts its own
/// clock on receipt and never depends on the two clocks agreeing.
nonisolated public struct CameraRemoteState: Codable, Equatable, Sendable {
    /// True while the phone's camera is on screen and running.
    public var isCameraOpen: Bool
    /// Which camera the picture comes from. A change means the last frame
    /// the watch holds is of the other camera.
    public var facing: CameraFacing
    /// Seconds into the take, or nil when the camera is not recording.
    public var recordingElapsed: TimeInterval?

    public init(isCameraOpen: Bool = false, facing: CameraFacing = .front, recordingElapsed: TimeInterval? = nil) {
        self.isCameraOpen = isCameraOpen
        self.facing = facing
        self.recordingElapsed = recordingElapsed
    }

    public var isRecording: Bool { recordingElapsed != nil }
}

/// What the watch asks of the phone.
nonisolated public enum CameraRemoteCommand: Codable, Equatable, Sendable {
    /// The watch came on screen and wants the state back in the reply.
    case hello
    /// Start a take, or stop the one running.
    case toggleRecording
    /// Whether the watch is looking at the picture and wants frames.
    case preview(Bool)
}

/// The envelope both ends put a state or a command in: one key, one JSON
/// value, inside a WatchConnectivity message dictionary.
nonisolated public enum CameraRemoteMessage {
    public static let stateKey = "state"
    public static let commandKey = "command"

    public static func encode(_ state: CameraRemoteState) -> [String: Any] {
        [stateKey: (try? JSONEncoder().encode(state)) ?? Data()]
    }

    public static func encode(_ command: CameraRemoteCommand) -> [String: Any] {
        [commandKey: (try? JSONEncoder().encode(command)) ?? Data()]
    }

    public static func state(in message: [String: Any]) -> CameraRemoteState? {
        guard let data = message[stateKey] as? Data else { return nil }
        return try? JSONDecoder().decode(CameraRemoteState.self, from: data)
    }

    public static func command(in message: [String: Any]) -> CameraRemoteCommand? {
        guard let data = message[commandKey] as? Data else { return nil }
        return try? JSONDecoder().decode(CameraRemoteCommand.self, from: data)
    }
}
