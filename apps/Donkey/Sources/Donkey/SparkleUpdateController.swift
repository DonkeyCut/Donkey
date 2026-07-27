import Foundation
import Sparkle

@MainActor
protocol DonkeyUpdateChecking: AnyObject {
    var currentVersion: String { get }
    var updateStateChanged: ((DonkeyUpdateState) -> Void)? { get set }

    func start()
    func checkForUpdates()
    func installAvailableUpdate()
}

/// Drives Sparkle with no windows. A background check that finds an update surfaces the notch
/// "Update Available" button; tapping it (`installAvailableUpdate`) dismisses the badge at once,
/// then downloads, installs, and relaunches silently. Sparkle's standard update dialog is never shown.
@MainActor
final class SparkleUpdateController: NSObject, DonkeyUpdateChecking, SPUUserDriver {
    private var updater: SPUUpdater?
    /// The install decision Sparkle hands us when it finds an update. We hold it until the user
    /// taps the notch button, then answer `.install` to begin the silent download.
    private var pendingInstall: ((SPUUserUpdateChoice) -> Void)?

    var updateStateChanged: ((DonkeyUpdateState) -> Void)?

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ??
            "0.1.0"
    }

    func start() {
        guard updater == nil else { return }
        guard isSparkleConfigured else {
            emit(.unavailable, message: "Sparkle feed not configured")
            return
        }

        let updater = SPUUpdater(
            hostBundle: .main,
            applicationBundle: .main,
            userDriver: self,
            delegate: nil
        )
        do {
            try updater.start()
            self.updater = updater
        } catch {
            emit(.unavailable, message: error.localizedDescription)
        }
    }

    /// Runs a user-initiated check. Sparkle's background checks report to the user driver only
    /// when they find an update, so a menu-triggered check must go through `checkForUpdates()` —
    /// it always answers with found, not-found, or an error, letting the "Checking…" state resolve.
    func checkForUpdates() {
        guard let updater else {
            emit(.unavailable, message: "Updater unavailable")
            return
        }
        // Sparkle ignores the call while another update session is running (e.g. an automatic
        // check in flight); emitting `.checking` then would stick, since no callback follows.
        guard updater.canCheckForUpdates else { return }

        emit(.checking)
        updater.checkForUpdates()
    }

    /// The user tapped the notch button. Dismiss the "Update Available" badge immediately so the tap
    /// has instant feedback, then resume the update Sparkle already found and let it download, install,
    /// and relaunch silently. If nothing is pending, kick a fresh background check instead.
    func installAvailableUpdate() {
        guard let pendingInstall else {
            checkForUpdates()
            return
        }

        self.pendingInstall = nil
        emit(.installing)
        pendingInstall(.install)
    }

    private var isSparkleConfigured: Bool {
        let feedURL = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String
        let publicKey = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String

        return feedURL?.isEmpty == false && publicKey?.isEmpty == false
    }

    private func emit(
        _ status: DonkeyUpdateStatus,
        latestVersion: String? = nil,
        message: String? = nil
    ) {
        updateStateChanged?(
            DonkeyUpdateState(
                status: status,
                currentVersion: currentVersion,
                latestVersion: latestVersion,
                message: message
            )
        )
    }

    // MARK: - SPUUserDriver

    func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}

    func showUpdateFound(
        with appcastItem: SUAppcastItem,
        state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
        // Hold the decision and light up the notch button instead of installing immediately.
        pendingInstall = reply
        emit(.available, latestVersion: appcastItem.displayVersionString)
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

    func showUpdateNotFoundWithError(_ error: any Error) async {
        emit(.upToDate, message: error.localizedDescription)
    }

    func showUpdaterError(_ error: any Error) async {
        pendingInstall = nil
        emit(.failed, message: error.localizedDescription)
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {}

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}

    func showDownloadDidReceiveData(ofLength length: UInt64) {}

    func showDownloadDidStartExtractingUpdate() {}

    func showExtractionReceivedProgress(_ progress: Double) {}

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        reply(.install)
    }

    func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void
    ) {}

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool) async {}

    func dismissUpdateInstallation() {
        pendingInstall = nil
    }
}
