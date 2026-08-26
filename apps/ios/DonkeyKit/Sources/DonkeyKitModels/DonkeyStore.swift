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
    /// The folder this note is filed in; nil is the top level.
    var folderId: UUID?
    /// The labels this note wears. Older rows carry nil and read as none.
    var labelIds: [UUID]?
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
        folderId = note.folderId
        labelIds = note.labelIds
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
            folderId: folderId,
            labelIds: labelIds ?? [],
            createdAt: createdAt,
            updatedAt: updatedAt ?? createdAt
        )
    }
}

/// A folder notes are filed in. Folders are few and small, so the whole set
/// pushes and pulls each pass; `dirty` marks one this phone changed.
@Model
final class NoteFolderRecord {
    @Attribute(.unique) var id: UUID
    var name: String
    var createdAt: Date
    var updatedAt: Date
    var dirty: Bool

    init(_ folder: NoteFolder, dirty: Bool) {
        id = folder.id
        name = folder.name
        createdAt = folder.createdAt
        updatedAt = folder.updatedAt
        self.dirty = dirty
    }

    var folder: NoteFolder {
        NoteFolder(id: id, name: name, createdAt: createdAt, updatedAt: updatedAt)
    }
}

/// A label notes wear. Labels are few and small like folders, so the whole
/// set pushes and pulls each pass; `dirty` marks one this phone changed.
@Model
final class NoteLabelRecord {
    @Attribute(.unique) var id: UUID
    var name: String
    var createdAt: Date
    var updatedAt: Date
    var dirty: Bool

    init(_ label: NoteLabel, dirty: Bool) {
        id = label.id
        name = label.name
        createdAt = label.createdAt
        updatedAt = label.updatedAt
        self.dirty = dirty
    }

