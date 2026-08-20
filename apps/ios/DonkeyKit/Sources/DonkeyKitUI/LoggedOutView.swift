#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct LoggedOutView: View {
    var auth: AuthModel

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 24)
                .fill(LinearGradient(
                    colors: [Color(hex: "#ff8a3d"), Color.recordPink],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 84, height: 84)
                .overlay {
                    Image(systemName: "record.circle")
                        .font(.system(size: 40, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .shadow(color: Color.recordPink.opacity(0.35), radius: 20, y: 14)
                .padding(.bottom, 18)

            Text("Turn ideas into videos")
                .font(.title2.weight(.bold))
            Text("Write a note, load it into the teleprompter, and record. Everything lives in one place.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 12) {
                signInButton(provider: .google) {
                    HStack(spacing: 11) {
                        Image("GoogleG", bundle: .main)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 20, height: 20)
                        Text("Log in with Google")
                    }
                }
                .foregroundStyle(colorScheme == .dark ? .black : .primary)
                .background(.white, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.quaternary))

                signInButton(provider: .apple) {
                    HStack(spacing: 11) {
                        Image(systemName: "apple.logo")
                        Text("Log in with Apple")
                    }
                }
                .foregroundStyle(colorScheme == .dark ? Color.black : .white)
                .background(colorScheme == .dark ? Color.white : .black, in: RoundedRectangle(cornerRadius: 16))
            }
            .frame(maxWidth: 300)
            .padding(.top, 24)

            if let error = auth.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
            }

            Text("By continuing you agree to the Terms and Privacy Policy.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.top, 18)
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .overlay {
            if case .restoring = auth.state {
                ZStack {
                    Color(.systemBackground)
                    ProgressView()
                }
                .ignoresSafeArea()
            }
        }
    }

    private func signInButton(provider: AuthProvider, @ViewBuilder label: () -> some View) -> some View {
        Button {
            Task { await auth.signIn(with: provider) }
        } label: {
            ZStack {
                label().opacity(isSigningIn(provider) ? 0 : 1)
                if isSigningIn(provider) {
                    ProgressView()
                }
            }
            .font(.body.weight(.bold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .disabled(auth.state != .signedOut)
    }

    private func isSigningIn(_ provider: AuthProvider) -> Bool {
        auth.state == .signingIn(provider)
    }
}
#endif
