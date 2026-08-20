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

nonisolated public struct Note: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var body: String
    public var color: NoteColor
    public var createdAt: Date

    public init(id: UUID = UUID(), title: String, body: String, color: NoteColor, createdAt: Date = .now) {
        self.id = id
        self.title = title
        self.body = body
        self.color = color
        self.createdAt = createdAt
    }

    /// The text a teleprompter reads for this note.
    public var script: String { body.isEmpty ? title : body }
}

nonisolated public enum InspirationKind: Equatable, Sendable {
    case link(URL)
    /// Media imported from the photo library, stored as a file the repository owns.
    case media(fileName: String, isVideo: Bool)
}

nonisolated public struct InspirationItem: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var kind: InspirationKind
    public var createdAt: Date

    public init(id: UUID = UUID(), kind: InspirationKind, createdAt: Date = .now) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
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
    public private(set) var inspiration: [InspirationItem] = []
    public var filter: IdeasFilter = .all

    /// The note open in the editor; nil when the editor is closed.
    public var draft: NoteDraft?

    private let store: any IdeasStoring

    public init(store: any IdeasStoring) {
        self.store = store
        notes = (try? store.loadNotes()) ?? []
        inspiration = (try? store.loadInspiration()) ?? []
    }

    nonisolated public struct NoteDraft: Identifiable, Equatable {
        public var id: UUID
        public var title: String
        public var body: String
        public var color: NoteColor
        public var isNew: Bool

        public var hasContent: Bool {
            !title.trimmingCharacters(in: .whitespaces).isEmpty
                || !body.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    public func openEditor(for note: Note? = nil) {
        if let note {
            draft = NoteDraft(id: note.id, title: note.title, body: note.body, color: note.color, isNew: false)
        } else {
            draft = NoteDraft(id: UUID(), title: "", body: "", color: .butter, isNew: true)
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
        let note = Note(
            id: draft.id,
            title: title.isEmpty ? "Untitled" : title,
            body: body,
            color: draft.color,
            createdAt: existing?.createdAt ?? .now
        )
        try? store.upsert(note)
        if let index = notes.firstIndex(where: { $0.id == note.id }) {
            notes[index] = note
        } else {
            notes.insert(note, at: 0)
        }
        self.draft = nil
        return note
    }

    public func closeEditor() { draft = nil }

    public func deleteNote(id: UUID) {
        try? store.deleteNote(id: id)
        notes.removeAll { $0.id == id }
    }

    @discardableResult
    public func addInspiration(urlText: String) -> Bool {
        guard let url = normalizedInspirationURL(urlText),
              let item = try? store.addLink(url) else { return false }
        inspiration.insert(item, at: 0)
        return true
    }

    public func addInspiration(mediaData: Data, isVideo: Bool) {
        guard let item = try? store.addMedia(data: mediaData, isVideo: isVideo) else { return }
        inspiration.insert(item, at: 0)
    }

    public func deleteInspiration(id: UUID) {
        try? store.deleteInspiration(id: id)
        inspiration.removeAll { $0.id == id }
    }

    public func mediaURL(fileName: String) -> URL { store.mediaURL(fileName: fileName) }
}
