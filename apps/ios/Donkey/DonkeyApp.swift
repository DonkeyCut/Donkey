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
                auth: wiring.auth
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
    let cameraController: CameraController

    init() {
        // A store that cannot open is a programmer error worth crashing on.
        let store = try! DonkeyStore()
        app = AppModel()
        ideas = IdeasModel(store: store)
        camera = CameraModel()
        media = MediaModel(store: store)
        projects = ProjectsModel()
        auth = AuthModel(service: AuthController())
        cameraController = CameraController()

        cameraController.model = camera
        camera.controller = cameraController
        cameraController.onRecordingFinished = { [media] url, duration, thumbnail in
            media.ingest(movieAt: url, duration: duration, thumbnail: thumbnail)
        }
    }
}
