import AuthenticationServices
import DonkeyKitModels
import Foundation
import GoogleSignIn
import UIKit

enum AuthBackend {
    static let baseURL = URL(string: "https://donkeycut.com")!
    /// The iOS Google OAuth client id, injected at build time from
    /// Config/Donkey.local.xcconfig through Info.plist so the open-source
    /// tree carries no deployment ids. Empty when unconfigured.
    static var googleClientID: String {
        Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String ?? ""
    }
}

enum AuthError: LocalizedError {
    case googleNotConfigured
    case missingIdentityToken
    case noPresenter
    case server(String)

    var errorDescription: String? {
        switch self {
        case .googleNotConfigured:
            "Google sign-in isn't configured in this build yet."
        case .missingIdentityToken:
            "The sign-in didn't return an identity token."
        case .noPresenter:
            "No window to present sign-in from."
        case .server(let message):
            message
        }
    }
}

/// Runs the native provider flows and exchanges their ID tokens for a Donkey
/// Cut session (better-auth with the bearer plugin). The session token and
/// profile live in the keychain.
final class AuthController: NSObject, AuthServicing {
    /// Shared with CutCloudClient, which reads the same session token.
    static let tokenKey = "session-token"
    private static let profileKey = "session-profile"

    private var appleContinuation: CheckedContinuation<(token: String, nonce: String), any Error>?
    private var appleNonce = ""

    // MARK: AuthServicing

    func signIn(with provider: AuthProvider) async throws -> UserProfile {
        let credential: (token: String, nonce: String?)
        switch provider {
        case .google:
            credential = (try await googleIdToken(), nil)
        case .apple:
            let apple = try await appleIdToken()
            credential = (apple.token, apple.nonce)
        }
        let token = try await exchange(provider: provider, idToken: credential.token, nonce: credential.nonce)
        let profile = try await fetchProfile(token: token)
        KeychainStore.save(Data(token.utf8), for: Self.tokenKey)
        if let data = try? JSONEncoder().encode(profile) {
            KeychainStore.save(data, for: Self.profileKey)
        }
        return profile
    }

    func restoreSession() async -> UserProfile? {
        guard let tokenData = KeychainStore.read(Self.tokenKey),
              let token = String(data: tokenData, encoding: .utf8) else { return nil }
        let cached = KeychainStore.read(Self.profileKey)
            .flatMap { try? JSONDecoder().decode(UserProfile.self, from: $0) }
        do {
            let profile = try await fetchProfile(token: token)
            if let data = try? JSONEncoder().encode(profile) {
                KeychainStore.save(data, for: Self.profileKey)
            }
            return profile
        } catch AuthError.server {
            // The backend rejected the session: signed out for real.
            KeychainStore.delete(Self.tokenKey)
            KeychainStore.delete(Self.profileKey)
            return nil
        } catch {
            // Offline: recording and viewing are local, so the cached
            // profile keeps the app usable.
            return cached
        }
    }

    func signOut() async {
        if let tokenData = KeychainStore.read(Self.tokenKey),
           let token = String(data: tokenData, encoding: .utf8) {
            var request = URLRequest(url: AuthBackend.baseURL.appending(path: "/api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            _ = try? await URLSession.shared.data(for: request)
        }
        GIDSignIn.sharedInstance.signOut()
        KeychainStore.delete(Self.tokenKey)
        KeychainStore.delete(Self.profileKey)
    }

    // MARK: Backend exchange

    private func exchange(provider: AuthProvider, idToken: String, nonce: String?) async throws -> String {
        var request = URLRequest(url: AuthBackend.baseURL.appending(path: "/api/auth/sign-in/social"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var idTokenBody: [String: Any] = ["token": idToken]
        if let nonce { idTokenBody["nonce"] = nonce }
        let body: [String: Any] = [
            "provider": provider.rawValue,
            "idToken": idTokenBody,
            "disableRedirect": true,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw AuthError.server(Self.serverMessage(from: data, status: http.statusCode))
        }
        guard let token = http.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty else {
            throw AuthError.server("Sign-in succeeded but no session token was returned.")
        }
        return token
    }

    private func fetchProfile(token: String) async throws -> UserProfile {
        async let superUser = fetchSuperUser(token: token)
        var request = URLRequest(url: AuthBackend.baseURL.appending(path: "/api/auth/get-session"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw AuthError.server(Self.serverMessage(from: data, status: http.statusCode))
        }
        struct SessionResponse: Decodable {
            struct User: Decodable {
                var id: String
                var name: String?
                var email: String
                var image: String?
            }
            var user: User?
        }
        guard let user = try? JSONDecoder().decode(SessionResponse.self, from: data).user else {
            throw AuthError.server("Your session has expired. Sign in again.")
        }
        return UserProfile(
            id: user.id,
            name: user.name ?? "",
            email: user.email,
            superUser: await superUser,
            imageURL: user.image.flatMap(URL.init(string:))
        )
    }

    /// The session payload carries identity only; /api/account/me carries the
    /// super-user bit. Best-effort: a failed read means a regular account
    /// until the next restore.
    private func fetchSuperUser(token: String) async -> Bool {
        var request = URLRequest(url: AuthBackend.baseURL.appending(path: "/api/account/me"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else { return false }
        struct MeResponse: Decodable { var superUser: Bool? }
        return (try? JSONDecoder().decode(MeResponse.self, from: data))?.superUser == true
    }

    private static func serverMessage(from data: Data, status: Int) -> String {
        struct ErrorBody: Decodable { var message: String? }
        if let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.message {
            return message
        }
        return "Sign-in failed (\(status))."
    }

    // MARK: Google

    private func googleIdToken() async throws -> String {
        guard !AuthBackend.googleClientID.isEmpty, Self.hasGoogleCallbackScheme() else {
            throw AuthError.googleNotConfigured
        }
        guard let presenter = Self.presentingViewController() else {
            throw AuthError.noPresenter
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: AuthBackend.googleClientID)
        let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
        guard let token = result.user.idToken?.tokenString else {
            throw AuthError.missingIdentityToken
        }
        return token
    }

    /// The Google SDK raises an uncatchable exception when the app lacks the
    /// URL scheme it redirects back on (the client id with its dot-segments
    /// reversed), so verify the registration before starting the flow.
    private static func hasGoogleCallbackScheme() -> Bool {
        let reversed = AuthBackend.googleClientID
            .split(separator: ".").reversed().joined(separator: ".")
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        return types.contains { ($0["CFBundleURLSchemes"] as? [String] ?? []).contains(reversed) }
    }

    private static func presentingViewController() -> UIViewController? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
    }

    // MARK: Apple

    private func appleIdToken() async throws -> (token: String, nonce: String) {
        // The backend compares this string to the token's nonce claim, so the
        // request carries it verbatim.
        let nonce = Self.randomNonce()
        appleNonce = nonce
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce

        return try await withCheckedThrowingContinuation { continuation in
            appleContinuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

extension AuthController: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        defer { appleContinuation = nil }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            appleContinuation?.resume(throwing: AuthError.missingIdentityToken)
            return
        }
        appleContinuation?.resume(returning: (token, appleNonce))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        defer { appleContinuation = nil }
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            appleContinuation?.resume(throwing: CancellationError())
        } else {
            appleContinuation?.resume(throwing: error)
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let window = Self.presentingViewController()?.view.window {
            return window
        }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            preconditionFailure("Sign-in requires a window scene")
        }
        return scene.keyWindow ?? UIWindow(windowScene: scene)
    }
}
