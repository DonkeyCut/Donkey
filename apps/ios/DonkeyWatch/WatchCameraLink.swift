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
    /// True once the phone has answered, so `state` is the phone's word.
    private(set) var hasState = false
    /// True once the phone has been out of reach for a couple of seconds.
    /// Reachability blinks off for an instant as the session comes up, and a
    /// hint on that blink would be wrong before anyone could read it.
    private(set) var isPhoneAway = false
    private var awayTask: Task<Void, Never>?
    /// When the take began, on this watch's clock. Set once when a take
    /// starts so the timer never jumps as later state messages land.
    private(set) var recordingStartedAt: Date?

    private let session = WCSession.default
    private var isWatching = false
    /// Crown turns gathered between sends, in points, so a spin is a few
    /// messages and the phone moves the script in one motion.
    private var pendingNudge: Double = 0
    private var nudgeFlush: Task<Void, Never>?
    /// Points of script per crown unit. The crown turns "up" to send the
    /// words up, the way a list scrolls under it.
    private static let pointsPerCrownUnit: Double = 6
    private static let nudgeSendInterval: Duration = .milliseconds(60)

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    /// The button is always live. With the phone out of reach the wrist gets
    /// a failure tap and the screen says what to open.
    func toggleRecording() {
        guard session.isReachable else {
            WKInterfaceDevice.current().play(.failure)
            return
        }
        session.sendMessage(CameraRemoteMessage.encode(.toggleRecording), replyHandler: nil)
    }

    /// A crown turn: `units` is the crown's own count, up for positive.
    func scrollScript(by units: Double) {
        guard state.isScriptRunning, session.isReachable else { return }
        pendingNudge -= units * Self.pointsPerCrownUnit
        guard nudgeFlush == nil else { return }
        nudgeFlush = Task { [weak self] in
            try? await Task.sleep(for: Self.nudgeSendInterval)
            self?.flushNudge()
        }
    }

    private func flushNudge() {
        nudgeFlush = nil
        let points = pendingNudge
        pendingNudge = 0
        guard points != 0, session.isReachable else { return }
        session.sendMessage(CameraRemoteMessage.encode(.nudgeScript(points)), replyHandler: nil)
    }

    /// Whether the screen is up. On, the phone is asked for its state and
    /// starts sending frames; off, the frames stop.
    func setWatching(_ watching: Bool) {
        isWatching = watching
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(CameraRemoteMessage.encode(.preview(watching)), replyHandler: nil)
        if watching {
            // WatchConnectivity calls the reply on its own queue, so the
            // closure is declared Sendable and hops to the main actor itself.
            let onReply: @Sendable ([String: Any]) -> Void = { [weak self] reply in
                guard let state = CameraRemoteMessage.state(in: reply) else { return }
                Task { @MainActor in self?.apply(state) }
            }
            session.sendMessage(CameraRemoteMessage.encode(.hello), replyHandler: onReply)
        }
    }

    private func apply(_ state: CameraRemoteState) {
        // A frame from the other camera is wrong the moment the phone
        // switches; the screen goes dark until the new camera's first frame.
        if state.facing != self.state.facing {
            frame = nil
        }
        self.state = state
        hasState = true
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

    /// The phone stopped answering: whatever it last said no longer holds.
    private func phoneWentAway() {
        state = CameraRemoteState()
        hasState = false
        frame = nil
        recordingStartedAt = nil
    }

    private func reachabilityChanged(_ reachable: Bool) {
        isPhoneReachable = reachable
        awayTask?.cancel()
        if reachable {
            isPhoneAway = false
            setWatching(isWatching)
        } else {
            phoneWentAway()
            awayTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                self?.isPhoneAway = true
            }
        }
    }

    // MARK: WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        let reachable = session.isReachable
        Task { @MainActor in reachabilityChanged(reachable) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in reachabilityChanged(reachable) }
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
