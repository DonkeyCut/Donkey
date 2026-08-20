import Foundation
import SwiftData

// Persistence stays at the edge: these SwiftData records never leave this
// file, and the rest of the app talks to the plain structs the repository
// methods return.

@Model
final class NoteRecord {
    @Attribute(.unique) var id: UUID
    var title: String
    var body: String
    var colorIndex: Int
    var createdAt: Date

    init(_ note: Note) {
        id = note.id
        title = note.title
        body = note.body
        colorIndex = note.color.rawValue
        createdAt = note.createdAt
    }

    var note: Note {
        Note(id: id, title: title, body: body, color: NoteColor(rawValue: colorIndex) ?? .butter, createdAt: createdAt)
    }
}

@Model
final class InspirationRecord {
    @Attribute(.unique) var id: UUID
    var linkURL: String?
    var mediaFileName: String?
    var isVideo: Bool
    var createdAt: Date

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

/// One store behind both repository seams: SwiftData for metadata, plain
/// files under Application Support for movie/media bytes.
public final class DonkeyStore: IdeasStoring, RecordingStoring {
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
        let schema = Schema([NoteRecord.self, InspirationRecord.self, RecordingRecord.self])
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
        } else {
            context.insert(NoteRecord(note))
        }
        try context.save()
    }

    public func deleteNote(id: UUID) throws {
        try context.delete(model: NoteRecord.self, where: #Predicate { $0.id == id })
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
        try context.delete(model: RecordingRecord.self, where: #Predicate { $0.id == id })
        try context.save()
    }

    public func movieURL(for recording: Recording) -> URL {
        recordingsDirectory.appending(path: recording.fileName)
    }

    public func thumbnailURL(for recording: Recording) -> URL? {
        recording.thumbnailFileName.map { recordingsDirectory.appending(path: $0) }
    }
}
