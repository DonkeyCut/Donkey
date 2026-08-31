import Foundation

/// The five note paper colors. Values are sRGB hex strings so models stay
/// Foundation-only; DonkeyKitUI converts them to Colors.
nonisolated public enum NoteColor: Int, CaseIterable, Codable, Sendable {
    case butter, blush, sky, mint, lilac

    public var background: String {
        switch self {
        case .butter: "#faefb6"
        case .blush: "#fbd8d4"
        case .sky: "#d5e8fb"
        case .mint: "#d9f3d6"
        case .lilac: "#e6dcf7"
        }
    }

    public var accent: String {
        switch self {
        case .butter: "#f2c94c"
        case .blush: "#ef8b80"
        case .sky: "#7fb2ef"
        case .mint: "#82cf7a"
        case .lilac: "#a988e0"
        }
    }

    public var next: NoteColor {
        NoteColor(rawValue: (rawValue + 1) % Self.allCases.count) ?? .butter
    }
}

/// A folder notes are filed in. Ids are minted by whichever client makes the
/// folder — the phone here, the desktop in its Notes tab — and the cloud
/// stores the folder under that id, so a folder made offline pushes as itself.
/// Folders file into folders the way notes do; `parentId` nil is the top level.
nonisolated public struct NoteFolder: Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var parentId: UUID?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        name: String,
        parentId: UUID? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.name = name
        self.parentId = parentId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One folder in the tree laid out as a list: the folder and how deep it sits.
nonisolated public struct NoteFolderTreeRow: Identifiable, Equatable, Sendable {
    public var folder: NoteFolder
    public var depth: Int
    public var id: UUID { folder.id }
}

/// A label notes carry. Like folders, ids are minted by whichever client
/// makes the label, one PUT both creates and renames, and the cloud listing
/// is the truth — a label missing from it was deleted.
nonisolated public struct NoteLabel: Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), name: String, createdAt: Date = .now, updatedAt: Date = .now) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

nonisolated public struct Note: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var body: String
    public var color: NoteColor
    /// The folder this note is filed in; nil is the top level.
    public var folderId: UUID?
    /// The labels this note wears. They ride the note's own last-writer-wins
    /// write; an id naming no label is dropped from view.
    public var labelIds: [UUID]
    public var createdAt: Date
    /// Last edit, wherever it happened. The sync's last-writer-wins clock:
    /// the newer stamp survives when the phone and the desktop both wrote.
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        title: String,
        body: String,
        color: NoteColor,
        folderId: UUID? = nil,
        labelIds: [UUID] = [],
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.color = color
        self.folderId = folderId
        self.labelIds = labelIds
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// The text a teleprompter reads for this note: what is written in it. A
    /// title names the note, so it is read only when it is all the note has.
    public var script: String {
        let written = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return written.isEmpty ? title.trimmingCharacters(in: .whitespacesAndNewlines) : written
    }
}

nonisolated public enum InspirationKind: Equatable, Sendable {
    case link(URL)
    /// Media imported from the photo library, stored as a file the repository owns.
    case media(fileName: String, isVideo: Bool)
}

/// Media stored on this phone: the file name under the repository's
/// Inspiration directory, and whether it plays.
nonisolated public struct InspirationMedia: Equatable, Sendable {
    public var fileName: String
    public var isVideo: Bool

    public init(fileName: String, isVideo: Bool) {
        self.fileName = fileName
        self.isVideo = isVideo
    }
}

/// What the cloud fetched for a saved link. The media lives on the account's
/// library shelf — the same shelf the web Library shows — and the phone
/// streams it from there; only the poster comes down.
nonisolated public struct InspirationCloudMedia: Equatable, Sendable {
    /// The library asset, so a delete here takes the cloud copy with it.
    public var assetId: String
    /// The media's name on the shelf, for the stream URL.
    public var fileName: String
    public var isVideo: Bool
    /// The poster this phone downloaded beside it, if the source had one.
    public var posterFileName: String?
    /// The pixel size the worker probed, which the card's shape comes from.
    public var width: Int?
    public var height: Int?

    public init(
        assetId: String,
        fileName: String,
        isVideo: Bool,
        posterFileName: String? = nil,
        width: Int? = nil,
        height: Int? = nil
    ) {
        self.assetId = assetId
        self.fileName = fileName
        self.isVideo = isVideo
        self.posterFileName = posterFileName
        self.width = width
        self.height = height
    }
}

