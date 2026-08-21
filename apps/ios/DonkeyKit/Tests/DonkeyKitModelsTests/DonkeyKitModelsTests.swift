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
        state.settings.wordsPerMinute = 120
        state.script = Array(repeating: "word", count: 120).joined(separator: " ")
        // 120 words at 120 wpm = 60s, so 420pt of script passes in a minute.
        // The script starts halfway down the prompter and rises at that pace.
        #expect(state.duration == 60)
        let start = state.scrollOffset(elapsed: 0, overlayHeight: 300, textHeight: 420, gap: 100)
        #expect(start == 150)
        let mid = state.scrollOffset(elapsed: 30, overlayHeight: 300, textHeight: 420, gap: 100)
        #expect(mid == 150 - 210)
        let end = state.scrollOffset(elapsed: 60, overlayHeight: 300, textHeight: 420, gap: 100)
        #expect(end == 150 - 420)
    }

    @Test func scrollWrapsAtTheGapWithoutAnEmptyScreen() {
        var state = TeleprompterState()
        state.settings.wordsPerMinute = 120
        state.script = Array(repeating: "word", count: 120).joined(separator: " ")
        // 7pt a second: the second copy of the script reaches the first one's
        // starting place exactly when the travel wraps.
        let cycle = (420.0 + 100.0) / 7
        let wrapped = state.scrollOffset(elapsed: cycle, overlayHeight: 300, textHeight: 420, gap: 100)
        #expect(abs(wrapped - 150) < 0.000_001)
    }

    @Test func emptyScriptHoldsAtLead() {
        let state = TeleprompterState()
        #expect(state.scrollOffset(elapsed: 5, overlayHeight: 300, textHeight: 0, gap: 100) == 150)
    }

    @Test func hasScriptIgnoresWhitespace() {
        var state = TeleprompterState()
        state.script = "  \n"
        #expect(!state.hasScript)
        state.script = "Hello"
        #expect(state.hasScript)
    }

    @Test func readDurationCountsWordsNotSpacing() {
        #expect(readDuration(of: "one   two\n\nthree", wordsPerMinute: 60) == 3)
        #expect(readDuration(of: "", wordsPerMinute: 150) == 0)
    }

    @Test func pacingRespectsUserNewlines() {
        let paced = pacedScript("First thought\nSecond thought")
        #expect(paced == "First thought\n\nSecond thought")
    }

    @Test func pacingCollapsesSpaceRuns() {
        #expect(pacedScript("hello    there   friend") == "hello there friend")
    }

    @Test func pacingWrapsLongParagraphsAtClauses() {
        let paced = pacedScript("Hey everyone, welcome back to the channel where we talk about editing")
        let lines = paced.split(separator: "\n").map(String.init)
        // The clause end takes the first break; no line outruns the word cap.
        #expect(lines.first == "Hey everyone,")
        #expect(lines.allSatisfy { $0.split(separator: " ").count <= 6 })
        // Every word survives the wrap.
        #expect(paced.split(whereSeparator: { $0.isWhitespace }).count == 12)
    }
}

@MainActor
@Suite struct SyncEngineTests {
    final class FakeCloud: CloudSyncServicing {
        var notes: [UUID: RemoteNote] = [:]
        var uploads: [String] = []
        var deletedAssets: [String] = []
        var deletedNotes: [UUID] = []
        var links: [URL] = []
        var usage = StorageUsage(bytes: 0, quotaBytes: 1_000_000)
        var uploadResult: Result<RemoteAsset, CloudSyncError> =
            .success(RemoteAsset(id: "asset-1", fileName: "clip.mov"))
        /// Runs while the bytes are "in flight", before the upload returns.
        var onUpload: (() -> Void)?

        func uploadLibraryMedia(
            _ upload: LibraryUpload,
            progress: @escaping @Sendable (Double) -> Void
        ) async throws -> RemoteAsset {
            uploads.append(upload.fileName)
            onUpload?()
            return try uploadResult.get()
        }

        func deleteLibraryAsset(id: String) async throws { deletedAssets.append(id) }
        func importInspirationLink(_ url: URL) async throws { links.append(url) }
        func fetchUsage() async throws -> StorageUsage { usage }
        func fetchNotes() async throws -> [RemoteNote] { Array(notes.values) }

