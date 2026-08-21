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
nonisolated public struct NoteFolder: Identifiable, Equatable, Hashable, Sendable {
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
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.color = color
        self.folderId = folderId
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

/// Where a saved link stands with the cloud fetch that turns it into media.
nonisolated public enum InspirationImport: Equatable, Sendable {
    /// Nothing has been asked of the cloud yet — the item was just saved, or
    /// the phone is offline.
    case waiting
    /// The worker is fetching the source.
    case fetching
    /// The source had no media to bring back, or the fetch failed. The card
    /// stays a link.
    case failed
}

nonisolated public struct InspirationItem: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var kind: InspirationKind
    public var createdAt: Date
    /// A saved link whose media the cloud fetched and this phone downloaded.
    /// The card plays it in place, the way a photo-library import plays.
    public var fetched: InspirationMedia?
    /// Where the fetch of a link stands. Media saved from the photo library
    /// has nothing to fetch and reads as `.waiting`.
    public var importState: InspirationImport

    public init(
        id: UUID = UUID(),
        kind: InspirationKind,
        createdAt: Date = .now,
        fetched: InspirationMedia? = nil,
        importState: InspirationImport = .waiting
    ) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.fetched = fetched
        self.importState = importState
    }

    /// The media this card shows: what the phone imported, or what the cloud
    /// brought back for a link.
    public var media: InspirationMedia? {
        if case .media(let fileName, let isVideo) = kind {
            return InspirationMedia(fileName: fileName, isVideo: isVideo)
        }
        return fetched
    }

    /// The source link, for a saved link.
    public var link: URL? {
        if case .link(let url) = kind { return url }
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
    /// Delete a folder. Its notes come back to the top level rather than
    /// going with it — the same line the cloud draws.
    func deleteNoteFolder(id: UUID) throws
    func loadInspiration() throws -> [InspirationItem]
    func addLink(_ url: URL) throws -> InspirationItem
    func addMedia(data: Data, isVideo: Bool) throws -> InspirationItem
    func deleteInspiration(id: UUID) throws
    /// Absolute location of a stored media file.
    func mediaURL(fileName: String) -> URL
}

nonisolated public enum IdeasFilter: String, CaseIterable, Sendable {
    case all, notes, inspiration
}

@Observable
public final class IdeasModel {
    public private(set) var notes: [Note] = []
    public private(set) var folders: [NoteFolder] = []
    public private(set) var inspiration: [InspirationItem] = []
    public var filter: IdeasFilter = .all

    /// The note open in the editor; nil when the editor is closed.
    public var draft: NoteDraft?

    /// Fires after any local edit so the sync engine pushes it. Wired by the
    /// app entry; nil in tests.
    public var onLocalChange: (() -> Void)?

    private let store: any IdeasStoring

    public init(store: any IdeasStoring) {
        self.store = store
        reloadFromStore()
    }

    /// Re-read what the store holds — how a cloud merge lands on screen.
    public func reloadFromStore() {
        notes = (try? store.loadNotes()) ?? []
        folders = (try? store.loadNoteFolders()) ?? []
        inspiration = (try? store.loadInspiration()) ?? []
    }

    /// The notes filed in one folder, or at the top level when `folderId` is
    /// nil.
    public func notes(in folderId: UUID?) -> [Note] {
        notes.filter { $0.folderId == folderId }
    }

    public func folder(_ id: UUID?) -> NoteFolder? {
        guard let id else { return nil }
        return folders.first { $0.id == id }
    }

    // MARK: Folders

    @discardableResult
    public func addFolder(named name: String) -> NoteFolder? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let folder = NoteFolder(name: trimmed)
        try? store.upsert(folder)
        folders.append(folder)
        onLocalChange?()
        return folder
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

    /// Delete a folder. Its notes come back to the top level.
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

    nonisolated public struct NoteDraft: Identifiable, Equatable {
        public var id: UUID
        public var title: String
        public var body: String
        public var color: NoteColor
        /// The folder the note is filed in — the one it was opened from for a
        /// new note.
        public var folderId: UUID?
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
                isNew: false
            )
        } else {
            draft = NoteDraft(id: UUID(), title: "", body: "", color: .butter, folderId: folderId, isNew: true)
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

    public func addInspiration(mediaData: Data, isVideo: Bool) {
        guard let item = try? store.addMedia(data: mediaData, isVideo: isVideo) else { return }
        inspiration.insert(item, at: 0)
        onLocalChange?()
    }

    public func deleteInspiration(id: UUID) {
        try? store.deleteInspiration(id: id)
        inspiration.removeAll { $0.id == id }
        onLocalChange?()
    }

    public func mediaURL(fileName: String) -> URL { store.mediaURL(fileName: fileName) }
}
