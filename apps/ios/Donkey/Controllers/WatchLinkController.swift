import DonkeyKitModels
import Synchronization
import WatchConnectivity

/// The phone end of the watch app. It tells the watch what the camera is
/// doing, carries the watch's record button to the camera, and streams a
/// small picture while the watch is looking.
///
/// The camera runs only while its tab is on screen, so a record command that
/// arrives on another tab switches to the camera first and starts the take
/// once it is running.
final class WatchLinkController: NSObject, WCSessionDelegate {
    private let app: AppModel
    private let camera: CameraModel
    private let cameraController: CameraController
    private let session = WCSession.default
    /// A record command waiting on the camera to come up, and when it lapses:
    /// a take nobody is expecting any more must never start on its own.
    private var pendingRecordUntil: Date?
    /// Frames on the wire the watch has not acknowledged. Two ride at once
    /// so the link stays busy, and a slow link drops frames at the source.
    private nonisolated let framesInFlight = Mutex(0)

    init(app: AppModel, camera: CameraModel, cameraController: CameraController) {
        self.app = app
        self.camera = camera
        self.cameraController = cameraController
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
        observeCamera()
    }

    private func observeCamera() {
        withObservationTracking {
            _ = camera.recordingStartedAt
            _ = camera.availability
            _ = camera.facing
        } onChange: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                cameraDidChange()
                observeCamera()
            }
        }
    }

    private var state: CameraRemoteState {
        CameraRemoteState(
            isCameraOpen: camera.availability == .running,
            facing: camera.facing,
            recordingElapsed: camera.recordingStartedAt.map { Date.now.timeIntervalSince($0) }
        )
    }

    private func cameraDidChange() {
        if let pendingRecordUntil, camera.availability == .running {
            self.pendingRecordUntil = nil
            if pendingRecordUntil > .now, !camera.isRecording {
                camera.toggleRecording()
            }
        }
        publishState()
    }

    private func publishState() {
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(CameraRemoteMessage.encode(state), replyHandler: nil)
    }

    private func handle(_ command: CameraRemoteCommand) {
        switch command {
        case .hello:
            break
        case .toggleRecording:
            if camera.availability == .running {
                camera.toggleRecording()
            } else {
                pendingRecordUntil = .now.addingTimeInterval(5)
                app.selectedTab = .camera
            }
        case .preview(let wanted):
            setPreview(wanted)
        }
    }

    private func setPreview(_ wanted: Bool) {
        guard wanted else {
            cameraController.setPreviewSink(nil)
            return
        }
        cameraController.setPreviewSink { [weak self] data in self?.send(frame: data) }
    }

    private nonisolated func send(frame: Data) {
        let session = WCSession.default
        guard session.isReachable else { return }
        let claimed = framesInFlight.withLock { count in
            guard count < 2 else { return false }
            count += 1
            return true
        }
        guard claimed else { return }
        let release: @Sendable () -> Void = { [weak self] in
            self?.framesInFlight.withLock { $0 -= 1 }
        }
        session.sendMessageData(frame, replyHandler: { _ in release() }, errorHandler: { _ in release() })
    }

    // MARK: WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        Task { @MainActor in publishState() }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            if reachable {
                publishState()
            } else {
                setPreview(false)
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let command = CameraRemoteMessage.command(in: message) else { return }
        Task { @MainActor in handle(command) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let command = CameraRemoteMessage.command(in: message) else {
            replyHandler([:])
            return
        }
        // The reply is called once, from the main actor; WatchConnectivity
        // takes it on any thread.
        nonisolated(unsafe) let reply = replyHandler
        Task { @MainActor in
            handle(command)
            reply(CameraRemoteMessage.encode(state))
        }
    }
}