        func putNote(_ note: RemoteNote) async throws -> RemoteNote {
            if let existing = notes[note.id], existing.updatedAt > note.updatedAt { return existing }
            notes[note.id] = note
            return note
        }

        func deleteNote(id: UUID) async throws {
            deletedNotes.append(id)
            notes[id] = nil
        }
    }

    struct Rig {
        let store: DonkeyStore
        let cloud: FakeCloud
        let ideas: IdeasModel
        let media: MediaModel
        let engine: SyncEngine
    }

    func makeRig() throws -> Rig {
        let store = try DonkeyStore(inMemory: true)
        let cloud = FakeCloud()
        let ideas = IdeasModel(store: store)
        let media = MediaModel(store: store)
        let engine = SyncEngine(
            journal: store,
            service: cloud,
            signedIn: { true },
            uploadFor: { recording in
                LibraryUpload(
                    fileURL: media.movieURL(for: recording),
                    fileName: recording.fileName,
                    mime: "video/quicktime",
                    bytes: 100,
                    name: "Recording",
                    type: "video",
                    duration: recording.duration,
                    origin: "camera"
                )
            }
        )
        engine.media = media
        engine.ideas = ideas
        media.sync = engine
        // Assigned before the engine is observed so the didSet kick (a no-op
        // pass) can't race the manual run() calls below.
        engine.network = .wifi
        return Rig(store: store, cloud: cloud, ideas: ideas, media: media, engine: engine)
    }

