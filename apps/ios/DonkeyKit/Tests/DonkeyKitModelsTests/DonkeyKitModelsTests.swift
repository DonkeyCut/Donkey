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
        /// The shelf itself: what an upload or an import put there, and the
        /// tombstones deletes leave — the same two lists the API answers with.
        var libraryAssets: Set<String> = []
        var deletedLibraryIds: Set<String> = []
        var deletedNotes: [UUID] = []
        var links: [URL] = []
        var polled: [String] = []
        var downloads: [String] = []
        var folders: [UUID: RemoteNoteFolder] = [:]
        var deletedFolders: [UUID] = []
        /// Whether the listing carries a folders key at all. A site that
        /// predates folders answers without one.
        var reportsFolders = true
        /// What an import job answers with once it is asked about.
        var imported: JobOutcome<ImportedLink> = .done(
            ImportedLink(assetId: "asset-link", fileName: "source.mp4", isVideo: true)
        )
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
            let asset = try uploadResult.get()
            libraryAssets.insert(asset.id)
            deletedLibraryIds.remove(asset.id)
            return asset
        }

        func deleteLibraryAsset(id: String) async throws {
            deletedAssets.append(id)
            libraryAssets.remove(id)
            deletedLibraryIds.insert(id)
        }

        func fetchLibrary() async throws -> RemoteLibrary {
            RemoteLibrary(assetIds: libraryAssets, deletedIds: deletedLibraryIds)
        }

        func importInspirationLink(_ url: URL) async throws -> String {
            links.append(url)
            return "job-\(links.count)"
        }

        func importedLink(jobId: String) async throws -> JobOutcome<ImportedLink> {
            polled.append(jobId)
            if case .done(let link) = imported { libraryAssets.insert(link.assetId) }
            return imported
        }

        func downloadLibraryMedia(fileName: String, to destination: URL) async throws {
            downloads.append(fileName)
            try Data("media".utf8).write(to: destination)
        }

        func fetchUsage() async throws -> StorageUsage { usage }

        func fetchNotes() async throws -> RemoteNotes {
            RemoteNotes(
                notes: Array(notes.values),
                folders: reportsFolders ? Array(folders.values) : nil
            )
        }

        func putNote(_ note: RemoteNote) async throws -> RemoteNote {
            if let existing = notes[note.id], existing.updatedAt > note.updatedAt { return existing }
            notes[note.id] = note
            return note
        }

        func deleteNote(id: UUID) async throws {
            deletedNotes.append(id)
            notes[id] = nil
        }

        func putNoteFolder(_ folder: RemoteNoteFolder) async throws {
            folders[folder.id] = folder
        }

        func deleteNoteFolder(id: UUID) async throws {
            deletedFolders.append(id)
            folders[id] = nil
            for (noteId, note) in notes where note.folderId == id {
                notes[noteId]?.folderId = nil
                _ = noteId
            }
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

    @Test func cloudDeleteTakesTheClipOffThePhone() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        let movie = rig.media.movieURL(for: recording)
        await rig.engine.run()
        // Deleted at the desk: the shelf tombstones the asset.
        try await rig.cloud.deleteLibraryAsset(id: "asset-1")
        rig.cloud.deletedAssets.removeAll()
        await rig.engine.run()
        #expect(rig.media.recordings.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: movie.localPath))
        // The delete came down, so nothing goes back up for it.
        #expect(try rig.store.tombstones().isEmpty)
        #expect(rig.cloud.deletedAssets.isEmpty)
        #expect(rig.cloud.uploads.count == 1)
    }

    @Test func anAssetThatVanishedGoesBackUpInsteadOfLeaving() async throws {
        let rig = try makeRig()
        let recording = try ingestClip(rig)
        await rig.engine.run()
        // The storage sweep collected it: gone from the shelf with no
        // tombstone, which is not a delete anyone made.
        rig.cloud.libraryAssets.removeAll()
        await rig.engine.run()
        #expect(rig.media.recordings.map(\.id) == [recording.id])
        // The same pass that noticed puts the clip back on the shelf.
        #expect(rig.cloud.uploads.count == 2)
        #expect(rig.engine.state(for: recording) == .synced)
    }

    @Test func cloudDeleteTakesTheInspirationItemToo() async throws {
        let rig = try makeRig()
        rig.ideas.addInspiration(mediaData: Data(repeating: 3, count: 64), isVideo: false)
        await rig.engine.run()
        try await rig.cloud.deleteLibraryAsset(id: "asset-1")
        await rig.engine.run()
        #expect(rig.ideas.inspiration.isEmpty)
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

    @Test func inspirationLinkImportsOnceAndLandsItsMedia() async throws {
        let rig = try makeRig()
        #expect(rig.ideas.addInspiration(urlText: "youtube.com/watch?v=9"))
        await rig.engine.run()
        #expect(rig.cloud.links.map(\.host) == ["youtube.com"])
        // The queue pass only hands the link over; the next pass follows the
        // job and brings the media down.
        await rig.engine.run()
        #expect(rig.cloud.links.count == 1)
        #expect(rig.cloud.downloads == ["source.mp4"])
        let item = try #require(rig.ideas.inspiration.first)
        #expect(item.media?.isVideo == true)
        // Nothing is asked of the job again once its media is here.
        await rig.engine.run()
        #expect(rig.cloud.downloads.count == 1)
    }

    @Test func inspirationLinkWithNoMediaStaysALink() async throws {
        let rig = try makeRig()
        rig.cloud.imported = .failed
        #expect(rig.ideas.addInspiration(urlText: "example.com/article"))
        await rig.engine.run()
        await rig.engine.run()
        let item = try #require(rig.ideas.inspiration.first)
        #expect(item.media == nil)
        #expect(item.importState == .failed)
        #expect(rig.cloud.downloads.isEmpty)
    }

    @Test func folderPushesAheadOfTheNoteFiledInIt() async throws {
        let rig = try makeRig()
        let folder = try #require(rig.ideas.addFolder(named: "Scripts"))
        rig.ideas.openEditor(in: folder.id)
        rig.ideas.draft?.body = "filed"
        let note = try #require(rig.ideas.saveDraft())
        await rig.engine.run()
        #expect(rig.cloud.folders[folder.id]?.name == "Scripts")
        #expect(rig.cloud.notes[note.id]?.folderId == folder.id)
    }

    @Test func folderDeletedInTheCloudReleasesItsNotes() async throws {
        let rig = try makeRig()
        let folder = try #require(rig.ideas.addFolder(named: "Scripts"))
        rig.ideas.openEditor(in: folder.id)
        rig.ideas.draft?.body = "filed"
        let note = try #require(rig.ideas.saveDraft())
        await rig.engine.run()
        // Gone from the desktop: the listing no longer names it, which is the
        // only signal a folder delete has.
        rig.cloud.folders[folder.id] = nil
        rig.cloud.notes[note.id]?.folderId = nil
        rig.cloud.notes[note.id]?.updatedAt = note.updatedAt.addingTimeInterval(30)
        await rig.engine.run()
        #expect(rig.ideas.folders.isEmpty)
        #expect(rig.ideas.notes(in: nil).count == 1)
    }

    @Test func aListingWithoutFoldersKeepsTheOnesHere() async throws {
        let rig = try makeRig()
        let folder = try #require(rig.ideas.addFolder(named: "Scripts"))
        rig.ideas.openEditor(in: folder.id)
        rig.ideas.draft?.body = "filed"
        let note = try #require(rig.ideas.saveDraft())
        await rig.engine.run()
        // A site that does not speak folders answers without the key. Its
        // silence says nothing about folders, so this phone keeps its own —
        // an absent key is not an empty list.
        rig.cloud.reportsFolders = false
        await rig.engine.run()
        #expect(rig.ideas.folders.map(\.id) == [folder.id])
        #expect(rig.ideas.notes(in: folder.id).map(\.id) == [note.id])
    }

    @Test func folderDeletedHereReachesTheCloud() async throws {
        let rig = try makeRig()
        let folder = try #require(rig.ideas.addFolder(named: "Scripts"))
        await rig.engine.run()
        rig.ideas.deleteFolder(id: folder.id)
        await rig.engine.run()
        #expect(rig.cloud.deletedFolders == [folder.id])
        #expect(try rig.store.tombstones().isEmpty)
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
@Suite struct ProjectsListingTests {
    final class FakeProjects: CloudProjectsServicing {
        let remote: [RemoteProject]

        init(remote: [RemoteProject] = []) { self.remote = remote }

        func fetchProjects() async throws -> [RemoteProject] { remote }
        func fetchExports(projectId: String) async throws -> [RemoteExport] { [] }
        func startExport(projectId: String, preset: String) async throws -> String { "job" }
        func exportProgress(jobId: String) async throws -> RenderProgress { .done }
        func exportFile(jobId: String) async throws -> URL { URL(string: "https://example.com/e.mp4")! }
        func streamURL(project: RemoteProject, export: RemoteExport?) async throws -> URL {
            URL(string: "https://example.com/s.mp4")!
        }
        func thumbnailFile(for project: RemoteProject) async -> URL? { nil }
    }

    private func scratch() -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "projects-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    @Test func listingIsThereBeforeTheNetworkIs() async {
        let directory = scratch()
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = FakeProjects(remote: [
            RemoteProject(
                id: "p1",
                name: "Marketing is the new moat",
                duration: 26,
                updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
                hasPreview: true
            )
        ])
        let first = ProjectsModel(service: service, cacheDirectory: directory)
        await first.refresh()
        #expect(first.projects.count == 1)

        // A fresh launch: the listing is on screen with nothing asked of the
        // network yet.
        let next = ProjectsModel(service: service, cacheDirectory: directory)
        #expect(next.projects.map(\.id) == ["p1"])
        #expect(next.projects.first?.name == "Marketing is the new moat")
    }

    @Test func signingOutLeavesNothingForTheNextAccount() async {
        let directory = scratch()
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = FakeProjects(remote: [
            RemoteProject(id: "p1", name: "Mine", duration: 4, updatedAt: Date(), hasPreview: false)
        ])
        let model = ProjectsModel(service: service, cacheDirectory: directory)
        await model.refresh()
        model.forget()
        #expect(model.projects.isEmpty)
        #expect(ProjectsModel(service: service, cacheDirectory: directory).projects.isEmpty)
    }
}

@MainActor
@Suite struct AuthModelTests {
    final class FakeAuth: AuthServicing {
        var stored: StoredSession = .none
        var check: SessionCheck = .rejected
        var result: Result<UserProfile, any Error> = .failure(CancellationError())
        var checked = false

        func signIn(with provider: AuthProvider) async throws -> UserProfile {
            try result.get()
        }

        func storedSession() -> StoredSession { stored }
        func checkSession() async -> SessionCheck {
            checked = true
            return check
        }
        func signOut() async { stored = .none }
    }

    @Test func restoreWithoutSessionSignsOut() async {
        let model = AuthModel(service: FakeAuth())
        await model.restore()
        #expect(model.state == .signedOut)
    }

    @Test func cachedSessionIsSignedInBeforeAnythingIsChecked() {
        let service = FakeAuth()
        let profile = UserProfile(id: "1", name: "David", email: "d@example.com")
        service.stored = .cached(profile)
        let model = AuthModel(service: service)
        #expect(model.state == .signedIn(profile))
        #expect(service.checked == false)
    }

    @Test func sessionWithNoCachedProfileWaitsOnTheCheck() async {
        let service = FakeAuth()
        service.stored = .unknown
        let profile = UserProfile(id: "1", name: "David", email: "d@example.com")
        service.check = .valid(profile)
        let model = AuthModel(service: service)
        #expect(model.state == .restoring)
        await model.restore()
        #expect(model.state == .signedIn(profile))
    }

    @Test func unreachableServerKeepsTheCachedSession() async {
        let service = FakeAuth()
        let profile = UserProfile(id: "1", name: "David", email: "d@example.com")
        service.stored = .cached(profile)
        service.check = .unreachable
        let model = AuthModel(service: service)
        await model.restore()
        #expect(model.state == .signedIn(profile))
    }

    @Test func rejectedSessionSignsOut() async {
        let service = FakeAuth()
        service.stored = .cached(UserProfile(id: "1", name: "David", email: "d@example.com"))
        service.check = .rejected
        let model = AuthModel(service: service)
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
