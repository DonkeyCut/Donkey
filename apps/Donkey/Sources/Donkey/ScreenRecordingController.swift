import AppKit
import AVFoundation
import DonkeyRuntime
import DonkeyUI
import ScreenCaptureKit

/// Coordinates the whole screen-recording flow: the menu bar toggle, the center-bottom control bar,
/// the region/window pickers, and the recorder. It is the single source of truth — the menu bar glyph
/// and the control bar both render from this controller's state, so a click on either surface routes
/// here and every transition re-renders both.
///
/// ```
///   idle ──click──▶ armed ──Record──▶ recording ──Stop/click──▶ finalizing ──▶ idle (reveal .mov)
///     ▲              │  ▲ pick region / window
///     └── click / ✕ / Esc ┘
/// ```
@MainActor
final class ScreenRecordingController {
    private enum Phase {
        case idle
        case armed
        case recording
        case finalizing
    }

    private let model = RecordingControlBarModel()
    private lazy var controlBar = RecordingControlBarController(model: model)
    private let regionOverlay = RegionSelectionOverlayController()
    private let windowPicker = WindowPickerOverlayController()
    private let recordingDim = RecordingRegionDimOverlayController()

    private var recorder: (any ScreenRecording)?
    private var phase: Phase = .idle
    private var armScreen: NSScreen?
    private var selectedRegion: (rect: CGRect, displayID: CGDirectDisplayID)?
    private var selectedWindowID: CGWindowID?
    private var recordingStart: Date?
    private var timer: Timer?

    init() {
        model.onSelectMode = { [weak self] mode in self?.selectMode(mode) }
        model.onSelectAudioInput = { [weak self] id in self?.model.selectedAudioInputID = id }
        model.selectedAudioInputID = "system"
        model.onRecord = { [weak self] in self?.startRecording() }
        model.onStop = { [weak self] in self?.stopRecording() }
        model.onClose = { [weak self] in self?.cancel() }

        regionOverlay.onSelect = { [weak self] rect, displayID in self?.handleRegionSelected(rect, displayID) }
        regionOverlay.onCancel = { [weak self] in self?.handlePickerCancel() }
        windowPicker.onSelect = { [weak self] windowID in self?.handleWindowSelected(windowID) }
        windowPicker.onCancel = { [weak self] in self?.handlePickerCancel() }
    }

    // MARK: - Menu bar routing

    /// The "Record Screen" item's title and matching record/stop glyph for the Donkey menu, or `nil`
    /// to hide it (pre-macOS 15). Reflects state so the same item stops an in-progress recording. Read
    /// fresh each time the menu opens, so it always matches the current phase.
    var menuItem: (title: String, symbolName: String)? {
        guard #available(macOS 15.0, *) else { return nil }
        switch phase {
        case .idle, .armed: return ("Record Screen", "record.circle")
        case .recording, .finalizing: return ("Stop Recording", "stop.circle.fill")
        }
    }

    /// Routes a click on the Donkey menu's "Record Screen" item: open the control bar, or stop a
    /// running recording. The control bar's ✕ is what dismisses an armed-but-not-recording session.
    func handleMenuItemClicked() {
        switch phase {
        case .idle:
            arm()
        case .armed:
            if let screen = armScreen ?? NSScreen.main ?? NSScreen.screens.first {
                controlBar.show(on: screen)
            }
        case .recording:
            stopRecording()
        case .finalizing:
            break
        }
    }

    // MARK: - Arm / cancel

    private func arm() {
        phase = .armed
        selectedRegion = nil
        selectedWindowID = nil
        model.mode = .fullScreen
        model.isRecording = false
        model.isBusy = false
        model.statusMessage = nil
        model.audioInputs = makeAudioInputs()
        if !model.audioInputs.contains(where: { $0.id == model.selectedAudioInputID }) {
            model.selectedAudioInputID = "system"
        }
        armScreen = NSScreen.main ?? NSScreen.screens.first
        refreshCanRecord()
        if let armScreen {
            controlBar.show(on: armScreen)
        }
        // Warm ScreenCaptureKit so the first Record starts without the slow first-call latency.
        prewarmShareableContent()
    }

    private func cancel() {
        teardownOverlays()
        recordingDim.close()
        controlBar.close()
        phase = .idle
        selectedRegion = nil
        selectedWindowID = nil
    }

    // MARK: - Mode selection

    private func selectMode(_ mode: RecordingCaptureMode) {
        model.mode = mode
        model.statusMessage = nil
        teardownOverlays()
        switch mode {
        case .fullScreen:
            break
        case .region:
            selectedRegion = nil
            regionOverlay.begin()
        case .window:
            selectedWindowID = nil
            windowPicker.begin()
        }
        refreshCanRecord()
    }

    private func handleRegionSelected(_ rect: CGRect, _ displayID: CGDirectDisplayID) {
        selectedRegion = (rect, displayID)
        refreshCanRecord()
    }

    private func handleWindowSelected(_ windowID: CGWindowID) {
        selectedWindowID = windowID
        windowPicker.close()
        refreshCanRecord()
    }

    /// Escape / dismiss from a picker returns to full-screen, keeping the control bar up.
    private func handlePickerCancel() {
        teardownOverlays()
        model.mode = .fullScreen
        selectedRegion = nil
        selectedWindowID = nil
        refreshCanRecord()
    }

    private func refreshCanRecord() {
        switch model.mode {
        case .fullScreen: model.canRecord = true
        case .region: model.canRecord = selectedRegion != nil
        case .window: model.canRecord = selectedWindowID != nil
        }
    }

    // MARK: - Recording

