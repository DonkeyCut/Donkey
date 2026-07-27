import Foundation

/// Locates a SwiftPM-generated resource bundle (`<Package>_<Target>.bundle`) inside a packaged,
/// code-signed macOS app.
///
/// The compiler-generated `Bundle.module` accessor only looks for the bundle at
/// `Bundle.main.bundleURL` — the `.app` root — and `fatalError`s when it is absent. A signed,
/// notarized app may not keep loose content at the bundle root (codesign rejects it as "unsealed
/// contents present in the bundle root"), so packaging stages these bundles under
/// `Contents/Resources`. Reaching for `Bundle.module` in the shipped app therefore traps on first
/// access. This resolver searches the signing-valid locations instead and returns nil rather than
/// crashing when a bundle is genuinely missing.
public enum DonkeyResourceBundle {
    /// The bundle named `name` (with or without the `.bundle` suffix), or nil if it cannot be found.
    /// Searches `Contents/Resources` first (the packaged app) and then the executable's own
    /// directory (the `swift build` / `swift run` layout), which together cover release and dev.
    public static func named(_ name: String) -> Bundle? {
        let fileName = name.hasSuffix(".bundle") ? name : name + ".bundle"
        let searchRoots = [Bundle.main.resourceURL, Bundle.main.bundleURL].compactMap { $0 }
        for root in searchRoots {
            if let bundle = Bundle(url: root.appendingPathComponent(fileName)) {
                return bundle
            }
        }
        return nil
    }

    /// The DonkeyRuntime target's own resource bundle (the local-app finder profiles and the
    /// BuiltInSkills tree).
    ///
    /// Falls back to the SwiftPM-generated `Bundle.module` for the `swift test` / `swift run` layout,
    /// where `Bundle.main` is the toolchain's test runner and `named` can't find the bundle. The fallback
    /// is safe: `Bundle.module` is the accessor that `fatalError`s in a packaged signed app, but there
    /// `named` resolves first and `??` short-circuits, so it is only ever reached under test/dev where the
    /// bundle genuinely exists.
    public static let runtime: Bundle? = named("Donkey_DonkeyRuntime") ?? Bundle.module

    /// The Donkey executable target's resource bundle (the menu bar icon).
    public static let app = named("Donkey_Donkey")
}
