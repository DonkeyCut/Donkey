import Foundation

// The cloud as the phone sees it: plain records for the Donkey Cut hosted API
// (/api/cut-cloud/*), the transport protocols the app target implements with
// URLSession, and the pure policy that decides what may move on which network.

nonisolated public struct StorageUsage: Equatable, Sendable {
    public var bytes: Int64
    /// nil = unlimited.
    public var quotaBytes: Int64?

    public init(bytes: Int64, quotaBytes: Int64?) {
        self.bytes = bytes
        self.quotaBytes = quotaBytes
    }

    public var isFull: Bool {
        guard let quotaBytes else { return false }
        return bytes >= quotaBytes
    }
}

/// One library upload: a recording off the camera or an inspiration item.
nonisolated public struct LibraryUpload: Sendable {
    public var fileURL: URL
    public var fileName: String
    public var mime: String
    public var bytes: Int64
    public var name: String
    public var type: String // "video" | "image"
    public var duration: TimeInterval
    public var width: Int?
    public var height: Int?
    public var origin: String // "camera" | "inspiration"
    /// JPEG poster stored beside the media so the desktop card paints at once.
    public var poster: Data?
    /// True when this upload was claimed before (the journal holds the name):
    /// the server re-mints the same claim instead of minting a twin.
    public var resume: Bool

    public init(
        fileURL: URL,
        fileName: String,
        mime: String,
        bytes: Int64,
        name: String,
        type: String,
        duration: TimeInterval,
        width: Int? = nil,
        height: Int? = nil,
        origin: String,
        poster: Data? = nil,
        resume: Bool = false
    ) {
        self.fileURL = fileURL
        self.fileName = fileName
        self.mime = mime
        self.bytes = bytes
        self.name = name
        self.type = type
        self.duration = duration
        self.width = width
        self.height = height
        self.origin = origin
        self.poster = poster
        self.resume = resume
    }
}

nonisolated public struct RemoteAsset: Equatable, Sendable {
    public var id: String
    public var fileName: String

    public init(id: String, fileName: String) {
        self.id = id
        self.fileName = fileName
    }
}

/// A note as the cloud stores it. `updatedAt` is the last-writer-wins clock;
/// a tombstone carries `deletedAt`.
nonisolated public struct RemoteNote: Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var body: String
    public var colorIndex: Int
    public var folderId: UUID?
    public var updatedAt: Date
    public var deletedAt: Date?
    public var createdAt: Date

    public init(
        id: UUID,
        title: String,
        body: String,
        colorIndex: Int,
        folderId: UUID? = nil,
        updatedAt: Date,
        deletedAt: Date? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.colorIndex = colorIndex
        self.folderId = folderId
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
        self.createdAt = createdAt
    }
}

/// A note folder as the cloud stores it. Folders carry no tombstone: a
/// folder missing from the listing was deleted.
nonisolated public struct RemoteNoteFolder: Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var updatedAt: Date
    public var createdAt: Date

    public init(id: UUID, name: String, updatedAt: Date, createdAt: Date) {
        self.id = id
        self.name = name
        self.updatedAt = updatedAt
        self.createdAt = createdAt
    }
}

/// One listing of the account's notes: the notes themselves, tombstones
/// included, and every folder they file into.
///
/// `folders` is nil when the listing carried no folder key at all — an older
/// site speaking to a newer phone. A reader treats that as "this response says
/// nothing about folders", which is different from an empty list meaning the
/// account has none.
nonisolated public struct RemoteNotes: Equatable, Sendable {
    public var notes: [RemoteNote]
    public var folders: [RemoteNoteFolder]?

    public init(notes: [RemoteNote], folders: [RemoteNoteFolder]?) {
        self.notes = notes
        self.folders = folders
    }
}

/// What the cloud brought back for a saved link, once its import job is done.
nonisolated public struct ImportedLink: Equatable, Sendable {
    /// The library asset the worker registered, so a delete here takes the
    /// cloud copy with it.
    public var assetId: String
    /// The media's name on the cloud shelf, for the download.
    public var fileName: String
    public var isVideo: Bool

    public init(assetId: String, fileName: String, isVideo: Bool) {
        self.assetId = assetId
        self.fileName = fileName
        self.isVideo = isVideo
    }
}

