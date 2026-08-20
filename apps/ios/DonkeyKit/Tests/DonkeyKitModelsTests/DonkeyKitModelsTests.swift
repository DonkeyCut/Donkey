import Foundation
import Testing
@testable import DonkeyKitModels

@Suite struct FormatSelectionTests {
    // iPhone-shaped format table: 1080p60 HLG, 1080p30 SDR, 4K60 HLG, 720p30.
    let specs = [
        CaptureFormatSpec(index: 0, width: 1280, height: 720, maxFrameRate: 30, supportsHLG: false),
        CaptureFormatSpec(index: 1, width: 1920, height: 1080, maxFrameRate: 30, supportsHLG: false),
        CaptureFormatSpec(index: 2, width: 1920, height: 1080, maxFrameRate: 60, supportsHLG: true),
        CaptureFormatSpec(index: 3, width: 3840, height: 2160, maxFrameRate: 60, supportsHLG: true),
    ]

    @Test func exactMatchWins() {
        let choice = chooseFormat(from: specs, settings: CameraSettings(resolution: .uhd, frameRate: .fps60, colorMode: .hdr))
        #expect(choice?.index == 3)
        #expect(choice?.effective == CameraSettings(resolution: .uhd, frameRate: .fps60, colorMode: .hdr))
    }

    @Test func missing2KSnapsToNearestArea() {
        let choice = chooseFormat(from: specs, settings: CameraSettings(resolution: .qhd, frameRate: .fps30, colorMode: .sdr))
        #expect(choice?.index == 1)
    }

    @Test func hdrFallsBackToSDR() {
        let sdrOnly = [CaptureFormatSpec(index: 0, width: 1920, height: 1080, maxFrameRate: 60, supportsHLG: false)]
        let choice = chooseFormat(from: sdrOnly, settings: CameraSettings(resolution: .hd, frameRate: .fps60, colorMode: .hdr))
        #expect(choice?.effective.colorMode == .sdr)
        #expect(choice?.index == 0)
    }

    @Test func unavailableFrameRateFallsBack() {
        let slow = [CaptureFormatSpec(index: 0, width: 1920, height: 1080, maxFrameRate: 30, supportsHLG: false)]
        let choice = chooseFormat(from: slow, settings: CameraSettings(resolution: .hd, frameRate: .fps60, colorMode: .sdr))
        #expect(choice?.effective.frameRate == .fps30)
    }

    @Test func emptySpecsChooseNothing() {
        #expect(chooseFormat(from: [], settings: CameraSettings()) == nil)
    }
}

@Suite struct ZoomTests {
    @Test func tripleCameraOffersUltraWide() {
        let mapping = ZoomMapping(wideBase: 2, minDisplay: 0.5, maxDisplay: 8)
        #expect(mapping.options == [0.5, 1, 2, 3])
        #expect(mapping.videoZoomFactor(forDisplay: 1) == 2)
        #expect(mapping.videoZoomFactor(forDisplay: 0.5) == 1)
    }

    @Test func singleCameraClampsToOne() {
        let mapping = ZoomMapping(wideBase: 1, minDisplay: 1, maxDisplay: 1)
        #expect(mapping.options == [1])
        #expect(mapping.videoZoomFactor(forDisplay: 3) == 1)
    }

    @Test func labels() {
        #expect(zoomLabel(0.5) == "0.5×")
        #expect(zoomLabel(2) == "2×")
    }
}

@Suite struct TeleprompterTests {
    @Test func scrollStartsLowAndMovesUp() {
        var state = TeleprompterState()
        state.settings.speed = 40
        let start = state.scrollOffset(elapsed: 0, overlayHeight: 300)
        #expect(start == 180)
        #expect(state.scrollOffset(elapsed: 2, overlayHeight: 300) == 100)
    }

    @Test func hasScriptIgnoresWhitespace() {
        var state = TeleprompterState()
        state.script = "  \n"
        #expect(!state.hasScript)
        state.script = "Hello"
        #expect(state.hasScript)
    }
}

@Suite struct DurationTests {
    @Test func formatting() {
        #expect(formattedDuration(0) == "0:00")
        #expect(formattedDuration(65) == "1:05")
        #expect(formattedDuration(600) == "10:00")
    }
}

@Suite struct InspirationURLTests {
    @Test func addsHTTPS() {
        #expect(normalizedInspirationURL("tiktok.com/@donkey")?.absoluteString == "https://tiktok.com/@donkey")
    }

    @Test func keepsExplicitScheme() {
        #expect(normalizedInspirationURL("http://example.com")?.absoluteString == "http://example.com")
    }

    @Test func rejectsEmpty() {
        #expect(normalizedInspirationURL("   ") == nil)
    }
}

