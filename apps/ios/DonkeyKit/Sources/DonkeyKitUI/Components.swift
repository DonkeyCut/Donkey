#if os(iOS)
import SwiftUI
import DonkeyKitModels

/// The tab screens' title row: large title on the left, a control on the
/// same line. The trailing slot holds the profile menu until a screen puts
/// its own control there.
struct ScreenHeader<Trailing: View>: View {
    let title: String
    @Bindable var app: AppModel
    var auth: AuthModel
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack {
            Text(title)
                .font(.largeTitle.weight(.bold))
                .lineLimit(1)
            Spacer()
            trailing
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .frame(minHeight: 42)
    }
}

extension ScreenHeader where Trailing == AvatarMenu {
    init(title: String, app: AppModel, auth: AuthModel) {
        self.init(title: title, app: app, auth: auth) {
            AvatarMenu(app: app, auth: auth)
        }
    }
}

struct AvatarMenu: View {
    @Bindable var app: AppModel
    var auth: AuthModel

    var body: some View {
        Menu {
            Picker(selection: $app.appearance) {
                Text("System").tag(AppearancePreference.system)
                Text("Light").tag(AppearancePreference.light)
                Text("Dark").tag(AppearancePreference.dark)
            } label: {
                Label("Appearance", systemImage: "circle.lefthalf.filled")
            }
            .pickerStyle(.menu)
            if auth.user?.superUser == true {
                Button("Analytics", systemImage: "chart.xyaxis.line") {
                    app.showsAnalytics = true
                }
            }
            Divider()
            Button("Log Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                Task { await auth.signOut() }
            }
            .tint(.red)
        } label: {
            avatar
                .frame(width: 34, height: 34)
                .clipShape(Circle())
        }
        .accessibilityLabel("Profile")
    }

    /// The account's profile photo when the provider supplied one, with the
    /// initial monogram standing in while it loads or when there is none.
    @ViewBuilder
    private var avatar: some View {
        if let url = auth.user?.imageURL {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                monogram
            }
        } else {
            monogram
        }
    }

    private var monogram: some View {
        Circle()
            .fill(LinearGradient(
                colors: [Color(hex: "#7b8cff"), Color(hex: "#d86bd1")],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ))
            .overlay {
                Text(auth.user?.initial ?? "?")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
            }
    }
}

/// A grid cell of fixed aspect ratio. Artwork rides in an overlay, so a
/// landscape frame filling a portrait cell is cropped at the cell's edge; the
/// cell keeps the size the grid gave it and rows stay aligned.
struct MediaTile<Content: View>: View {
    var ratio: CGFloat
    var corner: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        Color.clear
            .aspectRatio(ratio, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .background(.fill.secondary)
            .overlay { content }
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
    }
}

struct EmptyState: View {
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.title2.weight(.bold))
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    .padding(.top, 14)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 320)
        .padding(.horizontal, 36)
    }
}

struct ToastOverlay: View {
    @Bindable var app: AppModel

    var body: some View {
        VStack {
            Spacer()
            if let toast = app.toast {
                Text(toast)
                    .font(.footnote.weight(.bold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .glassEffect()
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: toast) {
                        try? await Task.sleep(for: .seconds(1.8))
                        app.toast = nil
                    }
            }
        }
        .animation(.snappy, value: app.toast)
        .allowsHitTesting(false)
    }
}
#endif
