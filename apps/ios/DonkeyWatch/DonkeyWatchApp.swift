import SwiftUI

/// The watch is a remote for the phone's camera: a record button, a red
/// clock while a take runs, and the picture so the shot can be framed from
/// across the room.
@main
struct DonkeyWatchApp: App {
    @State private var link = WatchCameraLink()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchCameraView(link: link)
        }
        // Frames flow only while the watch is looking.
        .onChange(of: scenePhase, initial: true) { _, phase in
            link.setWatching(phase == .active)
        }
    }
}
