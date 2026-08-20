import AVFoundation
import DonkeyKitModels
import UIKit

/// Owns the capture side of the camera feature: permission prompts, the
/// engine, and routing engine events into CameraModel state.
final class CameraController: CameraControlling {
    let session: AVCaptureSession
    weak var model: CameraModel?
    var onRecordingFinished: ((URL, TimeInterval, Data?) -> Void)?

    private let engine = CaptureEngine()

    init() {
        session = engine.session
        engine.events = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    func activate() {
        Task {
            let cameraGranted = await AVCaptureDevice.requestAccess(for: .video)
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            guard cameraGranted else {
                model?.sessionFailed(reason: "Camera access is off.\nAllow camera access in Settings to record.")
                return
            }
            engine.start(facing: model?.facing ?? .front, settings: model?.settings ?? CameraSettings())
        }
    }

    func deactivate() { engine.stop() }
    func setFacing(_ facing: CameraFacing) { engine.set(facing: facing) }
    func setZoom(display: Double) { engine.setZoom(display: display) }
    func setTorch(_ on: Bool) { engine.setTorch(on) }
    func apply(_ settings: CameraSettings) { engine.apply(settings) }
    func startRecording() { engine.startRecording() }
    func stopRecording() { engine.stopRecording() }

    private func handle(_ event: CaptureEngine.Event) {
        switch event {
        case .running(let mapping, let hasTorch, let effective):
            model?.sessionDidStart(zoomMapping: mapping, hasTorch: hasTorch, effective: effective)
        case .failed(let reason):
            model?.sessionFailed(reason: reason)
        case .recordingStarted:
            model?.recordingDidStart()
        case .recordingFinished(let url, let duration, let thumbnail):
            model?.recordingDidFinish()
            onRecordingFinished?(url, duration, thumbnail)
        case .recordingFailed:
            model?.recordingDidFinish()
        }
    }
}

/// All AVFoundation state, confined to one serial queue per Apple's capture
/// guidance. `@unchecked Sendable` is the queue-confinement contract: nothing
/// here is touched off `queue` after init.
private nonisolated final class CaptureEngine: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
    enum Event: Sendable {
        case running(ZoomMapping, hasTorch: Bool, effective: CameraSettings)
        case failed(reason: String)
        case recordingStarted
        case recordingFinished(URL, TimeInterval, Data?)
        case recordingFailed
    }

    let session = AVCaptureSession()
    var events: (@Sendable (Event) -> Void)?

    private let queue = DispatchQueue(label: "com.donkeycut.donkeycut.capture")
    private let movieOutput = AVCaptureMovieFileOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var facing: CameraFacing = .front
    private var settings = CameraSettings()
    private var zoomMapping = ZoomMapping(wideBase: 1, minDisplay: 1, maxDisplay: 1)