    private func startRecording() {
        guard phase == .armed else { return }
        guard #available(macOS 15.0, *) else {
            model.statusMessage = "Screen recording requires macOS 15 or later."
            return
        }
        guard let target = resolveTarget() else { return }

        Task { await beginCapture(target: target) }
    }

    @available(macOS 15.0, *)
    private func beginCapture(target: ScreenCaptureTarget) async {
        guard await ensurePermission(.screenRecording, hint: "Allow Screen Recording in System Settings, then try again.") else {
            openScreenRecordingSettings()
            return
        }
        let audio = resolveAudioSelection()
        if audio.capturesMicrophone {
            guard await ensurePermission(.microphone, hint: "Allow Microphone access to include your voice.") else {
                return
            }
        }

        // Swap the interactive picker for a non-interactive dim that keeps the un-recorded area darkened
        // while recording. Both the dim and the control bar are excluded from the stream, so the
        // recording captures the region's real content and neither overlay shows up in the file.
        teardownOverlays()
        if case .display(let displayID, let region) = target, let region {
            recordingDim.show(region: region, displayID: displayID)
        }

        var excludedWindowIDs: [CGWindowID] = []
        if let controlBarWindow = controlBar.windowNumber { excludedWindowIDs.append(CGWindowID(controlBarWindow)) }
        if let dimWindow = recordingDim.windowNumber { excludedWindowIDs.append(CGWindowID(dimWindow)) }

        let configuration = ScreenRecordingConfiguration(
            target: target,
            capturesSystemAudio: audio.capturesSystemAudio,
            capturesMicrophone: audio.capturesMicrophone,
            microphoneDeviceID: audio.microphoneDeviceID,
            excludedWindowIDs: excludedWindowIDs,
            outputURL: ScreenRecordingDestination.makeOutputURL()
        )

        let recorder = SCRecordingScreenRecorder()
        recorder.onUnexpectedStop = { [weak self] _ in self?.handleUnexpectedStop() }
        self.recorder = recorder

        do {
            try await recorder.start(configuration)
            phase = .recording
            recordingStart = Date()
            model.isRecording = true
            model.statusMessage = nil
            startTimer()
        } catch ScreenRecordingError.screenRecordingPermissionDenied {
            self.recorder = nil
            recordingDim.close()
            model.statusMessage = "Allow Screen Recording in System Settings, then try again."
            openScreenRecordingSettings()
        } catch {
            self.recorder = nil
            recordingDim.close()
            model.statusMessage = "Couldn't start recording."
        }
    }

    private func stopRecording() {
        guard phase == .recording, let recorder else { return }
        phase = .finalizing
        model.isBusy = true
        stopTimer()

        Task {
            defer { finishAfterRecording() }
            do {
                let url = try await recorder.stop()
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch {
                model.statusMessage = "Recording failed to finalize."
            }
        }
    }

    private func handleUnexpectedStop() {
        stopTimer()
        recorder = nil
        recordingDim.close()
        phase = .idle
        controlBar.close()
    }

    private func finishAfterRecording() {
        recorder = nil
        recordingStart = nil
        recordingDim.close()
        phase = .idle
        model.isRecording = false
        model.isBusy = false
        controlBar.close()
    }

    // MARK: - Target resolution

    private func resolveTarget() -> ScreenCaptureTarget? {
        switch model.mode {
        case .fullScreen:
            guard let displayID = (armScreen ?? NSScreen.main)?.donkeyDisplayID else {
                model.statusMessage = "Couldn't find a display to record."
                return nil
            }
            return .display(displayID: displayID, region: nil)
        case .region:
            guard let selectedRegion else { return nil }
            return .display(displayID: selectedRegion.displayID, region: selectedRegion.rect)
        case .window:
            guard let selectedWindowID else { return nil }
            return .window(windowID: selectedWindowID)
        }
    }

    // MARK: - Audio inputs

    /// The audio sources offered by the input picker: system output (the default), every available
    /// microphone by name, and None.
    private func makeAudioInputs() -> [RecordingAudioInput] {
        var inputs: [RecordingAudioInput] = [
            RecordingAudioInput(id: "system", kind: .systemAudio, label: "System Audio")
        ]
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        for device in discovery.devices {
            inputs.append(RecordingAudioInput(
                id: device.uniqueID,
                kind: .microphone(deviceID: device.uniqueID),
                label: device.localizedName
            ))
        }
        inputs.append(RecordingAudioInput(id: "none", kind: .none, label: "None"))
        return inputs
    }

    private func resolveAudioSelection() -> (capturesSystemAudio: Bool, capturesMicrophone: Bool, microphoneDeviceID: String?) {
        let selected = model.audioInputs.first { $0.id == model.selectedAudioInputID }
        guard let kind = selected?.kind else { return (false, false, nil) }
        switch kind {
        case .none: return (false, false, nil)
        case .systemAudio: return (true, false, nil)
        case .microphone(let deviceID): return (false, true, deviceID)
        }
    }

    // MARK: - Permission helpers

    private func ensurePermission(_ permission: SystemPermission, hint: String) async -> Bool {
        if SystemPermissionCoordinator.status(permission) == .granted { return true }
        let granted = await SystemPermissionCoordinator.request(permission)
        if !granted {
            model.statusMessage = hint
        }
        return granted
    }

    private func openScreenRecordingSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func prewarmShareableContent() {
        Task { _ = try? await SCShareableContent.current }
    }

    // MARK: - Timer

    private func startTimer() {
        stopTimer()
        updateElapsed()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateElapsed() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func updateElapsed() {
        guard let recordingStart else { return }
        let seconds = Int(Date().timeIntervalSince(recordingStart))
        model.elapsedText = String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func teardownOverlays() {
        regionOverlay.close()
        windowPicker.close()
    }
}
