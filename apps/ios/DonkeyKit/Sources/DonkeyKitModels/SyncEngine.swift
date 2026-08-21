import Foundation

// The phone's side of sync. One engine owns every queue — recordings up,
// inspiration up, notes both ways, deletes replayed — against a journal the
// store persists, so nothing depends on the app staying open: whatever was
// mid-flight when the app died is picked up from the journal on the next
// kick. Every byte moves at most once, and it moves on whatever connection
// the phone has: iOS Settings owns the per-app cellular switch.

nonisolated public struct SyncTombstone: Equatable, Sendable, Identifiable {
    nonisolated public enum Kind: String, Sendable {
        /// A synced note deleted here; the cloud keeps a tombstone row.
        case note
        /// A synced recording or inspiration item deleted here; the cloud
        /// asset goes with it.
        case libraryAsset
    }

    public var id: UUID
    public var kind: Kind
    /// The cloud id: the note's UUID string, or the library asset id.
    public var remoteId: String
    public var stamp: Date

    public init(id: UUID = UUID(), kind: Kind, remoteId: String, stamp: Date = .now) {
        self.id = id
        self.kind = kind
        self.remoteId = remoteId
        self.stamp = stamp
    }
}

/// What the engine reads and writes in the store beyond the records
/// themselves: which items are synced, which notes are dirty, and the
/// tombstones deletes leave behind. DonkeyStore conforms.
public protocol SyncJournalStoring: AnyObject {
    // Notes: local edits mark rows dirty; the merge writes clean rows.
    func dirtyNotes() throws -> [Note]
    /// Upsert a note the cloud won with, clean. Never touches a dirty row —
    /// a local edit outranks the pull that raced it.
    func applyRemoteNote(_ note: Note) throws
    /// Clear a note's dirty flag after a push, only if it still carries the
    /// stamp that was pushed — an edit made mid-push stays dirty.
    func clearNoteDirty(id: UUID, ifUpdatedAt: Date) throws
    /// Remove a note the cloud deleted. No tombstone: the delete came down.
    func removeNoteFromCloudDelete(id: UUID) throws

    // Recordings
    func recordingRemote(_ id: UUID) throws -> (assetId: String?, claimedFileName: String?)
    /// Journal a recording's cloud copy. Returns false when the row is gone —
    /// deleted while the bytes were in flight — in which case the store
    /// leaves a libraryAsset tombstone for `assetId`, so the replay takes the
    /// fresh cloud copy down with it.
    @discardableResult
    func setRecordingRemote(_ id: UUID, assetId: String?, claimedFileName: String?) throws -> Bool

    // Inspiration
    func inspirationRemoteAssetId(_ id: UUID) throws -> String?
    func isInspirationLinkSynced(_ id: UUID) throws -> Bool
    func markInspirationMediaSynced(_ id: UUID, remoteAssetId: String) throws
    func markInspirationLinkSynced(_ id: UUID) throws

    // Tombstones
    func tombstones() throws -> [SyncTombstone]
    func removeTombstone(id: UUID) throws
}

@Observable
public final class SyncEngine {
    /// The account is out of cloud storage. The Library banner reads this;
    /// media uploads pause while it holds.
    public private(set) var storageFull = false
    /// The current network, reported by the app target's path monitor.
    public var network: NetworkPath = .offline {
        didSet { if network != oldValue, network != .offline { kick() } }
    }

    /// Live upload progress per recording, layered over the journal.
    private var uploadStates: [UUID: RecordingSyncState] = [:]
    private var uploading: Set<UUID> = []

    public weak var media: MediaModel?
    public weak var ideas: IdeasModel?

    private let journal: any SyncJournalStoring
    private let service: any CloudSyncServicing
    private let signedIn: () -> Bool
    /// Reads a recording's upload payload (bytes, dimensions, poster) off the
    /// file; the app target implements it with AVFoundation.
    private let uploadFor: (Recording) async -> LibraryUpload?
    private var running = false
    private var runAgain = false
    /// A pass that ends with work still queued books its own next try, so a
    /// timeout or a 5xx costs a wait instead of stranding the clip until the
    /// app is next launched. Doubles until the ceiling, resets on a clean pass.
    @ObservationIgnored private var retryDelay = SyncEngine.firstRetry
    @ObservationIgnored private var retryScheduled = false
    /// Recordings whose bytes could not be read. They stop counting as queued
    /// work, and the loop stops re-probing them. A read can also fail because
    /// the file was momentarily out of reach — offloaded storage, a move the
    /// library had not finished settling — so the set clears whenever a new
    /// recording lands, which is a point where the library has demonstrably
    /// changed and the stranded takes deserve another look.
    @ObservationIgnored private var unreadable: Set<UUID> = []
    private static let firstRetry: Duration = .seconds(15)
    private static let retryCeiling: Duration = .seconds(300)

    public init(
        journal: any SyncJournalStoring,
        service: any CloudSyncServicing,
        signedIn: @escaping () -> Bool,
        uploadFor: @escaping (Recording) async -> LibraryUpload?
    ) {
        self.journal = journal
        self.service = service
        self.signedIn = signedIn
        self.uploadFor = uploadFor
    }