/// Where a saved link stands with the cloud fetch that turns it into media.
nonisolated public enum InspirationImport: Equatable, Sendable {
    /// Saved here; the cloud has not taken the job yet.
    case queued
    /// A worker is fetching the source.
    case fetching
    /// The cloud holds media for this link.
    case ready
    /// The source was only words. The card stays a link and carries its text.
    case noMedia
    /// The last attempt failed, and says why. The card offers another try.
    case failed(String)
}

nonisolated public struct InspirationItem: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var kind: InspirationKind
    public var createdAt: Date
    /// What the cloud fetched for a saved link. The bytes stay in the account,
    /// and the card streams them.
    public var cloud: InspirationCloudMedia?
    /// The source's own words — a tweet's text, a video's title and
    /// description — quoted on the card beside its media.
    public var sourceText: String?
    /// Where the fetch of a link stands. Media saved from the photo library
    /// has nothing to fetch and reads as `.ready`.
    public var importState: InspirationImport
    /// The pixel size of media held on this phone, measured when it landed.
    public var localWidth: Int?
    public var localHeight: Int?

    public init(
        id: UUID = UUID(),
        kind: InspirationKind,
        createdAt: Date = .now,
        cloud: InspirationCloudMedia? = nil,
        sourceText: String? = nil,
        importState: InspirationImport = .queued,
        localWidth: Int? = nil,
        localHeight: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.cloud = cloud
        self.sourceText = sourceText
        self.importState = importState
        self.localWidth = localWidth
        self.localHeight = localHeight
    }

    /// Media on this phone: a photo-library import. A link's media is the
    /// cloud's and streams from there.
    public var localMedia: InspirationMedia? {
        if case .media(let fileName, let isVideo) = kind {
            return InspirationMedia(fileName: fileName, isVideo: isVideo)
        }
        return nil
    }

    /// The source link, for a saved link.
    public var link: URL? {
        if case .link(let url) = kind { return url }
        return nil
    }

    /// Whether this item's media plays, wherever it lives.
    public var isVideo: Bool {
        localMedia?.isVideo ?? cloud?.isVideo ?? false
    }

    /// The media's own width over height: the cloud's probe for a fetched
    /// link, this phone's for an import. Nil until something has measured it,
    /// and clamped so one panorama or one very tall reel still sits in a grid
    /// beside the others.
    public var aspectRatio: Double? {
        guard let width = pixelSize?.width, let height = pixelSize?.height,
              width > 0, height > 0 else { return nil }
        return min(max(Double(width) / Double(height), Self.narrowest), Self.widest)
    }

    /// The widest and narrowest shapes a card takes: a 2:1 landscape, and a
    /// touch taller than a 9:16 reel.
    static let widest = 2.0
    static let narrowest = 0.5

    var pixelSize: (width: Int, height: Int)? {
        if let width = localWidth, let height = localHeight { return (width, height) }
        if let width = cloud?.width, let height = cloud?.height { return (width, height) }
        return nil
    }
}

/// Normalizes user-typed inspiration input into a URL, defaulting to https.
nonisolated public func normalizedInspirationURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let withScheme = trimmed.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
        ? trimmed
        : "https://" + trimmed
    guard let url = URL(string: withScheme), url.host() != nil else { return nil }
    return url
}