    func ingestClip(_ rig: Rig) throws -> Recording {
        let temp = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".mov")
        try Data("movie".utf8).write(to: temp)
        rig.media.ingest(movieAt: temp, duration: 2, thumbnail: nil)
        return rig.media.recordings[0]
    }

    @Test func recordingUploadsOnceAndJournals() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        await rig.engine.run()
        #expect(rig.cloud.uploads == [recording.fileName])
        #expect(rig.engine.state(for: recording) == .synced)
        // A second pass moves nothing: the journal already holds the asset.
        await rig.engine.run()
        #expect(rig.cloud.uploads.count == 1)
    }

    @Test func fullStoragePausesUploadsAndRaisesBanner() async throws {
        let rig = try makeRig()
        rig.cloud.usage = StorageUsage(bytes: 10, quotaBytes: 10)
        _ = try ingestClip(rig)
        await rig.engine.run()
        #expect(rig.engine.storageFull)
        #expect(rig.cloud.uploads.isEmpty)
    }

    @Test func transientFailureKeepsClaimForResume() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        rig.cloud.uploadResult = .failure(.transport)
        await rig.engine.run()
        let journaled = try rig.store.recordingRemote(recording.id)
        #expect(journaled.assetId == nil)
        #expect(journaled.claimedFileName == recording.fileName)
        #expect(rig.engine.state(for: recording) == .onDevice)
        rig.cloud.uploadResult = .success(RemoteAsset(id: "asset-9", fileName: recording.fileName))
        await rig.engine.run()
        #expect(rig.engine.state(for: recording) == .synced)
    }

    @Test func deleteDuringUploadTombstonesTheFreshAsset() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        rig.cloud.onUpload = { rig.media.delete(recording) }
        await rig.engine.run()
        // The finished upload found its row gone, so the journal holds a
        // tombstone for the asset; the next pass takes the cloud copy down.
        await rig.engine.run()
        #expect(rig.cloud.deletedAssets == ["asset-1"])
        #expect(try rig.store.tombstones().isEmpty)
    }

    @Test func deleteOfSyncedRecordingReachesCloud() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        await rig.engine.run()
        rig.media.delete(recording)
        await rig.engine.run()
        #expect(rig.cloud.deletedAssets == ["asset-1"])
        #expect(try rig.store.tombstones().isEmpty)
    }

    @Test func localNotePushesAndRemoteNewerWins() async throws {
        let rig = try makeRig()
        rig.ideas.openEditor()
        rig.ideas.draft?.body = "phone words"
        let note = rig.ideas.saveDraft()!
        await rig.engine.run()
        #expect(rig.cloud.notes[note.id]?.body == "phone words")

        // The desktop edits later; the next pass adopts its version.
        rig.cloud.notes[note.id] = RemoteNote(
            id: note.id,
            title: note.title,
            body: "desktop words",
            colorIndex: 2,
            updatedAt: note.updatedAt.addingTimeInterval(60)
        )
        await rig.engine.run()
        #expect(rig.ideas.notes.first?.body == "desktop words")
        #expect(rig.ideas.notes.first?.color == .sky)
    }

    @Test func noteDeleteTombstonePropagates() async throws {
        let rig = try makeRig()
        rig.ideas.openEditor()
        rig.ideas.draft?.body = "short lived"
        let note = rig.ideas.saveDraft()!
        await rig.engine.run()
        rig.ideas.deleteNote(id: note.id)
        await rig.engine.run()
        #expect(rig.cloud.deletedNotes == [note.id])
        #expect(rig.ideas.notes.isEmpty)
    }

    @Test func cloudDeleteComesDownAsRemoval() async throws {
        let rig = try makeRig()
        rig.ideas.openEditor()
        rig.ideas.draft?.body = "doomed"
        let note = rig.ideas.saveDraft()!
        await rig.engine.run()
        // The desktop deleted it; the cloud keeps a newer tombstone.
        rig.cloud.notes[note.id] = RemoteNote(
            id: note.id,
            title: note.title,
            body: note.body,
            colorIndex: 0,
            updatedAt: note.updatedAt.addingTimeInterval(30),
            deletedAt: note.updatedAt.addingTimeInterval(30)
        )
        await rig.engine.run()
        #expect(rig.ideas.notes.isEmpty)
    }

    @Test func inspirationLinkImportsOnce() async throws {
        let rig = try makeRig()
        #expect(rig.ideas.addInspiration(urlText: "youtube.com/watch?v=9"))
        await rig.engine.run()
        #expect(rig.cloud.links.map(\.host) == ["youtube.com"])
        await rig.engine.run()
        #expect(rig.cloud.links.count == 1)
    }

    @Test func cellularMovesEverything() async throws {
        // iOS Settings owns the cellular switch, so the engine treats a
        // cellular path like any other connection.
        let rig = try makeRig()
        rig.engine.network = .cellular
        let recording = try ingestClip(rig)
        rig.ideas.openEditor()
        rig.ideas.draft?.body = "typed on the train"
        let note = rig.ideas.saveDraft()!
        await rig.engine.run()
        #expect(rig.cloud.uploads == [recording.fileName])
        #expect(rig.cloud.notes[note.id] != nil)
    }

    @Test func inspirationMediaUploadsOnce() async throws {
        // The bytes sit under Application Support, whose name carries a
        // space: the engine reads their size off the URL, not a path string.
        let rig = try makeRig()
        rig.ideas.addInspiration(mediaData: Data(repeating: 3, count: 64), isVideo: false)
        await rig.engine.run()
        #expect(rig.cloud.uploads.count == 1)
        await rig.engine.run()
        #expect(rig.cloud.uploads.count == 1)
    }

    @Test func offlineMovesNothing() async throws {
        let rig = try makeRig()
        rig.engine.network = .offline
        _ = try ingestClip(rig)
        rig.ideas.openEditor()
        rig.ideas.draft?.body = "typed in a tunnel"
        let note = rig.ideas.saveDraft()!
        await rig.engine.run()
        #expect(rig.cloud.uploads.isEmpty)
        #expect(rig.cloud.notes[note.id] == nil)
    }
}