    /// Journal answers memoized per recording, so a badge read is a set
    /// lookup instead of a SwiftData fetch per visible card. The engine is
    /// the journal's only writer, so it refreshes these on its own writes.
    @ObservationIgnored private var syncedIds: Set<UUID> = []
    @ObservationIgnored private var checkedIds: Set<UUID> = []

    /// The badge state the Library shows for a recording.
    public func state(for recording: Recording) -> RecordingSyncState {
        if let live = uploadStates[recording.id] { return live }
        if syncedIds.contains(recording.id) { return .synced }
        if checkedIds.contains(recording.id) { return .onDevice }
        checkedIds.insert(recording.id)
        guard (try? journal.recordingRemote(recording.id))?.assetId != nil else { return .onDevice }
        syncedIds.insert(recording.id)
        return .synced
    }

    /// Something changed — a new recording, a note edit, the network, a
    /// sign-in. One runner drains every queue; a kick during a run schedules
    /// one more pass so nothing lands between checks.
    public func kick() {
        guard signedIn(), network != .offline else { return }
        if running {
            runAgain = true
            return
        }
        running = true
        Task { [weak self] in
            await self?.run()
        }
    }

    /// One full pass over every queue. kick() is the entry point; tests call
    /// this directly to drain synchronously.
    func run() async {
        defer {
            running = false
            if runAgain {
                runAgain = false
                kick()
            } else {
                scheduleRetry()
            }
        }
        await replayTombstones()
        await syncNotes()
        // Link imports are small payloads, so they queue ahead of the media.
        await uploadPendingInspirationLinks()
        guard online else { return }
        await refreshStorage()
        guard !storageFull else { return }
        await uploadPendingRecordings()
        await uploadPendingInspirationMedia()
    }

    private var online: Bool {
        network != .offline
    }

