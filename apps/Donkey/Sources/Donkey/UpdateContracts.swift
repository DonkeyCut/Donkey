import Foundation

/// Where the app is in the Sparkle update cycle. The status item renders this; `SparkleUpdateController`
/// produces it.
public enum DonkeyUpdateStatus: String, Equatable, Sendable {
    case notChecked
    case checking
    case upToDate
    case available
    case installing
    /// An update exists but the app bundle is not writable by this user, so the silent install
    /// would dead-end in an admin prompt this user cannot answer.
    case requiresAdmin
    case unavailable
    case failed
}

public struct DonkeyUpdateState: Equatable, Sendable {
    public var status: DonkeyUpdateStatus
    public var currentVersion: String
    public var latestVersion: String?
    public var message: String?

    public init(
        status: DonkeyUpdateStatus = .notChecked,
        currentVersion: String,
        latestVersion: String? = nil,
        message: String? = nil
    ) {
        self.status = status
        self.currentVersion = currentVersion
        self.latestVersion = latestVersion
        self.message = message
    }

    public var isActionable: Bool {
        status == .available
    }
}
