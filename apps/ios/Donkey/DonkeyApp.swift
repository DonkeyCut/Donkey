import DonkeyKitModels
import DonkeyKitUI
import GoogleSignIn
import SwiftUI

@main
struct DonkeyApp: App {
    @State private var wiring = AppWiring()

    var body: some Scene {
        WindowGroup {
            RootView(
                app: wiring.app,
                ideas: wiring.ideas,
                camera: wiring.camera,
                media: wiring.media,
                projects: wiring.projects,
                auth: wiring.auth,
                analytics: wiring.analytics
            ) {
                CameraPreviewView(host: wiring.cameraController.previewView) {
                    wiring.camera.toggleRecording()
                }
            }
            .onOpenURL { _ = GIDSignIn.sharedInstance.handle($0) }
        }
    }
}

/// Builds the models and controllers once and wires controller events back
/// into model state. App entry stays this thin per docs/guides/swift.md.
@Observable
final class AppWiring {
    let app: AppModel
    let ideas: IdeasModel
    let camera: CameraModel
    let media: MediaModel
    let projects: ProjectsModel
    let auth: AuthModel
    let analytics: AnalyticsModel
    let cameraController: CameraController
    let sync: SyncEngine
    private let networkMonitor: NetworkMonitor

    init() {
        // A store that cannot open is a programmer error worth crashing on.
        let store = try! DonkeyStore()
        let cloud = CutCloudClient()
        let app = AppModel()
        let ideas = IdeasModel(store: store)
        let media = MediaModel(store: store)
        let auth = AuthModel(service: AuthController())
        let sync = SyncEngine(
            journal: store,
            service: cloud,
            signedIn: { auth.isSignedIn },
            uploadFor: { recording in
                await CutCloudClient.uploadPayload(for: recording, media: media)
            }
        )
        sync.media = media
        sync.ideas = ideas
        media.sync = sync
        ideas.onLocalChange = { sync.kick() }
        ideas.cloud = cloud

        self.app = app
        self.ideas = ideas
        self.media = media
        self.auth = auth
        self.sync = sync
        camera = CameraModel()
        analytics = AnalyticsModel(service: cloud)
        projects = ProjectsModel(service: cloud)
        cameraController = CameraController()
        networkMonitor = NetworkMonitor { sync.network = $0 }

        cameraController.model = camera
        camera.controller = cameraController
        cameraController.onRecordingFinished = { [media] url, duration, thumbnail in
            media.ingest(movieAt: url, duration: duration, thumbnail: thumbnail)
        }
    }
}