    var label: NoteLabel {
        NoteLabel(id: id, name: name, createdAt: createdAt, updatedAt: updatedAt)
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
    /// The import job the worker is running for this link, while it runs.
    var importJobId: String?
    /// The media the cloud fetched for this link, on the account's shelf. The
    /// bytes stay there and the card streams them.
    var cloudFileName: String?
    var cloudIsVideo: Bool?
    /// The source's cover, downloaded here so the card paints without the
    /// network.
    var posterFileName: String?
    /// The source's own words, shown on the card.
    var sourceText: String?
    /// The source was only words: there is no media to stream and nothing to
    /// retry.
    var noMedia: Bool?
    /// Why the last attempt failed. Set while the card offers another try.
    var importError: String?
    /// The media's pixel size: the worker's probe for a fetched link, this
    /// phone's measurement for an import. The card's shape comes from it.
    var mediaWidth: Int?
    var mediaHeight: Int?

    init(id: UUID, linkURL: String?, mediaFileName: String?, isVideo: Bool, createdAt: Date) {
        self.id = id
        self.linkURL = linkURL
        self.mediaFileName = mediaFileName
        self.isVideo = isVideo
        self.createdAt = createdAt
    }

    var item: InspirationItem? {
        if let linkURL, let url = URL(string: linkURL) {
            let cloud = cloudFileName.map {
                InspirationCloudMedia(
                    assetId: remoteAssetId ?? "",
                    fileName: $0,
                    isVideo: cloudIsVideo ?? false,
                    posterFileName: posterFileName,
                    width: mediaWidth,
                    height: mediaHeight
                )
            }
            // Only a live job is fetching. A link the cloud took whose job
            // is gone — an import from a build that landed media differently,
            // a job that outlived its row — has nothing working on it, and the
            // card says so.
            let state: InspirationImport = if let importError {
                .failed(importError)
            } else if cloud != nil {
                .ready
            } else if noMedia == true {
                .noMedia
            } else if linkSyncedAt == nil {
                .queued
            } else if importJobId != nil {
                .fetching
            } else {
                .failed("The fetch didn't finish.")
            }
            return InspirationItem(
                id: id,
                kind: .link(url),
                createdAt: createdAt,
                cloud: cloud,
                sourceText: sourceText,
                importState: state
            )
        }
        if let mediaFileName {
            return InspirationItem(
                id: id,
                kind: .media(fileName: mediaFileName, isVideo: isVideo),
                createdAt: createdAt,
                importState: .ready,
                localWidth: mediaWidth,
                localHeight: mediaHeight
            )
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
        let schema = Schema([
            NoteRecord.self,
            NoteFolderRecord.self,
            NoteLabelRecord.self,
            InspirationRecord.self,
            RecordingRecord.self,
            TombstoneRecord.self,
        ])
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
            existing.folderId = note.folderId
            existing.labelIds = note.labelIds
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

    public func loadNoteFolders() throws -> [NoteFolder] {
        let descriptor = FetchDescriptor<NoteFolderRecord>(sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).map(\.folder)
    }

    public func upsert(_ folder: NoteFolder) throws {
        let id = folder.id
        let descriptor = FetchDescriptor<NoteFolderRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            existing.name = folder.name
            existing.updatedAt = folder.updatedAt
            existing.dirty = true
        } else {
            context.insert(NoteFolderRecord(folder, dirty: true))
        }
        try context.save()
    }

    public func deleteNoteFolder(id: UUID) throws {
        try context.delete(model: NoteFolderRecord.self, where: #Predicate { $0.id == id })
        // The notes stay; they come back to the top level, and each one is a
        // write of its own so the cloud files them there too.
        let descriptor = FetchDescriptor<NoteRecord>(predicate: #Predicate { $0.folderId == id })
        for record in try context.fetch(descriptor) {
            record.folderId = nil
            record.updatedAt = .now
            record.dirty = true
        }
        context.insert(TombstoneRecord(kind: SyncTombstone.Kind.noteFolder.rawValue, remoteId: id.uuidString, stamp: .now))
        try context.save()
    }

    public func loadNoteLabels() throws -> [NoteLabel] {
        let descriptor = FetchDescriptor<NoteLabelRecord>(sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).map(\.label)
    }

    public func upsert(_ label: NoteLabel) throws {
        let id = label.id
        let descriptor = FetchDescriptor<NoteLabelRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            existing.name = label.name
            existing.updatedAt = label.updatedAt
            existing.dirty = true
        } else {
            context.insert(NoteLabelRecord(label, dirty: true))
        }
        try context.save()
    }

    public func deleteNoteLabel(id: UUID) throws {
        try context.delete(model: NoteLabelRecord.self, where: #Predicate { $0.id == id })
        // Every note wearing the label lets it go, each as a write of its own
        // so the cloud copies follow.
        for record in try context.fetch(FetchDescriptor<NoteRecord>())
        where record.labelIds?.contains(id) == true {
            record.labelIds = record.labelIds?.filter { $0 != id }
            record.updatedAt = .now
            record.dirty = true
        }
        context.insert(TombstoneRecord(kind: SyncTombstone.Kind.noteLabel.rawValue, remoteId: id.uuidString, stamp: .now))
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
            removeFiles(of: record)
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
            existing.folderId = note.folderId
            existing.labelIds = note.labelIds
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

    public func dirtyNoteFolders() throws -> [NoteFolder] {
        let descriptor = FetchDescriptor<NoteFolderRecord>(sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).filter(\.dirty).map(\.folder)
    }

    public func applyRemoteNoteFolder(_ folder: NoteFolder) throws {
        let id = folder.id
        let descriptor = FetchDescriptor<NoteFolderRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            guard !existing.dirty else { return }
            existing.name = folder.name
            existing.updatedAt = folder.updatedAt
        } else {
            context.insert(NoteFolderRecord(folder, dirty: false))
        }
        try context.save()
    }

    public func clearNoteFolderDirty(id: UUID, ifUpdatedAt stamp: Date) throws {
        let descriptor = FetchDescriptor<NoteFolderRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first, record.updatedAt == stamp else { return }
        record.dirty = false
        try context.save()
    }

    /// Folder ids this phone holds that the cloud no longer lists, so they
    /// were deleted elsewhere. A folder still waiting to be pushed is not one
    /// of them.
    public func cleanNoteFolderIds() throws -> [UUID] {
        let descriptor = FetchDescriptor<NoteFolderRecord>()
        return try context.fetch(descriptor).filter { !$0.dirty }.map(\.id)
    }

    public func removeNoteFolderFromCloudDelete(id: UUID) throws {
        try context.delete(model: NoteFolderRecord.self, where: #Predicate { $0.id == id })
        let descriptor = FetchDescriptor<NoteRecord>(predicate: #Predicate { $0.folderId == id })
        for record in try context.fetch(descriptor) where record.dirty != true {
            record.folderId = nil
        }
        try context.save()
    }

    public func dirtyNoteLabels() throws -> [NoteLabel] {
        let descriptor = FetchDescriptor<NoteLabelRecord>(sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).filter(\.dirty).map(\.label)
    }

    public func applyRemoteNoteLabel(_ label: NoteLabel) throws {
        let id = label.id
        let descriptor = FetchDescriptor<NoteLabelRecord>(predicate: #Predicate { $0.id == id })
        if let existing = try context.fetch(descriptor).first {
            guard !existing.dirty else { return }
            existing.name = label.name
            existing.updatedAt = label.updatedAt
        } else {
            context.insert(NoteLabelRecord(label, dirty: false))
        }
        try context.save()
    }

    public func clearNoteLabelDirty(id: UUID, ifUpdatedAt stamp: Date) throws {
        let descriptor = FetchDescriptor<NoteLabelRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first, record.updatedAt == stamp else { return }
        record.dirty = false
        try context.save()
    }

    /// Label ids this phone holds that the cloud no longer lists, so they
    /// were deleted elsewhere. A label still waiting to be pushed is not one
    /// of them.
    public func cleanNoteLabelIds() throws -> [UUID] {
        let descriptor = FetchDescriptor<NoteLabelRecord>()
        return try context.fetch(descriptor).filter { !$0.dirty }.map(\.id)
    }

    public func removeNoteLabelFromCloudDelete(id: UUID) throws {
        try context.delete(model: NoteLabelRecord.self, where: #Predicate { $0.id == id })
        for record in try context.fetch(FetchDescriptor<NoteRecord>())
        where record.dirty != true && record.labelIds?.contains(id) == true {
            record.labelIds = record.labelIds?.filter { $0 != id }
        }
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

    /// The cloud copy is gone with no tombstone behind it, so the item keeps
    /// its files and stops counting as synced.
    public func clearInspirationRemote(_ id: UUID) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.remoteAssetId = nil
        try context.save()
    }

    /// Drop an item the cloud deleted. The twin of deleteInspiration without
    /// the tombstone: the delete came down, so nothing goes back up.
    public func removeInspirationFromCloudDelete(id: UUID) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        removeFiles(of: record)
        context.delete(record)
        try context.save()
    }

    public func inspirationRemoteAssetId(_ id: UUID) throws -> String? {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        return try context.fetch(descriptor).first?.remoteAssetId
    }

    /// Drop a recording the cloud deleted. The twin of deleteRecording without
    /// the tombstone: the delete came down, so nothing goes back up.
    public func removeRecordingFromCloudDelete(id: UUID) throws {
        let descriptor = FetchDescriptor<RecordingRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        for fileName in [record.fileName, record.thumbnailFileName].compactMap({ $0 }) {
            try? FileManager.default.removeItem(at: recordingsDirectory.appending(path: fileName))
        }
        context.delete(record)
        try context.save()
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

    public func markInspirationLinkSynced(_ id: UUID, jobId: String) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.linkSyncedAt = .now
        record.importJobId = jobId
        record.importError = nil
        try context.save()
    }

    public func inspirationImportJobId(_ id: UUID) throws -> String? {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        return try context.fetch(descriptor).first?.importJobId
    }

    /// Every file this item owns on the phone: what it holds now, and anything
    /// else written under its id — media an earlier build brought down before
    /// links started streaming.
    private func removeFiles(of record: InspirationRecord) {
        for fileName in [record.mediaFileName, record.posterFileName].compactMap({ $0 }) {
            try? FileManager.default.removeItem(at: mediaDirectory.appending(path: fileName))
        }
        let prefix = record.id.uuidString
        let names = (try? FileManager.default.contentsOfDirectory(atPath: mediaDirectory.localPath)) ?? []
        for name in names where name.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: mediaDirectory.appending(path: name))
        }
    }

    /// Where a link's poster is written. The name is the item's, so a repeated
    /// fetch overwrites rather than piling up files.
    public func posterDestination(_ id: UUID) -> URL {
        mediaDirectory.appending(path: id.uuidString + "-poster.jpg")
    }

    /// The cloud holds this link's media. Only the poster is here; the video
    /// or photo streams from the account's shelf.
    public func markInspirationFetched(
        _ id: UUID,
        fileName: String,
        isVideo: Bool,
        posterFileName: String?,
        width: Int?,
        height: Int?,
        sourceText: String?,
        remoteAssetId: String
    ) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.cloudFileName = fileName
        record.cloudIsVideo = isVideo
        record.posterFileName = posterFileName
        record.mediaWidth = width
        record.mediaHeight = height
        record.sourceText = sourceText ?? record.sourceText
        record.remoteAssetId = remoteAssetId
        record.importJobId = nil
        record.noMedia = nil
        record.importError = nil
        try context.save()
    }

    /// The source was only words. The card keeps them and stays a link; there
    /// is nothing to retry.
    public func markInspirationNoMedia(_ id: UUID, sourceText: String?) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.importJobId = nil
        record.noMedia = true
        record.sourceText = sourceText
        record.importError = nil
        try context.save()
    }

    /// The attempt failed, in the words the card shows. A job that came back
    /// with the failure is finished with: it is dropped, and the item waits
    /// for the retry.
    public func markInspirationImportFailed(_ id: UUID, message: String, clearJob: Bool) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        if clearJob { record.importJobId = nil }
        record.importError = message
        try context.save()
    }

    public func setInspirationSize(id: UUID, width: Int, height: Int) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.mediaWidth = width
        record.mediaHeight = height
        try context.save()
    }

    /// Back in the queue: the failure clears and the next pass hands the link
    /// over again.
    public func retryInspirationImport(id: UUID) throws {
        let descriptor = FetchDescriptor<InspirationRecord>(predicate: #Predicate { $0.id == id })
        guard let record = try context.fetch(descriptor).first else { return }
        record.importError = nil
        record.importJobId = nil
        record.linkSyncedAt = nil
        record.noMedia = nil
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
