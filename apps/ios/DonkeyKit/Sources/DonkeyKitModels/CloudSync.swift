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

/// The cloud shelf as the phone needs to see it: the ids it holds, and the
/// ids someone deleted. An id in neither left by some other hand — the storage
/// sweep reclaiming a lapsed account — which is not a delete the phone mirrors.
nonisolated public struct RemoteLibrary: Equatable, Sendable {
    public var assetIds: Set<String>
    public var deletedIds: Set<String>

    public init(assetIds: Set<String>, deletedIds: Set<String>) {
        self.assetIds = assetIds
        self.deletedIds = deletedIds
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
    public var labelIds: [UUID]
    public var updatedAt: Date
    public var deletedAt: Date?
    public var createdAt: Date

    public init(
        id: UUID,
        title: String,
        body: String,
        colorIndex: Int,
        folderId: UUID? = nil,
        labelIds: [UUID] = [],
        updatedAt: Date,
        deletedAt: Date? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.colorIndex = colorIndex
        self.folderId = folderId
        self.labelIds = labelIds
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
    /// The folder this one is filed in; nil is the top level.
    public var parentId: UUID?
    public var updatedAt: Date
    public var createdAt: Date

    public init(id: UUID, name: String, parentId: UUID? = nil, updatedAt: Date, createdAt: Date) {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.updatedAt = updatedAt
        self.createdAt = createdAt
    }
}

/// A note label as the cloud stores it. Like folders, labels carry no
/// tombstone: a label missing from the listing was deleted.
nonisolated public struct RemoteNoteLabel: Equatable, Sendable {
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
/// included, every folder they file into, and every label they wear.
///
/// `folders` and `labels` are nil when the listing carried no such key at all
/// — an older site speaking to a newer phone. A reader treats that as "this
/// response says nothing about them", which is different from an empty list
/// meaning the account has none.
nonisolated public struct RemoteNotes: Equatable, Sendable {
    public var notes: [RemoteNote]
    public var folders: [RemoteNoteFolder]?
    public var labels: [RemoteNoteLabel]?

    public init(notes: [RemoteNote], folders: [RemoteNoteFolder]?, labels: [RemoteNoteLabel]? = nil) {
        self.notes = notes
        self.folders = folders
        self.labels = labels
    }
}

/// What the cloud brought back for a saved link, once its import job is done.
/// The media stays on the account's shelf; the phone keeps these references
/// and streams from them.
nonisolated public struct ImportedLink: Equatable, Sendable {
    /// The library asset the worker registered, so a delete here takes the
    /// cloud copy with it.
    public var assetId: String
    /// The media's name on the cloud shelf, for the stream URL.
    public var fileName: String
    public var isVideo: Bool
    /// The source's cover, stored beside the media under the same prefix.
    public var posterFile: String?
    /// The media's pixel size, as the worker probed it. The card takes its
    /// shape from this, so a portrait reel and a landscape clip sit in the
    /// grid as themselves.
    public var width: Int?
    public var height: Int?
    /// The source's own words, when it had any.
    public var text: String?

    public init(
        assetId: String,
        fileName: String,
        isVideo: Bool,
        posterFile: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        text: String? = nil
    ) {
        self.assetId = assetId
        self.fileName = fileName
        self.isVideo = isVideo
        self.posterFile = posterFile
        self.width = width
        self.height = height
        self.text = text
    }
}

/// How a link's import job stands, as the phone polls it.
nonisolated public enum LinkImport: Equatable, Sendable {
    /// Queued or running.
    case running
    /// The worker landed media on the account's shelf.
    case ready(ImportedLink)
    /// The source was only words. Whatever it said comes back with it.
    case noMedia(text: String?)
    /// The fetch failed, in the worker's own words.
    case failed(String)
}

/// Where a queued cloud render stands, as the phone polls it.
nonisolated public enum RenderProgress: Equatable, Sendable {
    /// Waiting for a worker to claim it.
    case queued
    /// Rendering, 0…1.
    case running(Double)
    case done
    case failed(String)
}

/// Why a request never reached an answer. The client keeps the network's own
/// verdict this far so a screen can say what happened; collapsing every
/// network failure into one word leaves a phone with full bars being told to
/// check its connection.
nonisolated public enum NetworkReach: Sendable, Equatable {
    /// The phone has no route out at all — airplane mode, no signal.
    case offline
    /// The link is up and the answer took longer than the client waits.
    case timedOut
    /// The connection died between the request and the answer.
    case dropped
    /// The host itself went unanswered: DNS, TLS, a refused socket.
    case unreachable

    /// Whether asking again in a moment could get a different answer. A phone
    /// with no route out needs the person, so nothing retries there.
    public var isWorthAnotherTry: Bool {
        self != .offline
    }

    /// A sentence for the person holding the phone, naming this cause.
    public var sentence: String {
        switch self {
        case .offline: "This phone is offline. Reconnect and try again."
        case .timedOut: "donkeycut.com took too long to answer."
        case .dropped: "The connection dropped before the answer arrived."
        case .unreachable: "Couldn't reach donkeycut.com."
        }
    }
}

nonisolated public enum CloudSyncError: Error, Equatable {
    /// The server refused with a reason worth reading out loud — out of
    /// renders for the day, out of room. The message is the server's own.
    case refused(String)
    /// The account is out of cloud storage: uploads pause, the Library shows
    /// its banner, and nothing retries until space frees up.
    case storageFull
    /// The session is gone; syncing waits for the next sign-in.
    case unauthorized
    /// An answer came back and it was no good: a 5xx, a body that won't
    /// decode. The item stays queued.
    case transport
    /// No answer came back at all, and the network said why. Transient like
    /// `transport`; the item stays queued.
    case unreachable(NetworkReach, code: Int)
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
    /// The shelf's asset ids and its tombstones, for the pass that mirrors
    /// deletes made at the desk back onto this phone.
    func fetchLibrary() async throws -> RemoteLibrary
    /// Queue a cloud-side import of an inspiration link (the render worker
    /// fetches the media into the Inspiration folder). Returns the job id the
    /// phone follows to bring the media down.
    func importInspirationLink(_ url: URL) async throws -> String
    /// Where an import job stands.
    func importedLink(jobId: String) async throws -> LinkImport
    /// Download one library media file to a local URL. Posters only: a link's
    /// video stays in the cloud and streams.
    func downloadLibraryMedia(fileName: String, to destination: URL) async throws
    func fetchUsage() async throws -> StorageUsage
    func fetchNotes() async throws -> RemoteNotes
    /// Returns the winning version — this write, or a newer one already there.
    func putNote(_ note: RemoteNote) async throws -> RemoteNote
    func deleteNote(id: UUID) async throws
    /// Create, rename or move one folder under the id the phone gave it.
    func putNoteFolder(_ folder: RemoteNoteFolder) async throws
    func deleteNoteFolder(id: UUID) async throws
    /// Create or rename one label under the id the phone gave it.
    func putNoteLabel(_ label: RemoteNoteLabel) async throws
    func deleteNoteLabel(id: UUID) async throws
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
    /// Queue a render of the project's whole timeline and hand back the job id.
    /// The cut is composited in the cloud from the stored document, so the
    /// phone gets the same file the editor's own export produces.
    func startExport(projectId: String, preset: String) async throws -> String
    /// Where a queued render stands. Progress runs 0…1 while it works.
    func exportProgress(jobId: String) async throws -> RenderProgress
    /// CDN URL behind the API's redirect for a finished render's file.
    func exportFile(jobId: String) async throws -> URL
    /// CDN URL behind the API's redirect for the latest render of a project:
    /// its newest export, or the composited preview proxy.
    func streamURL(project: RemoteProject, export: RemoteExport?) async throws -> URL
    /// A local poster image for the project card, cached on disk keyed by the
    /// project's updatedAt so only thumbnails ride the network.
    func thumbnailFile(for project: RemoteProject) async -> URL?
}

// MARK: - Network policy

/// The connection the sync engine is working over. Notes and other small
/// payloads ride any of them; media waits for `.wifi` while the app's
/// Wi-Fi-only setting holds. Whether the app may touch cellular at all stays
/// the system's call: iOS Settings carries the per-app Cellular Data switch,
/// and a request it forbids fails on its own.
nonisolated public enum NetworkPath: Equatable, Sendable {
    case wifi
    case cellular
    case offline
}
