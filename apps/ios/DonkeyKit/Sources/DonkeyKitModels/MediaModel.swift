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

    /// The sync engine, held here for the screens that kick it. Recordings
    /// stay on this phone. Wired by the app entry; nil in tests.
    public var sync: SyncEngine?

    private let store: any RecordingStoring

    public init(store: any RecordingStoring) {
        self.store = store
        reloadFromStore()
    }

    private func reloadFromStore() {
        recordings = (try? store.loadRecordings()) ?? []
    }

    /// Inspiration media is waiting for Wi-Fi; the Ideas banner reads this.
    public var waitingForWiFi: Bool { sync?.waitingForWiFi ?? false }

    /// The cloud refused an upload for want of space; the Ideas banner reads
    /// this.
    public var storageFull: Bool { sync?.storageFull ?? false }

    public func ingest(movieAt url: URL, duration: TimeInterval, thumbnail: Data?) {
        guard let recording = try? store.ingest(movieAt: url, duration: duration, thumbnail: thumbnail) else { return }
        recordings.insert(recording, at: 0)
    }

    /// Deletes the clip and its files from this phone.
    public func delete(_ recording: Recording) {
        try? store.deleteRecording(recording)
        recordings.removeAll { $0.id == recording.id }
    }

    public func movieURL(for recording: Recording) -> URL { store.movieURL(for: recording) }
    public func thumbnailURL(for recording: Recording) -> URL? { store.thumbnailURL(for: recording) }
}
