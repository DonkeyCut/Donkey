import Foundation

extension Bundle {
    /// The bundle holding DonkeyUI's string catalog, for `String(localized:bundle:)`.
    ///
    /// Packaging stages SwiftPM resource bundles under Contents/Resources, where the generated
    /// `Bundle.module` accessor does not look and traps. This searches there first, then beside the
    /// executable (`swift build`), and falls back to `.module` under `swift test`. DonkeyRuntime's
    /// `DonkeyResourceBundle` runs the same search; DonkeyUI keeps its own copy because it never
    /// imports DonkeyRuntime.
    static let donkeyUI: Bundle = {
        let fileName = "Donkey_DonkeyUI.bundle"
        let searchRoots = [Bundle.main.resourceURL, Bundle.main.bundleURL].compactMap { $0 }
        for root in searchRoots {
            if let bundle = Bundle(url: root.appendingPathComponent(fileName)) {
                return bundle
            }
        }
        return .module
    }()
}
