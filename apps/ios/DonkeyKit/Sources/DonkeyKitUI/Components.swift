#if os(iOS)
import SwiftUI
import DonkeyKitModels

/// The tab screens' title row: large title on the left, the profile avatar
/// on the same line.
struct ScreenHeader: View {
    let title: String
    @Bindable var app: AppModel
    var auth: AuthModel

    var body: some View {
        HStack {
            Text(title)
                .font(.largeTitle.weight(.bold))
            Spacer()
            AvatarMenu(app: app, auth: auth)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }
}

struct AvatarMenu: View {
    @Bindable var app: AppModel
    var auth: AuthModel

    var body: some View {
        Menu {
            if auth.user?.superUser == true {
                Button("Analytics", systemImage: "chart.xyaxis.line") {
                    app.showsAnalytics = true
                }
                Divider()
            }
            Picker("Appearance", selection: $app.appearance) {
                Text("System").tag(AppearancePreference.system)
                Text("Light").tag(AppearancePreference.light)
                Text("Dark").tag(AppearancePreference.dark)
            }
            .pickerStyle(.menu)
            Toggle("Sync over Cellular", systemImage: "antenna.radiowaves.left.and.right", isOn: $app.syncOverCellular)
            Divider()
            Button("Log Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                Task { await auth.signOut() }
            }
            .tint(.red)
        } label: {
            Circle()
                .fill(LinearGradient(
                    colors: [Color(hex: "#7b8cff"), Color(hex: "#d86bd1")],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 34, height: 34)
                .overlay {
                    Text(auth.user?.initial ?? "?")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.white)
                }
        }
        .accessibilityLabel("Profile")
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
