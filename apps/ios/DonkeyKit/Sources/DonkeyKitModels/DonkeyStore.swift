import Foundation
import SwiftData

// Persistence stays at the edge: these SwiftData records never leave this
// file, and the rest of the app talks to the plain structs the repository
// methods return. The sync journal lives here too — which rows are synced,
// which notes are dirty, and the tombstones deletes leave — so an upload
// interrupted by an app kill resumes from disk on the next launch.

@Model
final class NoteRecord {
    @Attribute(.unique) var id: UUID
    var title: String
    var body: String
    var colorIndex: Int
    var createdAt: Date
    /// Last edit, the sync's last-writer-wins clock. Older rows carry nil and
    /// read as their creation time.
    var updatedAt: Date?
    /// Locally edited and not yet pushed. Older rows carry nil (dirty), so a
    /// note from before sync existed gets pushed once.
    var dirty: Bool?

    init(_ note: Note, dirty: Bool) {
        id = note.id
        title = note.title
        body = note.body
        colorIndex = note.color.rawValue
        createdAt = note.createdAt
        updatedAt = note.updatedAt
        self.dirty = dirty
    }

    var note: Note {
        Note(
            id: id,
            title: title,
            body: body,
            color: NoteColor(rawValue: colorIndex) ?? .butter,
            createdAt: createdAt,
            updatedAt: updatedAt ?? createdAt
        )
    }
}

@Model
final class InspirationRecord {
    @Attribute(.unique) var id: UUID
    var linkURL: String?
    var mediaFileName: String?
    var isVideo: Bool
    var createdAt: Date
    /// Cloud library asset id once a media item has synced.
    var remoteAssetId: String?
    /// When a link's cloud-side import was queued.
    var linkSyncedAt: Date?

    init(id: UUID, linkURL: String?, mediaFileName: String?, isVideo: Bool, createdAt: Date) {
        self.id = id
        self.linkURL = linkURL
        self.mediaFileName = mediaFileName
        self.isVideo = isVideo
        self.createdAt = createdAt
    }

    var item: InspirationItem? {
        if let linkURL, let url = URL(string: linkURL) {
            return InspirationItem(id: id, kind: .link(url), createdAt: createdAt)
        }
        if let mediaFileName {
            return InspirationItem(id: id, kind: .media(fileName: mediaFileName, isVideo: isVideo), createdAt: createdAt)
        }
        return nil
    }
}

@Model
final class RecordingRecord {
    @Attribute(.unique) var id: UUID
    var fileName: String
    var thumbnailFileName: String?
    var duration: TimeInterval
    var createdAt: Date
    /// Cloud library asset id once the clip has synced.
    var remoteAssetId: String?
    /// The upload name the cloud claimed at presign time. An interrupted
    /// upload resumes under it instead of claiming a twin.
    var claimedFileName: String?

    init(_ recording: Recording) {
        id = recording.id
        fileName = recording.fileName
        thumbnailFileName = recording.thumbnailFileName
        duration = recording.duration
        createdAt = recording.createdAt
    }

    var recording: Recording {
        Recording(id: id, fileName: fileName, thumbnailFileName: thumbnailFileName, duration: duration, createdAt: createdAt)
    }
}

/// A delete waiting to replay against the cloud.
@Model
final class TombstoneRecord {
    @Attribute(.unique) var id: UUID
    var kind: String
    var remoteId: String
    var stamp: Date

    init(kind: String, remoteId: String, stamp: Date) {
        id = UUID()
        self.kind = kind
        self.remoteId = remoteId
        self.stamp = stamp
    }

    var tombstone: SyncTombstone? {
        guard let kind = SyncTombstone.Kind(rawValue: kind) else { return nil }
        return SyncTombstone(id: id, kind: kind, remoteId: remoteId, stamp: stamp)
    }
}

/// One store behind the repository seams: SwiftData for metadata, plain
/// files under Application Support for movie/media bytes.
public final class DonkeyStore: IdeasStoring, RecordingStoring, SyncJournalStoring {
    private let container: ModelContainer
    private let context: ModelContext
    private let mediaDirectory: URL
    private let recordingsDirectory: URL

