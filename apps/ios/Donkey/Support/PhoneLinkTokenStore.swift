import DonkeyKitModels
import Foundation

/// The Mac-link pairing, in the keychain beside the session token. The token is
/// what lets this phone put video on someone's Mac, so it is kept where the
/// account's own credentials are kept.
final class PhoneLinkTokenStore: PhoneLinkTokenStoring, @unchecked Sendable {
    private static let key = "phoneLinkPairing"

    func readPairing() -> PhoneLinkPairing? {
        guard let data = KeychainStore.read(Self.key) else { return nil }
        return try? JSONDecoder().decode(PhoneLinkPairing.self, from: data)
    }

    func writePairing(_ pairing: PhoneLinkPairing?) {
        guard let pairing, let data = try? JSONEncoder().encode(pairing) else {
            KeychainStore.delete(Self.key)
            return
        }
        KeychainStore.save(data, for: Self.key)
    }
}
