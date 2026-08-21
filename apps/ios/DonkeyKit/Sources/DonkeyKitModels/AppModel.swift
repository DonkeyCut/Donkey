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

    /// Media syncs over cellular data too. Off by default: large files wait
    /// for Wi-Fi until the user opts in. Small traffic (notes, links) always
    /// moves.
    public var syncOverCellular: Bool {
        didSet {
            defaults.set(syncOverCellular, forKey: Self.cellularKey)
            if syncOverCellular != oldValue { onSyncPolicyChange?() }
        }
    }

    /// Fires when the cellular choice flips so queued uploads re-evaluate.
    /// Wired by the app entry.
    public var onSyncPolicyChange: (() -> Void)?

    /// A transient confirmation message ("Note saved"), cleared by the UI.
    public var toast: String?

    /// The super-user analytics dashboard, opened from the avatar menu.
    public var showsAnalytics = false

    private let defaults: UserDefaults
    private static let appearanceKey = "appearancePreference"
    private static let cellularKey = "syncOverCellular"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        appearance = defaults.string(forKey: Self.appearanceKey)
            .flatMap(AppearancePreference.init(rawValue:)) ?? .system
        syncOverCellular = defaults.bool(forKey: Self.cellularKey)
    }

    public func show(toast message: String) {
        toast = message
    }
}