    public init(inMemory: Bool = false) throws {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        mediaDirectory = root.appending(path: "Inspiration", directoryHint: .isDirectory)
        recordingsDirectory = root.appending(path: "Recordings", directoryHint: .isDirectory)
        for directory in [mediaDirectory, recordingsDirectory] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let schema = Schema([NoteRecord.self, InspirationRecord.self, RecordingRecord.self, TombstoneRecord.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory)
        container = try ModelContainer(for: schema, configurations: [configuration])
        context = ModelContext(container)
    }

    // MARK: IdeasStoring

    public func loadNotes() throws -> [Note] {
        let descriptor = FetchDescriptor<NoteRecord>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        return try context.fetch(descriptor).map(\.note)
    }

    public func upsert(_ note: Note) throws {
        let id = note.id
        let descriptor = FetchDescriptor<NoteRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            existing.title = note.title
            existing.body = note.body
            existing.colorIndex = note.color.rawValue
            existing.updatedAt = note.updatedAt
            existing.dirty = true
        } else {
            context.insert(NoteRecord(note, dirty: true))
        }
        try context.save()
    }

    public func deleteNote(id: UUID) throws {
        try context.delete(model: NoteRecord.self, where: #Predicate { $0.id == id })
        context.insert(TombstoneRecord(kind: SyncTombstone.Kind.note.rawValue, remoteId: id.uuidString, stamp: .now))
        try context.save()
    }

    public func loadInspiration() throws -> [InspirationItem] {
        let descriptor = FetchDescriptor<InspirationRecord>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        return try context.fetch(descriptor).compactMap(\.item)
    }

    public func addLink(_ url: URL) throws -> InspirationItem {
        let record = InspirationRecord(id: UUID(), linkURL: url.absoluteString, mediaFileName: nil, isVideo: false, createdAt: .now)
        context.insert(record)
        try context.save()
        return InspirationItem(id: record.id, kind: .link(url), createdAt: record.createdAt)
    }

    public func addMedia(data: Data, isVideo: Bool) throws -> InspirationItem {
        let id = UUID()
        let fileName = id.uuidString + (isVideo ? ".mov" : ".jpg")
        try data.write(to: mediaDirectory.appending(path: fileName), options: .atomic)
        let record = InspirationRecord(id: id, linkURL: nil, mediaFileName: fileName, isVideo: isVideo, createdAt: .now)
        context.insert(record)
        try context.save()
        return InspirationItem(id: id, kind: .media(fileName: fileName, isVideo: isVideo), createdAt: record.createdAt)
    }

    public func deleteInspiration(id: UUID) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        if let record = try context.fetch(descriptor).first {
            if let fileName = record.mediaFileName {
                try? FileManager.default.removeItem(at: mediaDirectory.appending(path: fileName))
            }
            if let remote = record.remoteAssetId {
                context.insert(TombstoneRecord(kind: SyncTombstone.Kind.libraryAsset.rawValue, remoteId: remote, stamp: .now))
            }
            context.delete(record)
            try context.save()
        }
    }

    public func mediaURL(fileName: String) -> URL {
        mediaDirectory.appending(path: fileName)
    }

    // MARK: RecordingStoring

    public func loadRecordings() throws -> [Recording] {
        let descriptor = FetchDescriptor<RecordingRecord>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        return try context.fetch(descriptor).map(\.recording)
    }

    public func ingest(movieAt url: URL, duration: TimeInterval, thumbnail: Data?) throws -> Recording {
        let id = UUID()
        let fileName = id.uuidString + "." + (url.pathExtension.isEmpty ? "mov" : url.pathExtension)
        try FileManager.default.moveItem(at: url, to: recordingsDirectory.appending(path: fileName))
        var thumbnailFileName: String?
        if let thumbnail {
            let name = id.uuidString + ".thumb.jpg"
            try thumbnail.write(to: recordingsDirectory.appending(path: name), options: .atomic)
            thumbnailFileName = name
        }
        let recording = Recording(id: id, fileName: fileName, thumbnailFileName: thumbnailFileName, duration: duration)
        context.insert(RecordingRecord(recording))
        try context.save()
        return recording
    }

