import Foundation
import Testing

/// The release app is signed with the hardened runtime, which blocks microphone access outright —
/// no prompt, no System Settings entry — unless the signature carries the audio-input entitlement.
/// The screen recorder records the microphone, so the entitlements file packaging signs with has to
/// grant it.
@Suite
struct AppEntitlementsTests {
    @Test
    func theAppMayRecordTheMicrophone() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DonkeyRuntimeTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // Donkey
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // <repo root>
        let file = repoRoot.appendingPathComponent("scripts/assets/donkey.entitlements")
        let data = try Data(contentsOf: file)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        let entitlements = try #require(plist as? [String: Any])
        #expect(entitlements["com.apple.security.device.audio-input"] as? Bool == true)
    }
}
