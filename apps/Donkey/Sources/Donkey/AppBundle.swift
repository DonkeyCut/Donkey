import DonkeyRuntime
import Foundation

extension Bundle {
    /// The bundle holding the app target's string catalog, for `String(localized:bundle:)`.
    /// The packaged app finds it under Contents/Resources; `swift test` falls back to the
    /// generated accessor, which is safe there because the bundle sits beside the test runner.
    static let donkeyApp: Bundle = DonkeyResourceBundle.app ?? .module
}
