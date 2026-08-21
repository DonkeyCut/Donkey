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

    /// A transient confirmation message ("Note saved"), cleared by the UI.
    public var toast: String?

    /// The super-user analytics dashboard, opened from the avatar menu.
    public var showsAnalytics = false

    private let defaults: UserDefaults
    private static let appearanceKey = "appearancePreference"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        appearance = defaults.string(forKey: Self.appearanceKey)
            .flatMap(AppearancePreference.init(rawValue:)) ?? .system
    }

    public func show(toast message: String) {
        toast = message
    }
}
