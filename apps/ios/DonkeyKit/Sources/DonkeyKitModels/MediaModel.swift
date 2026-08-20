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

/// Where a clip's bytes live relative to the cloud. Upload is simulated
/// until the cloud clip endpoint exists; the states and badge UI are the
/// supported shape.
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
    private var syncStates: [UUID: RecordingSyncState] = [:]

    private let store: any RecordingStoring

    public init(store: any RecordingStoring) {
        self.store = store
        recordings = (try? store.loadRecordings()) ?? []
    }

    public func syncState(for recording: Recording) -> RecordingSyncState {
        syncStates[recording.id] ?? .onDevice
    }

    public func ingest(movieAt url: URL, duration: TimeInterval, thumbnail: Data?) {
        guard let recording = try? store.ingest(movieAt: url, duration: duration, thumbnail: thumbnail) else { return }
        recordings.insert(recording, at: 0)
        beginUpload(of: recording)
    }

    public func delete(_ recording: Recording) {
        try? store.deleteRecording(recording)
        recordings.removeAll { $0.id == recording.id }
        syncStates[recording.id] = nil
    }

    private func beginUpload(of recording: Recording) {
        syncStates[recording.id] = .uploading(percent: 0)
        Task {
            var percent = 0.0
            while percent < 100 {
                try? await Task.sleep(for: .seconds(0.6))
                guard recordings.contains(where: { $0.id == recording.id }) else { return }
                percent = min(percent + .random(in: 6 ... 22), 100)
                syncStates[recording.id] = .uploading(percent: Int(percent))
            }
            syncStates[recording.id] = .synced
        }
    }

    public func movieURL(for recording: Recording) -> URL { store.movieURL(for: recording) }
    public func thumbnailURL(for recording: Recording) -> URL? { store.thumbnailURL(for: recording) }
}
