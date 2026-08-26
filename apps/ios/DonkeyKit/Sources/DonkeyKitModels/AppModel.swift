import Foundation

nonisolated public enum AppTab: Hashable, Sendable {
    case ideas, media, projects, camera
}

nonisolated public enum AppearancePreference: String, CaseIterable, Sendable {
    case system, light, dark
}

@Observable
public final class AppModel {
    public var selectedTab: AppTab = .ideas

    public var appearance: AppearancePreference {
        didSet { defaults.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// Videos ride Wi-Fi only. Notes, folders, deletes and saved links are
    /// small enough to spend cellular data on; a recording is not, so it waits
    /// for Wi-Fi while this holds. The sync engine reads it as policy.
    ///
    /// The switch lives on the app's own page in iOS Settings, which writes
    /// this key; `refreshFromDefaults()` is how the app picks up what it says.
    public var mediaOnWiFiOnly: Bool {
        didSet { defaults.set(mediaOnWiFiOnly, forKey: Self.mediaOnWiFiOnlyKey) }
    }

    /// A transient confirmation message ("Note saved"), cleared by the UI.
    public var toast: String?

    /// The super-user analytics dashboard, opened from the avatar menu.
    public var showsAnalytics = false

    private let defaults: UserDefaults
    private static let appearanceKey = "appearancePreference"
    private static let mediaOnWiFiOnlyKey = "mediaOnWiFiOnly"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        appearance = defaults.string(forKey: Self.appearanceKey)
            .flatMap(AppearancePreference.init(rawValue:)) ?? .system
        mediaOnWiFiOnly = defaults.object(forKey: Self.mediaOnWiFiOnlyKey) as? Bool ?? true
    }

    /// Take whatever the defaults hold now. The Settings app writes them
    /// while this app is away, so the shell calls this as it comes forward.
    /// Assigning only on a real change keeps the write-back from looping.
    public func refreshFromDefaults() {
        let stored = defaults.object(forKey: Self.mediaOnWiFiOnlyKey) as? Bool ?? true
        if stored != mediaOnWiFiOnly { mediaOnWiFiOnly = stored }
    }

    public func show(toast message: String) {
        toast = message
    }
}