@MainActor
@Suite struct IdeasModelTests {
    func makeModel() throws -> IdeasModel {
        IdeasModel(store: try DonkeyStore(inMemory: true))
    }

    @Test func saveDraftCreatesNote() throws {
        let model = try makeModel()
        model.openEditor()
        model.draft?.body = "Hey there this is cool"
        let note = model.saveDraft()
        #expect(note?.title == "Untitled")
        #expect(model.notes.count == 1)
        #expect(model.draft == nil)
    }

    @Test func emptyDraftDoesNotSave() throws {
        let model = try makeModel()
        model.openEditor()
        #expect(model.saveDraft() == nil)
        #expect(model.notes.isEmpty)
    }

    @Test func editKeepsIdentityAndPosition() throws {
        let model = try makeModel()
        model.openEditor()
        model.draft?.title = "First"
        let first = model.saveDraft()
        model.openEditor()
        model.draft?.title = "Second"
        model.saveDraft()

        model.openEditor(for: model.notes[1])
        model.draft?.body = "edited"
        model.cycleDraftColor()
        let edited = model.saveDraft()
        #expect(edited?.id == first?.id)
        #expect(edited?.color == .blush)
        #expect(model.notes.count == 2)
        #expect(model.notes[1].body == "edited")
    }

    @Test func scriptPrefersBody() {
        let note = Note(title: "Title", body: "Body", color: .butter)
        #expect(note.script == "Body")
        let titleOnly = Note(title: "Title", body: "", color: .butter)
        #expect(titleOnly.script == "Title")
    }

    @Test func inspirationLinkRoundTrips() throws {
        let model = try makeModel()
        #expect(model.addInspiration(urlText: "youtube.com/watch?v=1"))
        #expect(!model.addInspiration(urlText: " "))
        #expect(model.inspiration.count == 1)
        guard case .link(let url) = model.inspiration[0].kind else {
            Issue.record("expected link")
            return
        }
        #expect(url.host() == "youtube.com")
    }
}

@MainActor
@Suite struct AuthModelTests {
    final class FakeAuth: AuthServicing {
        var stored: UserProfile?
        var result: Result<UserProfile, any Error> = .failure(CancellationError())

        func signIn(with provider: AuthProvider) async throws -> UserProfile {
            try result.get()
        }

        func restoreSession() async -> UserProfile? { stored }
        func signOut() async { stored = nil }
    }

    @Test func restoreWithoutSessionSignsOut() async {
        let model = AuthModel(service: FakeAuth())
        await model.restore()
        #expect(model.state == .signedOut)
    }

    @Test func successfulSignIn() async {
        let service = FakeAuth()
        let profile = UserProfile(id: "1", name: "David", email: "d@example.com")
        service.result = .success(profile)
        let model = AuthModel(service: service)
        await model.restore()
        await model.signIn(with: .google)
        #expect(model.state == .signedIn(profile))
        #expect(profile.initial == "D")
    }

    @Test func failureReturnsToSignedOutWithError() async {
        let service = FakeAuth()
        service.result = .failure(URLError(.notConnectedToInternet))
        let model = AuthModel(service: service)
        await model.restore()
        await model.signIn(with: .apple)
        #expect(model.state == .signedOut)
        #expect(model.lastError != nil)
    }

    @Test func cancellationLeavesNoError() async {
        let model = AuthModel(service: FakeAuth())
        await model.restore()
        await model.signIn(with: .apple)
        #expect(model.state == .signedOut)
        #expect(model.lastError == nil)
    }
}

@MainActor
@Suite struct CameraModelTests {
    final class FakeController: CameraControlling {
        var recorded: [String] = []
        func activate() { recorded.append("activate") }
        func deactivate() { recorded.append("deactivate") }
        func setFacing(_ facing: CameraFacing) { recorded.append("facing") }
        func setZoom(display: Double) { recorded.append("zoom \(display)") }
        func setTorch(_ on: Bool) { recorded.append("torch \(on)") }
        func apply(_ settings: CameraSettings) { recorded.append("apply") }
        func startRecording() { recorded.append("start") }
        func stopRecording() { recorded.append("stop") }
    }

    @Test func recordToggleRoutesThroughController() {
        let model = CameraModel()
        let controller = FakeController()
        model.controller = controller
        model.toggleRecording()
        model.recordingDidStart()
        #expect(model.isRecording)
        model.toggleRecording()
        model.recordingDidFinish()
        #expect(!model.isRecording)
        #expect(controller.recorded == ["start", "stop"])
    }

    @Test func flipResetsZoomAndTorch() {
        let model = CameraModel()
        model.controller = FakeController()
        model.select(zoom: 2)
        model.toggleTorch()
        model.flip()
        #expect(model.facing == .back)
        #expect(model.zoom == 1)
        #expect(!model.isTorchOn)
    }
}