@Suite struct FileURLTests {
    /// The app's own container sits under "Application Support", so a path
    /// with a space in it is the normal case, not the edge one.
    func spacedDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "Application Support \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    @Test func bytesReadThroughASpacedPath() throws {
        let file = try spacedDirectory().appending(path: "clip.mov")
        try Data(repeating: 7, count: 512).write(to: file)
        #expect(file.fileByteCount == 512)
        #expect(FileManager.default.fileExists(atPath: file.localPath))
    }

    @Test func missingAndEmptyFilesReadAsNoBytes() throws {
        let directory = try spacedDirectory()
        let empty = directory.appending(path: "empty.mov")
        try Data().write(to: empty)
        #expect(empty.fileByteCount == nil)
        #expect(directory.appending(path: "gone.mov").fileByteCount == nil)
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
        // A note nobody titled carries no title, so the prompter never reads
        // a stand-in out loud.
        #expect(note?.title == "")
        #expect(note?.script == "Hey there this is cool")
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

    @Test func scriptIsWhatTheNoteSays() {
        // The title names the note; the prompter reads what is written in it.
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

@Suite struct AnalyticsSummaryTests {
    // Three days over two sources (one DB, one posthog); day two never got
    // extracted. User A signed up before the window and works daily; user B
    // signed up on day two and only opened the app on day three.
    func rollup(billing: AnalyticsRollup.Billing? = nil) -> AnalyticsRollup {
        AnalyticsRollup(
            generatedAt: "2026-08-21T04:00:00.000Z",
            days: ["2026-08-18", "2026-08-19", "2026-08-20"],
            sources: ["renders", "posthog"],
            missing: [.init(day: "2026-08-19")],
            billing: billing,
            users: [
                .init(registeredAt: "2026-08-01T10:00:00.000Z", balanceMicros: "3000000", activity: [1, 0, 3]),
                .init(registeredAt: "2026-08-19T12:00:00.000Z", balanceMicros: "500000", activity: [0, 0, 2]),
            ]
        )
    }

    @Test func derivesCountsAndSkipsMissingDays() {
        let summary = AnalyticsSummary(rollup: rollup())
        #expect(summary.registered == 2)
        #expect(summary.points.count == 3)
        #expect(summary.points[0].active == 1)
        #expect(summary.points[0].working == 1)
        #expect(summary.points[1].active == nil)
        #expect(summary.points[2].active == 2)
        #expect(summary.points[2].working == 1)
        #expect(summary.missingDayCount == 1)
        #expect(summary.activeYesterday == 2)
        #expect(summary.active7d == 2)
    }

    @Test func signupsAndTotalsCarryThePreWindowBase() {
        let summary = AnalyticsSummary(rollup: rollup())
        #expect(summary.points.map(\.signups) == [0, 1, 0])
        #expect(summary.points.map(\.totalRegistered) == [1, 2, 2])
        #expect(summary.signups7d == 1)
        #expect(summary.balanceDollars == 3.5)
    }

    @Test func billingRidesIntoRevenue() {
        let billing = AnalyticsRollup.Billing(
            subscribers: 4,
            canceling: 1,
            funded: 6,
            fundedMicros: "120000000",
            revenue: [
                .init(proMicros: "10000000", topupMicros: "0"),
                .init(proMicros: "0", topupMicros: "5000000"),
                .init(proMicros: "0", topupMicros: "0"),
            ]
        )
        let summary = AnalyticsSummary(rollup: rollup(billing: billing))
        #expect(summary.subscribers == 4)
        #expect(summary.fundedDollars == 120)
        #expect(summary.revenueDollars == 15)
        #expect(summary.points[0].proDollars == 10)
        #expect(summary.points[1].topupDollars == 5)
    }

    @Test func billinglessRollupLeavesRevenueUnknown() {
        let summary = AnalyticsSummary(rollup: rollup())
        #expect(summary.revenueDollars == nil)
        #expect(summary.subscribers == nil)
    }
}

@Suite struct UserProfileDecodingTests {
    @Test func profileCachedBeforeRoleFieldDecodesAsRegular() throws {
        let data = Data(#"{"id":"u1","name":"Dana","email":"dana@example.com"}"#.utf8)
        let profile = try JSONDecoder().decode(UserProfile.self, from: data)
        #expect(profile.superUser == false)
    }

    @Test func superUserRoundTrips() throws {
        let profile = UserProfile(id: "u1", name: "Dana", email: "dana@example.com", superUser: true)
        let decoded = try JSONDecoder().decode(UserProfile.self, from: JSONEncoder().encode(profile))
        #expect(decoded.superUser)
    }

    @Test func profileCachedBeforePhotoFieldDecodesWithoutOne() throws {
        let data = Data(#"{"id":"u1","name":"Dana","email":"dana@example.com"}"#.utf8)
        let profile = try JSONDecoder().decode(UserProfile.self, from: data)
        #expect(profile.imageURL == nil)
    }

    @Test func photoRoundTrips() throws {
        let url = URL(string: "https://lh3.googleusercontent.com/a/photo")
        let profile = UserProfile(id: "u1", name: "Dana", email: "dana@example.com", imageURL: url)
        let decoded = try JSONDecoder().decode(UserProfile.self, from: JSONEncoder().encode(profile))
        #expect(decoded.imageURL == url)
    }
}