    public func deleteRecording(_ recording: Recording) throws {
        try? FileManager.default.removeItem(at: movieURL(for: recording))
        if let thumbnailURL = thumbnailURL(for: recording) {
            try? FileManager.default.removeItem(at: thumbnailURL)
        }
        let id = recording.id
        let descriptor = FetchDescriptor<RecordingRecord>(predicate: #Predicate { $0.id == id })
        if let record = try context.fetch(descriptor).first {
            if let remote = record.remoteAssetId {
                context.insert(TombstoneRecord(kind: SyncTombstone.Kind.libraryAsset.rawValue, remoteId: remote, stamp: .now))
            }
            context.delete(record)
        }
        try context.save()
    }

    public func movieURL(for recording: Recording) -> URL {
        recordingsDirectory.appending(path: recording.fileName)
    }

    public func thumbnailURL(for recording: Recording) -> URL? {
        recording.thumbnailFileName.map { recordingsDirectory.appending(path: $0) }
    }

    // MARK: SyncJournalStoring

    public func dirtyNotes() throws -> [Note] {
        let descriptor = FetchDescriptor<NoteRecord>(sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).filter { $0.dirty ?? true }.map(\.note)
    }

    public func applyRemoteNote(_ note: Note) throws {
        let id = note.id
        let descriptor = FetchDescriptor<NoteRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            guard existing.dirty != true else { return }
            existing.title = note.title
            existing.body = note.body
            existing.colorIndex = note.color.rawValue
            existing.updatedAt = note.updatedAt
            existing.dirty = false
        } else {
            context.insert(NoteRecord(note, dirty: false))
        }
        try context.save()
    }

    public func clearNoteDirty(id: UUID, ifUpdatedAt stamp: Date) throws {
        let descriptor = FetchDescriptor<NoteRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        guard (record.updatedAt ?? record.createdAt) == stamp else { return }
        record.dirty = false
        try context.save()
    }

    public func removeNoteFromCloudDelete(id: UUID) throws {
        try context.delete(model: NoteRecord.self, where: #Predicate { $0.id == id })
        try context.save()
    }

    public func recordingRemote(_ id: UUID) throws -> (assetId: String?, claimedFileName: String?) {
        let descriptor = FetchDescriptor<RecordingRecord>(predicate: #Predicate { $0.id == id })
        let record = try context.fetch(descriptor).first
        return (record?.remoteAssetId, record?.claimedFileName)
    }

    @discardableResult
    public func setRecordingRemote(_ id: UUID, assetId: String?, claimedFileName: String?) throws -> Bool {
        let descriptor = FetchDescriptor<RecordingRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else {
            // The recording was deleted while its upload was in flight, so
            // the delete had no asset id to tombstone. The finished upload
            // reports one here; tombstone it so the cloud copy goes too.
            if let assetId {
                context.insert(TombstoneRecord(kind: SyncTombstone.Kind.libraryAsset.rawValue, remoteId: assetId, stamp: .now))
                try context.save()
            }
            return false
        }
        record.remoteAssetId = assetId
        record.claimedFileName = claimedFileName
        try context.save()
        return true
    }

    public func inspirationRemoteAssetId(_ id: UUID) throws -> String? {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        return try context.fetch(descriptor).first?.remoteAssetId
    }

    public func isInspirationLinkSynced(_ id: UUID) throws -> Bool {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        return try context.fetch(descriptor).first?.linkSyncedAt != nil
    }

    public func markInspirationMediaSynced(_ id: UUID, remoteAssetId: String) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.remoteAssetId = remoteAssetId
        try context.save()
    }

    public func markInspirationLinkSynced(_ id: UUID) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.linkSyncedAt = .now
        try context.save()
    }

    public func tombstones() throws -> [SyncTombstone] {
        let descriptor = FetchDescriptor<TombstoneRecord>(sortBy: [SortDescriptor(\.stamp)])
        return try context.fetch(descriptor).compactMap(\.tombstone)
    }

    public func removeTombstone(id: UUID) throws {
        try context.delete(model: TombstoneRecord.self, where: #Predicate { $0.id == id })
        try context.save()
    }
}