public protocol IdeasStoring: AnyObject {
    func loadNotes() throws -> [Note]
    func upsert(_ note: Note) throws
    func deleteNote(id: UUID) throws
    func loadNoteFolders() throws -> [NoteFolder]
    func upsert(_ folder: NoteFolder) throws
    /// Delete a folder. What it held — its notes and the folders inside it —
    /// comes up one level, the same line the cloud draws.
    func deleteNoteFolder(id: UUID) throws
    func loadNoteLabels() throws -> [NoteLabel]
    func upsert(_ label: NoteLabel) throws
    /// Delete a label. Every note wearing it lets it go, as its own write.
    func deleteNoteLabel(id: UUID) throws
    func loadInspiration() throws -> [InspirationItem]
    func addLink(_ url: URL) throws -> InspirationItem
    func addMedia(data: Data, isVideo: Bool) throws -> InspirationItem
    func deleteInspiration(id: UUID) throws
    /// Put a link's import back in the queue after a failure.
    func retryInspirationImport(id: UUID) throws
    /// The pixel size of media stored on this phone, measured after it landed.
    func setInspirationSize(id: UUID, width: Int, height: Int) throws
    /// Absolute location of a stored media file.
    func mediaURL(fileName: String) -> URL
}

/// The account's cloud shelf, as an inspiration card needs it: one signed URL
/// per file, minted on demand. The bytes stay in the cloud; the card streams
/// them.
public protocol InspirationStreaming: AnyObject, Sendable {
    func libraryMediaURL(fileName: String) async throws -> URL
}

nonisolated public enum IdeasFilter: String, CaseIterable, Sendable {
    case notes, inspiration
}

@Observable
public final class IdeasModel {
    public private(set) var notes: [Note] = []
    public private(set) var folders: [NoteFolder] = []
    public private(set) var labels: [NoteLabel] = []
    public private(set) var inspiration: [InspirationItem] = []
    public var filter: IdeasFilter = .notes

    /// The note open in the editor; nil when the editor is closed.
    public var draft: NoteDraft?

    /// Fires after any local edit so the sync engine pushes it. Wired by the
    /// app entry; nil in tests.
    public var onLocalChange: (() -> Void)?

    private let store: any IdeasStoring

    /// The cloud, for streaming a link's fetched media. Wired by the app
    /// entry; nil in tests, where cards paint from what the store holds.
    public weak var cloud: (any InspirationStreaming)?

    public init(store: any IdeasStoring) {
        self.store = store
        reloadFromStore()
    }

    /// Re-read what the store holds — how a cloud merge lands on screen. A
    /// folder whose parent the store does not hold reads as top level, so
    /// nothing on screen hangs off a folder nobody can open.
    public func reloadFromStore() {
        notes = (try? store.loadNotes()) ?? []
        let loaded = (try? store.loadNoteFolders()) ?? []
        let known = Set(loaded.map(\.id))
        folders = loaded.map { folder in
            var folder = folder
            if let parent = folder.parentId, !known.contains(parent) { folder.parentId = nil }
            return folder
        }
        labels = (try? store.loadNoteLabels()) ?? []
        inspiration = (try? store.loadInspiration()) ?? []
    }

    /// The notes filed in one folder, or at the top level when `folderId` is
    /// nil.
    public func notes(in folderId: UUID?) -> [Note] {
        notes.filter { $0.folderId == folderId }
    }

    /// The folders filed in one folder, or at the top level when `parentId`
    /// is nil.
    public func folders(in parentId: UUID?) -> [NoteFolder] {
        folders.filter { $0.parentId == parentId }
    }

    public func folder(_ id: UUID?) -> NoteFolder? {
        guard let id else { return nil }
        return folders.first { $0.id == id }
    }

    /// Whether `folderId` is `ancestorId` or filed somewhere under it.
    public func folder(_ folderId: UUID?, isWithin ancestorId: UUID) -> Bool {
        var cur = folderId
        var steps = 0
        while let id = cur, steps <= folders.count {
            if id == ancestorId { return true }
            cur = folder(id)?.parentId
            steps += 1
        }
        return false
    }

    /// The folders from the top level down to `folderId`, the open one last.
    public func trail(to folderId: UUID?) -> [NoteFolder] {
        var trail: [NoteFolder] = []
        var cur = folder(folderId)
        while let here = cur, trail.count <= folders.count {
            trail.insert(here, at: 0)
            cur = folder(here.parentId)
        }
        return trail
    }

