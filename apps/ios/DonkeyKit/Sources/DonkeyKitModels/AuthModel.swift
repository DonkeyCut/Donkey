import Foundation

nonisolated public struct UserProfile: Equatable, Codable, Sendable {
    public var id: String
    public var name: String
    public var email: String
    /// Accounts with the operator role; gates the analytics dashboard.
    public var superUser: Bool

    public init(id: String, name: String, email: String, superUser: Bool = false) {
        self.id = id
        self.name = name
        self.email = email
        self.superUser = superUser
    }

    /// Profiles cached before the role field existed decode with it off.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        email = try container.decode(String.self, forKey: .email)
        superUser = try container.decodeIfPresent(Bool.self, forKey: .superUser) ?? false
    }

    public var initial: String {
        let source = name.isEmpty ? email : name
        return source.first.map { String($0).uppercased() } ?? "?"
    }
}

nonisolated public enum AuthProvider: String, Sendable {
    case google, apple
}

/// Native sign-in and session exchange, implemented by the app target's
/// AuthController against the Donkey Cut backend.
public protocol AuthServicing: AnyObject {
    /// Runs the provider's native sign-in flow, exchanges the identity token
    /// for a backend session, and returns the signed-in user.
    func signIn(with provider: AuthProvider) async throws -> UserProfile
    /// The user restored from the stored session, if one exists.
    func restoreSession() async -> UserProfile?
    func signOut() async
}

nonisolated public enum AuthState: Equatable, Sendable {
    case restoring
    case signedOut
    case signingIn(AuthProvider)
    case signedIn(UserProfile)
}

@Observable
public final class AuthModel {
    public private(set) var state: AuthState = .restoring
    public private(set) var lastError: String?

    private let service: any AuthServicing

    public init(service: any AuthServicing) {
        self.service = service
    }

    public var user: UserProfile? {
        if case .signedIn(let profile) = state { return profile }
        return nil
    }

    public var isSignedIn: Bool { user != nil }

    public func restore() async {
        if let profile = await service.restoreSession() {
            state = .signedIn(profile)
        } else {
            state = .signedOut
        }
    }

    public func signIn(with provider: AuthProvider) async {
        guard case .signedOut = state else { return }
        state = .signingIn(provider)
        lastError = nil
        do {
            let profile = try await service.signIn(with: provider)
            state = .signedIn(profile)
        } catch is CancellationError {
            state = .signedOut
        } catch {
            lastError = error.localizedDescription
            state = .signedOut
        }
    }

    public func signOut() async {
        await service.signOut()
        state = .signedOut
    }
}
