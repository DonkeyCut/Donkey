import Foundation

nonisolated public struct UserProfile: Equatable, Codable, Sendable {
    public var id: String
    public var name: String
    public var email: String
    /// Accounts with the operator role; gates the analytics dashboard.
    public var superUser: Bool
    /// The provider's profile photo (Google's picture claim); nil for Apple
    /// accounts and pre-photo caches.
    public var imageURL: URL?

    public init(id: String, name: String, email: String, superUser: Bool = false, imageURL: URL? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.superUser = superUser
        self.imageURL = imageURL
    }

    /// Profiles cached before the role and photo fields existed decode with
    /// them off.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        email = try container.decode(String.self, forKey: .email)
        superUser = try container.decodeIfPresent(Bool.self, forKey: .superUser) ?? false
        imageURL = try container.decodeIfPresent(URL.self, forKey: .imageURL)
    }

    public var initial: String {
        let source = name.isEmpty ? email : name
        return source.first.map { String($0).uppercased() } ?? "?"
    }
}

nonisolated public enum AuthProvider: String, Sendable {
    case google, apple
}

/// What this device holds before anything is asked of the network.
nonisolated public enum StoredSession: Equatable, Sendable {
    /// Nothing stored: this is a sign-in.
    case none
    /// A session, with the profile it was last seen wearing.
    case cached(UserProfile)
    /// A session whose profile this device has never read — the first launch
    /// after a sign-in that could not write its cache.
    case unknown
}

/// What the server said about the stored session.
nonisolated public enum SessionCheck: Equatable, Sendable {
    case valid(UserProfile)
    /// The backend rejected it: signed out for real.
    case rejected
    /// The server could not be reached, so whatever is cached still stands.
    case unreachable
}

/// Native sign-in and session exchange, implemented by the app target's
/// AuthController against the Donkey Cut backend.
public protocol AuthServicing: AnyObject {
    /// Runs the provider's native sign-in flow, exchanges the identity token
    /// for a backend session, and returns the signed-in user.
    func signIn(with provider: AuthProvider) async throws -> UserProfile
    /// The session on this device, read from local storage with nothing on
    /// the network in the way. Called while the first frame is being built.
    func storedSession() -> StoredSession
    /// Put the stored session to the server and take its answer.
    func checkSession() async -> SessionCheck
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
    public private(set) var state: AuthState
    public private(set) var lastError: String?

    private let service: any AuthServicing

    /// The app opens on the session this device already holds, so a returning
    /// user is looking at their own screens in the first frame and someone
    /// signing in is looking at the sign-in buttons. Only a session whose
    /// profile was never cached has to wait, and only that one shows the gate.
    public init(service: any AuthServicing) {
        self.service = service
        state = switch service.storedSession() {
        case .cached(let profile): .signedIn(profile)
        case .unknown: .restoring
        case .none: .signedOut
        }
    }

    public var user: UserProfile? {
        if case .signedIn(let profile) = state { return profile }
        return nil
    }

    public var isSignedIn: Bool { user != nil }

    /// Check the session the app opened on. A rejection signs out; a server
    /// that cannot be reached leaves a cached session standing, because
    /// recording and viewing are local.
    public func restore() async {
        guard state != .signedOut else { return }
        switch await service.checkSession() {
        case .valid(let profile): state = .signedIn(profile)
        case .rejected: state = .signedOut
        case .unreachable: if !isSignedIn { state = .signedOut }
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
