#if os(iOS)
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
        @ViewBuilder cameraPreview: @escaping () -> CameraPreview
    ) {
        self.app = app
        self.ideas = ideas
        self.camera = camera
        self.media = media
        self.projects = projects
        self.auth = auth
        self.analytics = analytics
        self.cameraPreview = cameraPreview
    }

    public var body: some View {
        ZStack {
            TabView(selection: $app.selectedTab) {
                Tab("Ideas", systemImage: "lightbulb", value: .ideas) {
                    IdeasScreen(app: app, ideas: ideas, auth: auth, onRecordNote: recordNote)
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
        .task { await auth.restore() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, auth.isSignedIn {
                media.sync?.kick()
            }
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            guard signedIn else {
                app.showsAnalytics = false
                return
            }
            media.sync?.kick()
            Task { await projects.refresh() }
        }
        .onChange(of: cameraShouldRun) { _, run in
            if run {
                camera.appeared()
            } else {
                camera.disappeared()
            }
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