/// Where a queued cloud job stands.
nonisolated public enum JobOutcome<Value: Sendable>: Sendable {
    case running
    case done(Value)
    case failed
}

nonisolated public enum CloudSyncError: Error, Equatable {
    /// The account is out of cloud storage: uploads pause, the Library shows
    /// its banner, and nothing retries until space frees up.
    case storageFull
    /// The session is gone; syncing waits for the next sign-in.
    case unauthorized
    /// Anything transient: network, 5xx. The item stays queued.
    case transport
}

/// What the app target's CutCloudClient does for the sync engine.
public protocol CloudSyncServicing: AnyObject {
    /// Presign → PUT the bytes to R2 → complete. Reports rough progress in
    /// 0...1.
    func uploadLibraryMedia(
        _ upload: LibraryUpload,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> RemoteAsset
    func deleteLibraryAsset(id: String) async throws
    /// Queue a cloud-side import of an inspiration link (the render worker
    /// fetches the media into the Inspiration folder). Returns the job id the
    /// phone follows to bring the media down.
    func importInspirationLink(_ url: URL) async throws -> String
    /// Where an import job stands. `done` carries the first piece of media
    /// the source yielded; a source that was only words comes back `failed`.
    func importedLink(jobId: String) async throws -> JobOutcome<ImportedLink>
    /// Download one library media file to a local URL.
    func downloadLibraryMedia(fileName: String, to destination: URL) async throws
    func fetchUsage() async throws -> StorageUsage
    func fetchNotes() async throws -> RemoteNotes
    /// Returns the winning version — this write, or a newer one already there.
    func putNote(_ note: RemoteNote) async throws -> RemoteNote
    func deleteNote(id: UUID) async throws
    /// Create or rename one folder under the id the phone gave it.
    func putNoteFolder(_ folder: RemoteNoteFolder) async throws
    func deleteNoteFolder(id: UUID) async throws
}

// MARK: - Projects (down-sync)

/// A cloud project summary reduced to what the phone shows.
nonisolated public struct RemoteProject: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var duration: TimeInterval
    public var updatedAt: Date
    /// The composited hover-proxy render exists; it is the stream of record
    /// when no export does.
    public var hasPreview: Bool
    public var previewFile: String?
    public var previewIsImage: Bool
    public var previewStart: TimeInterval

    public init(
        id: String,
        name: String,
        duration: TimeInterval,
        updatedAt: Date,
        hasPreview: Bool,
        previewFile: String? = nil,
        previewIsImage: Bool = false,
        previewStart: TimeInterval = 0
    ) {
        self.id = id
        self.name = name
        self.duration = duration
        self.updatedAt = updatedAt
        self.hasPreview = hasPreview
        self.previewFile = previewFile
        self.previewIsImage = previewIsImage
        self.previewStart = previewStart
    }
}

nonisolated public struct RemoteExport: Equatable, Sendable {
    public var file: String
    public var modifiedAt: Date

    public init(file: String, modifiedAt: Date) {
        self.file = file
        self.modifiedAt = modifiedAt
    }
}

public protocol CloudProjectsServicing: AnyObject, Sendable {
    func fetchProjects() async throws -> [RemoteProject]
    func fetchExports(projectId: String) async throws -> [RemoteExport]
    /// CDN URL behind the API's redirect for the latest render of a project:
    /// its newest export, or the composited preview proxy.
    func streamURL(project: RemoteProject, export: RemoteExport?) async throws -> URL
    /// A local poster image for the project card, cached on disk keyed by the
    /// project's updatedAt so only thumbnails ride the network.
    func thumbnailFile(for project: RemoteProject) async -> URL?
}

// MARK: - Network policy

/// The connection the sync engine is working over. Whether cellular data may
/// be spent is the system's call: iOS Settings carries the per-app Cellular
/// Data switch, and a request it forbids fails on its own.
nonisolated public enum NetworkPath: Equatable, Sendable {
    case wifi
    case cellular
    case offline
}