    private func scheduleRetry() {
        guard signedIn(), online, !storageFull, pendingWork else {
            retryDelay = Self.firstRetry
            return
        }
        guard !retryScheduled else { return }
        retryScheduled = true
        let delay = retryDelay
        retryDelay = min(delay * 2, Self.retryCeiling)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.retryScheduled = false
            self?.kick()
        }
    }

    /// Anything the journal still owes the cloud after a pass.
    private var pendingWork: Bool {
        if !(((try? journal.tombstones()) ?? []).isEmpty) { return true }
        if !(((try? journal.dirtyNotes()) ?? []).isEmpty) { return true }
        if (media?.recordings ?? []).contains(where: {
            !unreadable.contains($0.id) && ((try? journal.recordingRemote($0.id))?.assetId) == nil
        }) { return true }
        return (ideas?.inspiration ?? []).contains { item in
            switch item.kind {
            case .link: ((try? journal.isInspirationLinkSynced(item.id)) ?? true) == false
            case .media: ((try? journal.inspirationRemoteAssetId(item.id)) ?? nil) == nil
            }
        }
    }

    // MARK: Deletes

    private func replayTombstones() async {
        for tombstone in (try? journal.tombstones()) ?? [] {
            do {
                switch tombstone.kind {
                case .note:
                    guard let id = UUID(uuidString: tombstone.remoteId) else { break }
                    try await service.deleteNote(id: id)
                case .libraryAsset:
                    try await service.deleteLibraryAsset(id: tombstone.remoteId)
                }
                try? journal.removeTombstone(id: tombstone.id)
                // Freed bytes may reopen a full account.
                if tombstone.kind == .libraryAsset { storageFull = false }
            } catch CloudSyncError.unauthorized {
                return
            } catch {
                // Transient; the tombstone stays for the next kick.
            }
        }
    }

    // MARK: Notes (two-way, last writer wins)

    private func syncNotes() async {
        guard online else { return }
        // Push local edits first so the pull that follows can't overwrite them.
        for note in (try? journal.dirtyNotes()) ?? [] {
            do {
                let won = try await service.putNote(
                    RemoteNote(
                        id: note.id,
                        title: note.title,
                        body: note.body,
                        colorIndex: note.color.rawValue,
                        updatedAt: note.updatedAt,
                        createdAt: note.createdAt
                    )
                )
                try? journal.clearNoteDirty(id: note.id, ifUpdatedAt: note.updatedAt)
                if won.updatedAt > note.updatedAt {
                    try? journal.applyRemoteNote(localNote(from: won))
                }
            } catch CloudSyncError.unauthorized {
                return
            } catch {
                // Transient; stays dirty.
            }
        }
        do {
            let remote = try await service.fetchNotes()
            try mergeRemoteNotes(remote)
            ideas?.reloadFromStore()
        } catch {
            // The next kick pulls again.
        }
    }

    private func mergeRemoteNotes(_ remote: [RemoteNote]) throws {
        let localById = Dictionary(
            uniqueKeysWithValues: (ideas?.notes ?? []).map { ($0.id, $0) }
        )
        let pendingDeletes = Set(
            ((try? journal.tombstones()) ?? [])
                .filter { $0.kind == .note }
                .compactMap { UUID(uuidString: $0.remoteId) }
        )
        for note in remote {
            if pendingDeletes.contains(note.id) { continue }
            if note.deletedAt != nil {
                // The cloud deleted it; a newer local edit revives instead.
                if let local = localById[note.id], local.updatedAt <= note.updatedAt {
                    try journal.removeNoteFromCloudDelete(id: note.id)
                }
                continue
            }
            let local = localById[note.id]
            if local == nil || note.updatedAt > local!.updatedAt {
                try journal.applyRemoteNote(localNote(from: note))
            }
        }
    }

    private func localNote(from remote: RemoteNote) -> Note {
        Note(
            id: remote.id,
            title: remote.title,
            body: remote.body,
            color: NoteColor(rawValue: remote.colorIndex) ?? .butter,
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt
        )
    }

    // MARK: Recordings

    /// A finished recording heads for the cloud at once (policy permitting).
    public func recordingAdded(_ recording: Recording) {
        unreadable.removeAll()
        kick()
    }

    private func uploadPendingRecordings() async {
        for recording in media?.recordings ?? [] {
            guard online, !storageFull else { return }
            let remote = try? journal.recordingRemote(recording.id)
            guard remote?.assetId == nil,
                  !uploading.contains(recording.id),
                  !unreadable.contains(recording.id) else { continue }
            guard var upload = await uploadFor(recording) else {
                unreadable.insert(recording.id)
                continue
            }
            upload.resume = remote?.claimedFileName != nil
            if let claimed = remote?.claimedFileName { upload.fileName = claimed }
            uploading.insert(recording.id)
            uploadStates[recording.id] = .uploading(percent: 0)
            defer { uploading.remove(recording.id) }
            do {
                let asset = try await service.uploadLibraryMedia(upload) { [weak self] fraction in
                    Task { @MainActor [weak self] in
                        self?.setUploadProgress(recording.id, fraction)
                    }
                }
                let journaled = ((try? journal.setRecordingRemote(recording.id, assetId: asset.id, claimedFileName: asset.fileName)) ?? false)
                if journaled {
                    uploadStates[recording.id] = .synced
                    syncedIds.insert(recording.id)
                    checkedIds.remove(recording.id)
                } else {
                    // Deleted mid-upload: the journal left a tombstone for
                    // the fresh asset; another pass replays it.
                    uploadStates[recording.id] = nil
                    kick()
                }
                storageFull = false
            } catch CloudSyncError.storageFull {
                uploadStates[recording.id] = nil
                // Remember the claim if one was minted before the refusal —
                // the retry resumes under the same name.
                _ = try? journal.setRecordingRemote(recording.id, assetId: nil, claimedFileName: upload.resume ? upload.fileName : nil)
                storageFull = true
                return
            } catch CloudSyncError.unauthorized {
                uploadStates[recording.id] = nil
                return
            } catch {
                // Transient: keep the claim so the retry resumes, drop the bar.
                uploadStates[recording.id] = nil
                _ = try? journal.setRecordingRemote(recording.id, assetId: nil, claimedFileName: upload.fileName)
            }
        }
    }

    private func setUploadProgress(_ id: UUID, _ fraction: Double) {
        guard uploading.contains(id) else { return }
        uploadStates[id] = .uploading(percent: Int((fraction * 100).rounded()))
    }

    // MARK: Inspiration

    private func uploadPendingInspirationLinks() async {
        for item in ideas?.inspiration ?? [] {
            guard case .link(let url) = item.kind else { continue }
            guard online else { continue }
            guard ((try? journal.isInspirationLinkSynced(item.id)) ?? true) == false else { continue }
            do {
                try await service.importInspirationLink(url)
                try? journal.markInspirationLinkSynced(item.id)
            } catch CloudSyncError.unauthorized {
                return
            } catch {
                // Transient or capped for the day; the next kick retries.
            }
        }
    }

    private func uploadPendingInspirationMedia() async {
        for item in ideas?.inspiration ?? [] {
            guard case .media(let fileName, let isVideo) = item.kind else { continue }
            guard online, !storageFull else { continue }
            guard ((try? journal.inspirationRemoteAssetId(item.id)) ?? nil) == nil else { continue }
            guard let fileURL = ideas?.mediaURL(fileName: fileName),
                  let bytes = fileURL.fileByteCount else { continue }
            let upload = LibraryUpload(
                fileURL: fileURL,
                fileName: fileName,
                mime: isVideo ? "video/quicktime" : "image/jpeg",
                bytes: bytes,
                name: fileName,
                type: isVideo ? "video" : "image",
                duration: 0,
                origin: "inspiration",
                resume: true
            )
            do {
                let asset = try await service.uploadLibraryMedia(upload, progress: { _ in })
                try? journal.markInspirationMediaSynced(item.id, remoteAssetId: asset.id)
                storageFull = false
            } catch CloudSyncError.storageFull {
                storageFull = true
                return
            } catch CloudSyncError.unauthorized {
                return
            } catch {
                // Transient; retried on the next kick.
            }
        }
    }

    // MARK: Storage

    private func refreshStorage() async {
        guard let usage = try? await service.fetchUsage() else { return }
        storageFull = usage.isFull
    }
}
