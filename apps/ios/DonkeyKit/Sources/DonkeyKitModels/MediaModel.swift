import Foundation

nonisolated public struct Recording: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var fileName: String
    public var thumbnailFileName: String?
    public var duration: TimeInterval
    public var createdAt: Date

    public init(id: UUID = UUID(), fileName: String, thumbnailFileName: String?, duration: TimeInterval, createdAt: Date = .now) {
        self.id = id
        self.fileName = fileName
        self.thumbnailFileName = thumbnailFileName
        self.duration = duration
        self.createdAt = createdAt
    }
}

/// Where a clip's bytes live relative to the cloud.
nonisolated public enum RecordingSyncState: Equatable, Sendable {
    case onDevice
    case uploading(percent: Int)
    case synced
}

public protocol RecordingStoring: AnyObject {
    func loadRecordings() throws -> [Recording]
    /// Moves a finished movie into the store and persists its metadata.
    func ingest(movieAt url: URL, duration: TimeInterval, thumbnail: Data?) throws -> Recording
    func deleteRecording(_ recording: Recording) throws
    func movieURL(for recording: Recording) -> URL
    func thumbnailURL(for recording: Recording) -> URL?
}

@Observable
public final class MediaModel {
    public private(set) var recordings: [Recording] = []

    /// The engine that carries recordings to the cloud. Wired by the app
    /// entry; nil in tests, where everything reads as on-device.
    public var sync: SyncEngine?

    private let store: any RecordingStoring

    public init(store: any RecordingStoring) {
        self.store = store
        recordings = (try? store.loadRecordings()) ?? []
    }

    public func syncState(for recording: Recording) -> RecordingSyncState {
        sync?.state(for: recording) ?? .onDevice
    }

    /// The cloud is out of room; the Library banner reads this.
    public var storageFull: Bool { sync?.storageFull ?? false }

    public func ingest(movieAt url: URL, duration: TimeInterval, thumbnail: Data?) {
        guard let recording = try? store.ingest(movieAt: url, duration: duration, thumbnail: thumbnail) else { return }
        recordings.insert(recording, at: 0)
        sync?.recordingAdded(recording)
    }

    /// Deletes the clip everywhere: the local file now, and the cloud copy
    /// through the tombstone the store records.
    public func delete(_ recording: Recording) {
        try? store.deleteRecording(recording)
        recordings.removeAll { $0.id == recording.id }
        sync?.kick()
    }

    public func movieURL(for recording: Recording) -> URL { store.movieURL(for: recording) }
    public func thumbnailURL(for recording: Recording) -> URL? { store.thumbnailURL(for: recording) }
}
