#if os(iOS)
import Combine
import SwiftUI
import DonkeyKitModels

/// The app shell: four tabs, the logged-out gate, and the toast layer.
/// The app target injects the camera preview so this package never touches
/// the capture session.
public struct RootView<CameraPreview: View>: View {
    @Bindable var app: AppModel
    var ideas: IdeasModel
    var camera: CameraModel
    var media: MediaModel
    var projects: ProjectsModel
    var auth: AuthModel
    var analytics: AnalyticsModel
    var link: PhoneLinkModel
    let cameraPreview: () -> CameraPreview

    @Environment(\.scenePhase) private var scenePhase

    public init(
        app: AppModel,
        ideas: IdeasModel,
        camera: CameraModel,
        media: MediaModel,
        projects: ProjectsModel,
        auth: AuthModel,
        analytics: AnalyticsModel,
        link: PhoneLinkModel,
        @ViewBuilder cameraPreview: @escaping () -> CameraPreview
    ) {
        self.app = app
        self.ideas = ideas
        self.camera = camera
        self.media = media
        self.projects = projects
        self.auth = auth
        self.analytics = analytics
        self.link = link
        self.cameraPreview = cameraPreview
    }

    public var body: some View {
        ZStack {
            TabView(selection: $app.selectedTab) {
                Tab("Ideas", systemImage: "lightbulb", value: .ideas) {
                    IdeasScreen(app: app, ideas: ideas, media: media, auth: auth, onRecordNote: recordNote)
                }
                Tab("Library", systemImage: "books.vertical", value: .media) {
                    MediaScreen(app: app, media: media, auth: auth)
                }
                Tab("Projects", systemImage: "play.rectangle", value: .projects) {
                    ProjectsScreen(app: app, projects: projects, auth: auth)
                }
                Tab("Camera", systemImage: "camera", value: .camera) {
                    CameraScreen(app: app, camera: camera, ideas: ideas, media: media, cameraPreview: cameraPreview)
                }
            }
            .tabViewStyle(.sidebarAdaptable)

            if !auth.isSignedIn {
                LoggedOutView(auth: auth)
                    .transition(.opacity)
            }

            ToastOverlay(app: app)
        }
        .tint(.accentBlue)
        .animation(.default, value: auth.isSignedIn)
        .preferredColorScheme(app.appearance.colorScheme)
        .fullScreenCover(isPresented: $app.showsAnalytics) {
            AnalyticsScreen(analytics: analytics)
                .tint(.accentBlue)
                .preferredColorScheme(app.appearance.colorScheme)
        }
        .sheet(isPresented: $app.showsMacLink) {
            MacLinkSheet(link: link, media: media) {
                if !cameraShouldRun { link.stopBrowsing() }
            }
            .tint(.accentBlue)
            .preferredColorScheme(app.appearance.colorScheme)
        }
        .task { await auth.restore() }
        // Notes and folders are written at the desk as well as here, so the
        // phone looks at the cloud on its own clock for as long as it is on
        // screen. Pull to refresh asks for the same pass at once.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await media.sync?.beat()
        }
        // Projects are edited at the desk, so the tab opens on the listing
        // this device already had and the cloud is read behind it — every
        // time the app comes forward, whichever tab is on screen.
        .task(id: scenePhase) {
            guard scenePhase == .active, auth.isSignedIn else { return }
            await projects.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            // The Wi-Fi switch is also on the app's page in iOS Settings,
            // where it may have been flipped while this app was away.
            app.refreshFromDefaults()
            if auth.isSignedIn { media.sync?.kick() }
        }
        // Both apps on screen at once — iPad Split View — so the switch lands
        // without waiting for a trip to the background.
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
            app.refreshFromDefaults()
        }
        // Letting media onto cellular is a change the queue acts on at once.
        .onChange(of: app.mediaOnWiFiOnly) { _, _ in
            media.sync?.kick()
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            guard signedIn else {
                app.showsAnalytics = false
                app.showsMacLink = false
                // The listing on disk belongs to the account that just left.
                projects.forget()
                return
            }
            media.sync?.kick()
            Task { await projects.refresh() }
        }
        .onChange(of: cameraShouldRun) { _, run in
            if run {
                camera.appeared()
                link.startBrowsing()
            } else {
                camera.disappeared()
                if !app.showsMacLink { link.stopBrowsing() }
            }
        }
        // A Mac coming into range mid-shoot is the moment the queue drains.
        .onChange(of: link.macs) { _, _ in
            Task { await link.drain(media) }
        }
    }

    private var cameraShouldRun: Bool {
        app.selectedTab == .camera && auth.isSignedIn && scenePhase == .active
    }

    private func recordNote(_ note: Note) {
        camera.loadTeleprompter(script: note.script)
        app.selectedTab = .camera
    }
}
#endif