    private static let recordableDimensions: Set<String> = [
        "1280x720", "1920x1080", "2560x1440", "3840x2160",
    ]

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(sessionInterrupted), name: AVCaptureSession.wasInterruptedNotification, object: session)
        center.addObserver(self, selector: #selector(sessionResumed), name: AVCaptureSession.interruptionEndedNotification, object: session)
    }

    @objc private func sessionInterrupted() {
        events?(.failed(reason: "Camera paused.\nAnother app is using the camera."))
    }

    @objc private func sessionResumed() {
        queue.async { self.emitRunning() }
    }

    func start(facing: CameraFacing, settings: CameraSettings) {
        queue.async {
            self.settings = settings
            if self.session.inputs.isEmpty {
                self.session.beginConfiguration()
                self.session.sessionPreset = .inputPriority
                if let microphone = AVCaptureDevice.default(for: .audio),
                   let input = try? AVCaptureDeviceInput(device: microphone),
                   self.session.canAddInput(input) {
                    self.session.addInput(input)
                }
                if self.session.canAddOutput(self.movieOutput) {
                    self.session.addOutput(self.movieOutput)
                }
                self.session.commitConfiguration()
            }
            self.installCamera(facing: facing)
            if !self.session.isRunning {
                self.session.startRunning()
            }
            self.emitRunning()
        }
    }

    func stop() {
        queue.async {
            if self.movieOutput.isRecording {
                self.movieOutput.stopRecording()
            }
            self.session.stopRunning()
        }
    }

    func set(facing: CameraFacing) {
        queue.async {
            self.installCamera(facing: facing)
            self.emitRunning()
        }
    }

    func setZoom(display: Double) {
        queue.async {
            guard let device = self.videoInput?.device else { return }
            let factor = self.zoomMapping.videoZoomFactor(forDisplay: display)
            do {
                try device.lockForConfiguration()
                device.ramp(toVideoZoomFactor: factor, withRate: 8)
                device.unlockForConfiguration()
            } catch {}
        }
    }

    func setTorch(_ on: Bool) {
        queue.async {
            guard let device = self.videoInput?.device, device.hasTorch else { return }
            do {
                try device.lockForConfiguration()
                device.torchMode = on ? .on : .off
                device.unlockForConfiguration()
            } catch {}
        }
    }

    func apply(_ settings: CameraSettings) {
        queue.async {
            self.settings = settings
            self.applyFormat()
            self.emitRunning()
        }
    }

    func startRecording() {
        queue.async {
            guard !self.movieOutput.isRecording else { return }
            let url = FileManager.default.temporaryDirectory
                .appending(path: UUID().uuidString + ".mov")
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    func stopRecording() {
        queue.async {
            guard self.movieOutput.isRecording else { return }
            self.movieOutput.stopRecording()
        }
    }

    // MARK: Queue-confined configuration

    private func installCamera(facing: CameraFacing) {
        self.facing = facing
        guard let device = Self.camera(for: facing) else {
            events?(.failed(reason: "No camera available."))
            return
        }
        session.beginConfiguration()
        if let videoInput {
            session.removeInput(videoInput)
            self.videoInput = nil
        }
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            session.commitConfiguration()
            events?(.failed(reason: "The camera could not be opened."))
            return
        }
        session.addInput(input)
        videoInput = input
        zoomMapping = Self.zoomMapping(for: device)
        session.commitConfiguration()
        applyFormat()
        setZoomImmediate(display: 1)
    }

    private static func camera(for facing: CameraFacing) -> AVCaptureDevice? {
        let position: AVCaptureDevice.Position = facing == .front ? .front : .back
        let types: [AVCaptureDevice.DeviceType] = position == .back
            ? [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
            : [.builtInTrueDepthCamera, .builtInWideAngleCamera]
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: position
        ).devices.first
    }

    private static func zoomMapping(for device: AVCaptureDevice) -> ZoomMapping {
        let hasUltraWide = device.constituentDevices.contains { $0.deviceType == .builtInUltraWideCamera }
        let wideBase = hasUltraWide
            ? (device.virtualDeviceSwitchOverVideoZoomFactors.first.map { Double(truncating: $0) } ?? 2)
            : 1
        let maxDisplay = min(Double(device.maxAvailableVideoZoomFactor) / wideBase, 8)
        return ZoomMapping(wideBase: wideBase, minDisplay: hasUltraWide ? 0.5 : 1, maxDisplay: max(maxDisplay, 1))
    }

    private func applyFormat() {
        guard let device = videoInput?.device else { return }
        let specs = device.formats.enumerated().compactMap { index, format -> CaptureFormatSpec? in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard Self.recordableDimensions.contains("\(dimensions.width)x\(dimensions.height)") else { return nil }
            let maxFrameRate = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
            return CaptureFormatSpec(
                index: index,
                width: Int(dimensions.width),
                height: Int(dimensions.height),
                maxFrameRate: maxFrameRate,
                supportsHLG: format.supportedColorSpaces.contains(.HLG_BT2020)
            )
        }
        guard let choice = chooseFormat(from: specs, settings: settings) else { return }
        session.beginConfiguration()
        session.automaticallyConfiguresCaptureDeviceForWideColor = false
        do {
            try device.lockForConfiguration()
            device.activeFormat = device.formats[choice.index]
            let frameDuration = CMTime(value: 1, timescale: CMTimeScale(choice.effective.frameRate.rawValue))
            device.activeVideoMinFrameDuration = frameDuration
            device.activeVideoMaxFrameDuration = frameDuration
            device.activeColorSpace = choice.effective.colorMode == .hdr ? .HLG_BT2020 : .sRGB
            device.unlockForConfiguration()
        } catch {}
        session.commitConfiguration()
        if let connection = movieOutput.connection(with: .video) {
            connection.preferredVideoStabilizationMode = .auto
            let codecs = movieOutput.availableVideoCodecTypes
            if codecs.contains(.hevc) {
                movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.hevc], for: connection)
            }
        }
        effectiveSettings = choice.effective
    }

    private var effectiveSettings = CameraSettings()

    private func setZoomImmediate(display: Double) {
        guard let device = videoInput?.device else { return }
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = zoomMapping.videoZoomFactor(forDisplay: display)
            device.unlockForConfiguration()
        } catch {}
    }

    private func emitRunning() {
        let hasTorch = videoInput?.device.hasTorch ?? false
        events?(.running(zoomMapping, hasTorch: hasTorch, effective: effectiveSettings))
    }

    // MARK: AVCaptureFileOutputRecordingDelegate

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        events?(.recordingStarted)
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: (any Error)?
    ) {
        // A stop can report a benign error while still writing a usable file.
        let wroteFile = FileManager.default.fileExists(atPath: outputFileURL.path())
        guard wroteFile else {
            events?(.recordingFailed)
            return
        }
        let events = events
        Task.detached {
            let asset = AVURLAsset(url: outputFileURL)
            let duration = (try? await asset.load(.duration).seconds) ?? 0
            let thumbnail = await Self.thumbnail(for: asset)
            events?(.recordingFinished(outputFileURL, duration, thumbnail))
        }
    }

    private static func thumbnail(for asset: AVURLAsset) async -> Data? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 720, height: 720)
        guard let cgImage = try? await generator.image(at: .zero).image else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.8)
    }
}
