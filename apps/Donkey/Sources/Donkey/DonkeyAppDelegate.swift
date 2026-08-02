import AppKit
import DonkeyRuntime
import Foundation
import SwiftUI

/// Donkey is a menu bar app with no windows and no account. The product is the Donkey Cut video editor
/// in the browser; this app exists so that page can use the Mac's hardware — the local Cut engine
/// (encoding, storage, speech-to-text) and screen recording. Everything here is one of those two
/// features, plus the updater that keeps them current.
@MainActor
final class DonkeyAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    /// The menu bar surface: the status item whose menu carries Go to App, Record Screen, updates, and Quit.
    private var statusItemController: DonkeyStatusItemController?
    /// Sparkle, running windowless. A background check that finds an update surfaces the status
    /// menu's "Install Update" item; choosing it downloads, installs, and relaunches silently.
    private var updateChecker: (any DonkeyUpdateChecking)?
    /// Runs the Donkey Cut engine (the local server behind donkeycut.com) for the app's lifetime.
    private var cutEngineSupervisor: DonkeyCutEngineSupervisor?
    /// The QuickTime-style screen recorder: a menu bar toggle, a center-bottom control bar, and the
    /// region/window pickers.
    private var screenRecordingController: ScreenRecordingController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Build the recorder before the status item so its menu can drive the "Record Screen" item.
        self.screenRecordingController = ScreenRecordingController()
        installMainMenu()
        installStatusItem()
        startUpdateChecker()

        let cutEngineSupervisor = DonkeyCutEngineSupervisor()
        self.cutEngineSupervisor = cutEngineSupervisor
        // The engine's loopback port is machine-wide, so only the console session runs one: launched
        // in a fast-user-switched-out session, the supervisor starts suspended and picks the port up
        // when this session takes the console.
        if !Self.sessionIsOnConsole {
            cutEngineSupervisor.setSessionActive(false)
        }
        cutEngineSupervisor.start()
        observeSessionSwitches()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        cutEngineSupervisor?.stop()
    }

    // MARK: - Console session

    /// Whether this login session currently owns the screen. `CGSessionCopyCurrentDictionary`
    /// answers for the session this process runs in; a missing dictionary reads as on-console so a
    /// plain launch never starts suspended.
    private static var sessionIsOnConsole: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        return session[kCGSessionOnConsoleKey as String] as? Bool ?? true
    }

    private func observeSessionSwitches() {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            forName: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.cutEngineSupervisor?.setSessionActive(true) }
        }
        center.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.cutEngineSupervisor?.setSessionActive(false) }
        }
    }

    // MARK: - Status item

    private func installStatusItem() {
        statusItemController = DonkeyStatusItemController(
            checkForUpdates: { [weak self] in
                self?.updateChecker?.checkForUpdates()
            },
            installUpdate: { [weak self] in
                self?.updateChecker?.installAvailableUpdate()
            },
            screenRecordingMenuItem: { [weak self] in
                self?.screenRecordingController?.menuItem
            },
            toggleScreenRecording: { [weak self] in
                self?.screenRecordingController?.handleMenuItemClicked()
            }
        )
    }

    // MARK: - Updates

    private func startUpdateChecker() {
        let updateChecker = SparkleUpdateController()
        self.updateChecker = updateChecker
        updateChecker.updateStateChanged = { [weak self] state in
            self?.statusItemController?.updateState = state
        }
        updateChecker.start()
    }

    // MARK: - Menu

    /// The app main menu, mirroring the status-item menu with About on top.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(
            withTitle: "About \(Self.appDisplayName)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        statusItemController?.populateMenuItems(in: menu)
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        // Rebuilt on every open (and on key-equivalent lookup) by `menuNeedsUpdate`, so it tracks
        // the update state the same way the status-item menu does.
        let appMenu = NSMenu()
        appMenu.delegate = self
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )

        NSApp.mainMenu = mainMenu
    }

    private static var appDisplayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? ProcessInfo.processInfo.processName
    }
}
