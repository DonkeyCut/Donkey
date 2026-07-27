import AVFoundation
import CoreGraphics
import Foundation

/// A macOS system (TCC) permission Donkey needs to record the screen.
public enum SystemPermission: Equatable, Sendable {
    case screenRecording
    case microphone
}

public enum SystemPermissionStatus: String, Sendable {
    case granted
    case notDetermined
    case denied
}

/// The single place that checks and requests macOS TCC permissions. Callers preflight through
/// `status(_:)`, which never prompts, and call `request(_:)` only when starting the recording the
/// user just asked for — so the system dialog never appears out of the blue.
public enum SystemPermissionCoordinator {
    /// A short user-facing label for the pre-gate banner.
    public static func displayName(_ permission: SystemPermission) -> String {
        switch permission {
        case .screenRecording:
            return "Screen Recording"
        case .microphone:
            return "Microphone"
        }
    }

    /// Whether the permission is already granted — never prompts.
    public static func status(_ permission: SystemPermission) -> SystemPermissionStatus {
        switch permission {
        case .screenRecording:
            return CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
        case .microphone:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return .granted
            case .notDetermined: return .notDetermined
            case .denied, .restricted: return .denied
            @unknown default: return .notDetermined
            }
        }
    }

    public static func isGranted(_ permission: SystemPermission) -> Bool {
        status(permission) == .granted
    }

    /// Triggers the macOS permission dialog and reports whether it ended up granted.
    @discardableResult
    public static func request(_ permission: SystemPermission) async -> Bool {
        switch permission {
        case .screenRecording:
            return CGRequestScreenCaptureAccess()
        case .microphone:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }
}
