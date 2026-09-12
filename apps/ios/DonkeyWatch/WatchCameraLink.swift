import DonkeyKitModels
import UIKit
import WatchConnectivity
import WatchKit

/// The watch end of the camera remote: the phone's camera state, the latest
/// preview frame, and the commands the screen sends back.
@Observable
final class WatchCameraLink: NSObject, WCSessionDelegate {
    private(set) var state = CameraRemoteState()
    private(set) var frame: UIImage?
    private(set) var isPhoneReachable = false
    /// When the take began, on this watch's clock. Set once when a take
    /// starts so the timer never jumps as later state messages land.
    private(set) var recordingStartedAt: Date?

    private let session = WCSession.default
    private var isWatching = false

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    func toggleRecording() {
        guard session.isReachable else { return }
        session.sendMessage(CameraRemoteMessage.encode(.toggleRecording), replyHandler: nil)
    }

    /// Whether the screen is up. On, the phone is asked for its state and
    /// starts sending frames; off, the frames stop.
    func setWatching(_ watching: Bool) {
        isWatching = watching
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(CameraRemoteMessage.encode(.preview(watching)), replyHandler: nil)
        if watching {
            session.sendMessage(CameraRemoteMessage.encode(.hello)) { [weak self] reply in
                guard let state = CameraRemoteMessage.state(in: reply) else { return }
                Task { @MainActor in self?.apply(state) }
            }
        }
    }

    private func apply(_ state: CameraRemoteState) {
        self.state = state
        switch (recordingStartedAt, state.recordingElapsed) {
        case (nil, let elapsed?):
            recordingStartedAt = .now.addingTimeInterval(-elapsed)
            WKInterfaceDevice.current().play(.start)
        case (.some, nil):
            recordingStartedAt = nil
            WKInterfaceDevice.current().play(.stop)
        default:
            break
        }
        if !state.isCameraOpen {
            frame = nil
        }
    }

    // MARK: WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        let reachable = session.isReachable
        Task { @MainActor in
            isPhoneReachable = reachable
            setWatching(isWatching)
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            isPhoneReachable = reachable
            if reachable {
                setWatching(isWatching)
            } else {
                apply(CameraRemoteState())
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let state = CameraRemoteMessage.state(in: message) else { return }
        Task { @MainActor in apply(state) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        // The reply is the phone's cue to send the next frame.
        replyHandler(Data())
        guard let image = UIImage(data: messageData) else { return }
        Task { @MainActor in frame = image }
    }
}
