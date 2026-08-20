#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct LoggedOutView: View {
    var auth: AuthModel

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 8) {
            BacklitDonkeyMark(width: 108)
                .padding(.bottom, 26)

            Text("Send Donkey back to work.")
                .font(.title2.weight(.bold))
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

            Text("By continuing, you agree to the **[Terms of Use](https://donkeycut.com/terms)** and **[Privacy Policy](https://donkeycut.com/privacy)**.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .tint(.primary)
                .multilineTextAlignment(.center)
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

/// The donkey mark. In dark mode it gets the backlit treatment from
/// docs/guides/backlit-icon.md: three white silhouette sources behind the
/// mark, each drawn as a tight halo and a wide bloom, every length a
/// multiple of the rendered width. Light mode shows the mark at its own fills.
struct BacklitDonkeyMark: View {
    let width: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    private static let sources: [(dx: CGFloat, dy: CGFloat, halo: Double, bloom: Double)] = [
        (-0.0297, 0.0043, 0.80, 0.192),
        (-0.0095, -0.0285, 0.62, 0.149),
        (0.0190, 0.0232, 0.35, 0.084),
    ]

    var body: some View {
        ZStack {
            if colorScheme == .dark {
                glow(blurFactor: 0.088, wide: true)
                glow(blurFactor: 0.030, wide: false)
            }
            Image("DonkeyMark", bundle: .main)
                .resizable()
                .scaledToFit()
        }
        // The mark's artwork is 264 x 318.
        .frame(width: width, height: width * 318 / 264)
    }

    private func glow(blurFactor: CGFloat, wide: Bool) -> some View {
        ForEach(Array(Self.sources.enumerated()), id: \.offset) { _, source in
            Image("DonkeySilhouette", bundle: .main)
                .resizable()
                .scaledToFit()
                .blur(radius: width * blurFactor)
                .opacity(wide ? source.bloom : source.halo)
                .offset(x: width * source.dx, y: width * source.dy)
        }
    }
}
#endif