    /// The whole tree as one list, parents before their children, each row
    /// saying how deep it sits. A folder named in `excluding` is left out with
    /// everything under it — the picker for moving a folder never offers the
    /// folder itself.
    public func folderTree(excluding: UUID? = nil) -> [NoteFolderTreeRow] {
        var rows: [NoteFolderTreeRow] = []
        func walk(_ parentId: UUID?, depth: Int) {
            guard depth <= folders.count else { return }
            for folder in folders(in: parentId) where folder.id != excluding {
                rows.append(NoteFolderTreeRow(folder: folder, depth: depth))
                walk(folder.id, depth: depth + 1)
            }
        }
        walk(nil, depth: 0)
        return rows
    }

    // MARK: Folders

    @discardableResult
    public func addFolder(named name: String, in parentId: UUID? = nil) -> NoteFolder? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let folder = NoteFolder(name: trimmed, parentId: folder(parentId)?.id)
        try? store.upsert(folder)
        folders.append(folder)
        onLocalChange?()
        return folder
    }

    /// File a folder in a folder, or at the top level. A folder never files
    /// into itself or into anything under it.
    public func moveFolder(id: UUID, to parentId: UUID?) {
        guard var moving = folders.first(where: { $0.id == id }), moving.parentId != parentId else { return }
        if let parentId {
            guard folder(parentId) != nil, !folder(parentId, isWithin: id) else { return }
        }
        moving.parentId = parentId
        moving.updatedAt = .now
        try? store.upsert(moving)
        if let index = folders.firstIndex(where: { $0.id == id }) { folders[index] = moving }
        onLocalChange?()
    }

    public func renameFolder(id: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var folder = folders.first(where: { $0.id == id }) else { return }
        folder.name = trimmed
        folder.updatedAt = .now
        try? store.upsert(folder)
        if let index = folders.firstIndex(where: { $0.id == id }) { folders[index] = folder }
        onLocalChange?()
    }

    /// Delete a folder. What it held comes up one level.
    public func deleteFolder(id: UUID) {
        try? store.deleteNoteFolder(id: id)
        reloadFromStore()
        onLocalChange?()
    }

    /// File a note in a folder, or at the top level.
    public func move(noteId: UUID, to folderId: UUID?) {
        guard var note = notes.first(where: { $0.id == noteId }), note.folderId != folderId else { return }
        note.folderId = folderId
        note.updatedAt = .now
        try? store.upsert(note)
        if let index = notes.firstIndex(where: { $0.id == noteId }) { notes[index] = note }
        onLocalChange?()
    }

    // MARK: Labels

    /// The labels a note wears, in the order the account lists them. An id
    /// naming nothing — a label deleted on another device — drops from view.
    public func labels(on note: Note) -> [NoteLabel] {
        labels.filter { note.labelIds.contains($0.id) }
    }

    @discardableResult
    public func addLabel(named name: String) -> NoteLabel? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let label = NoteLabel(name: trimmed)
        try? store.upsert(label)
        labels.append(label)
        onLocalChange?()
        return label
    }

    public func renameLabel(id: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var label = labels.first(where: { $0.id == id }) else { return }
        label.name = trimmed
        label.updatedAt = .now
        try? store.upsert(label)
        if let index = labels.firstIndex(where: { $0.id == id }) { labels[index] = label }
        onLocalChange?()
    }

    /// Delete a label. Every note wearing it — the open draft too — lets it
    /// go.
    public func deleteLabel(id: UUID) {
        try? store.deleteNoteLabel(id: id)
        draft?.labelIds.removeAll { $0 == id }
        reloadFromStore()
        onLocalChange?()
    }

    /// Most labels one note may wear. The cloud refuses a write past this, so
    /// the picker holds the same line — a label taken past it would come back
    /// off the note on the next merge.
    public static let maxLabelsPerNote = 20

    /// Whether the open draft has room for another label.
    public var draftTakesLabels: Bool {
        (draft?.labelIds.count ?? 0) < Self.maxLabelsPerNote
    }

    /// Put a label on the open draft, or take it off.
    public func toggleDraftLabel(_ id: UUID) {
        guard var draft else { return }
        if draft.labelIds.contains(id) {
            draft.labelIds.removeAll { $0 == id }
        } else {
            guard draft.labelIds.count < Self.maxLabelsPerNote else { return }
            draft.labelIds.append(id)
        }
        self.draft = draft
    }

    nonisolated public struct NoteDraft: Identifiable, Equatable {
        public var id: UUID
        public var title: String
        public var body: String
        public var color: NoteColor
        /// The folder the note is filed in — the one it was opened from for a
        /// new note.
        public var folderId: UUID?
        /// The labels the note wears.
        public var labelIds: [UUID]
        public var isNew: Bool

        public var hasContent: Bool {
            !title.trimmingCharacters(in: .whitespaces).isEmpty
                || !body.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    public func openEditor(for note: Note? = nil, in folderId: UUID? = nil) {
        if let note {
            draft = NoteDraft(
                id: note.id,
                title: note.title,
                body: note.body,
                color: note.color,
                folderId: note.folderId,
                labelIds: note.labelIds,
                isNew: false
            )
        } else {
            draft = NoteDraft(
                id: UUID(),
                title: "",
                body: "",
                color: .butter,
                folderId: folderId,
                labelIds: [],
                isNew: true
            )
        }
    }

    public func cycleDraftColor() {
        guard var draft else { return }
        draft.color = draft.color.next
        self.draft = draft
    }

    /// Saves the open draft. Returns the saved note, or nil when the draft was empty.
    @discardableResult
    public func saveDraft() -> Note? {
        guard let draft, draft.hasContent else { return nil }
        let title = draft.title.trimmingCharacters(in: .whitespaces)
        let body = draft.body.trimmingCharacters(in: .whitespaces)
        let existing = notes.first(where: { $0.id == draft.id })
        // A stand-in title would be read out by the prompter, so an untitled
        // note stays untitled and the card shows the placeholder.
        let note = Note(
            id: draft.id,
            title: title,
            body: body,
            color: draft.color,
            folderId: draft.folderId,
            labelIds: draft.labelIds,
            createdAt: existing?.createdAt ?? .now,
            updatedAt: .now
        )
        try? store.upsert(note)
        if let index = notes.firstIndex(where: { $0.id == note.id }) {
            notes[index] = note
        } else {
            notes.insert(note, at: 0)
        }
        self.draft = nil
        onLocalChange?()
        return note
    }

    public func closeEditor() { draft = nil }

    public func deleteNote(id: UUID) {
        try? store.deleteNote(id: id)
        notes.removeAll { $0.id == id }
        onLocalChange?()
    }

    @discardableResult
    public func addInspiration(urlText: String) -> Bool {
        guard let url = normalizedInspirationURL(urlText),
              let item = try? store.addLink(url) else { return false }
        inspiration.insert(item, at: 0)
        onLocalChange?()
        return true
    }

    @discardableResult
    public func addInspiration(mediaData: Data, isVideo: Bool) -> InspirationItem? {
        guard let item = try? store.addMedia(data: mediaData, isVideo: isVideo) else { return nil }
        inspiration.insert(item, at: 0)
        onLocalChange?()
        return item
    }

    public func deleteInspiration(id: UUID) {
        try? store.deleteInspiration(id: id)
        inspiration.removeAll { $0.id == id }
        onLocalChange?()
    }

    /// Ask the cloud for this link again. The failure clears, the item goes
    /// back in the queue, and the next sync pass hands it over.
    public func retryInspiration(id: UUID) {
        try? store.retryInspirationImport(id: id)
        reloadFromStore()
        onLocalChange?()
    }

    /// Record what an imported photo or video measures, so its card takes the
    /// media's own shape. The cloud reports this for a fetched link.
    public func recordSize(id: UUID, width: Int, height: Int) {
        guard width > 0, height > 0 else { return }
        try? store.setInspirationSize(id: id, width: width, height: height)
        reloadFromStore()
    }

    /// Where this card streams from: a signed URL for the account's own copy.
    public func streamURL(for media: InspirationCloudMedia) async -> URL? {
        try? await cloud?.libraryMediaURL(fileName: media.fileName)
    }

    public func mediaURL(fileName: String) -> URL { store.mediaURL(fileName: fileName) }
}
