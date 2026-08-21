#if os(iOS)
import AVKit
import PhotosUI
import SwiftUI
import DonkeyKitModels

struct IdeasScreen: View {
    @Bindable var app: AppModel
    @Bindable var ideas: IdeasModel
    var media: MediaModel
    var auth: AuthModel
    let onRecordNote: (Note) -> Void

    @State private var showsLinkSheet = false
    @State private var showsPhotoPicker = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var folderPrompt: FolderPrompt?
    @State private var moving: Note?
    @State private var path: [NoteFolder] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                ScreenHeader(title: "Ideas", app: app, auth: auth)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        filterChips
                        content
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
                // The phone pulls on its own clock; this is the same pass on
                // the reader's word.
                .refreshable { await media.sync?.refreshNow() }
            }
            .navigationDestination(for: NoteFolder.self) { folder in
                NoteFolderScreen(
                    ideas: ideas,
                    media: media,
                    folder: folder,
                    onMove: { moving = $0 }
                )
            }
        }
        // The menu adds to the top level: a link, a camera-roll import, a
        // loose note, a folder. An open folder has its own New note button in
        // the navigation bar, which files into that folder.
        .overlay(alignment: .bottomTrailing) {
            if path.isEmpty { addMenu }
        }
        .fullScreenCover(item: $ideas.draft) { _ in
            NoteEditorView(app: app, ideas: ideas, onRecordNote: onRecordNote)
        }
        .sheet(isPresented: $showsLinkSheet) {
            LinkSheet(app: app, ideas: ideas)
                .presentationDetents([.medium])
        }
        .sheet(item: $moving) { note in
            MoveToFolderSheet(ideas: ideas, note: note)
        }
        .folderPrompt($folderPrompt, ideas: ideas)
        .photosPicker(
            isPresented: $showsPhotoPicker,
            selection: $pickerItems,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
                    ideas.addInspiration(mediaData: data, isVideo: isVideo)
                }
                pickerItems = []
                app.show(toast: "Saved to Inspiration")
            }
        }
        // A folder opened here and then deleted on the desktop takes the
        // screen standing on it with it.
        .onChange(of: ideas.folders) { _, folders in
            path.removeAll { folder in !folders.contains { $0.id == folder.id } }
        }
    }

    private var addMenu: some View {
        Menu {
            Button("Paste link", systemImage: "link") { showsLinkSheet = true }
            Button("Camera roll", systemImage: "photo") { showsPhotoPicker = true }
            Button("New note", systemImage: "note.text") { ideas.openEditor() }
            Button("New folder", systemImage: "folder.badge.plus") { folderPrompt = .create }
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.bold))
                .frame(width: 60, height: 60)
        }
        .glassEffect(.regular.interactive())
        .padding(.trailing, 20)
        .padding(.bottom, 20)
        .accessibilityLabel("Add")
    }

    private var filterChips: some View {
        Picker("Filter", selection: $ideas.filter) {
            ForEach(IdeasFilter.allCases, id: \.self) { filter in
                Text(filter.rawValue.capitalized).tag(filter)
            }
        }
        .pickerStyle(.segmented)
    }

    /// The notes at the top level; the ones inside folders are shown there.
    private var loose: [Note] { ideas.notes(in: nil) }

    @ViewBuilder private var content: some View {
        switch ideas.filter {
        case .all:
            if ideas.notes.isEmpty && ideas.folders.isEmpty && ideas.inspiration.isEmpty {
                EmptyState(
                    title: "Nothing here yet",
                    message: "Add a note or save some inspiration to get started."
                )
            } else {
                if !ideas.notes.isEmpty || !ideas.folders.isEmpty {
                    sectionLabel("Notes")
                    notesSection
                }
                if !ideas.inspiration.isEmpty {
                    sectionLabel("Inspiration")
                    inspirationGrid
                }
            }
        case .notes:
            if ideas.notes.isEmpty && ideas.folders.isEmpty {
                EmptyState(title: "No notes yet", message: "Tap the note button to capture an idea.")
            } else {
                notesSection
            }
        case .inspiration:
            if ideas.inspiration.isEmpty {
                EmptyState(
                    title: "Nothing saved yet",
                    message: "Save posts and clips you like and they'll show up here."
                )
            } else {
                inspirationGrid
            }
        }
    }

    @ViewBuilder private var notesSection: some View {
        FolderList(
            folders: ideas.folders,
            count: { ideas.notes(in: $0).count },
            onRename: { folderPrompt = .rename($0) },
            onDelete: { ideas.deleteFolder(id: $0.id) }
        )
        NotesGrid(notes: loose, ideas: ideas, onMove: { moving = $0 })
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.bold))
            .foregroundStyle(.secondary)
    }

    private var inspirationGrid: some View {
        LazyVGrid(columns: ideaColumns, spacing: 14) {
            ForEach(ideas.inspiration) { item in
                InspirationCard(item: item, ideas: ideas)
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            ideas.deleteInspiration(id: item.id)
                        }
                        .tint(.red)
                    }
            }
        }
    }
}

let ideaColumns = [GridItem(.adaptive(minimum: 160, maximum: 260), spacing: 14)]

/// One folder's notes, pushed from the Ideas screen.
struct NoteFolderScreen: View {
    @Bindable var ideas: IdeasModel
    var media: MediaModel
    let folder: NoteFolder
    let onMove: (Note) -> Void

    private var notes: [Note] { ideas.notes(in: folder.id) }

    var body: some View {
        ScrollView {
            if notes.isEmpty {
                EmptyState(
                    title: "This folder is empty",
                    message: "Notes you move here — or write here — show up in this folder."
                )
                .padding(.top, 40)
            } else {
                NotesGrid(notes: notes, ideas: ideas, onMove: onMove)
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
            }
        }
        .refreshable { await media.sync?.refreshNow() }
        .navigationTitle(ideas.folder(folder.id)?.name ?? folder.name)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New note", systemImage: "square.and.pencil") {
                    ideas.openEditor(in: folder.id)
                }
            }
        }
    }
}

/// The Apple-standard folder list: a row per folder with its count, opened by
/// a tap, renamed or deleted by a swipe or a long press.
struct FolderList: View {
    let folders: [NoteFolder]
    let count: (UUID) -> Int
    let onRename: (NoteFolder) -> Void
    let onDelete: (NoteFolder) -> Void

    var body: some View {
        if !folders.isEmpty {
            VStack(spacing: 0) {
                ForEach(folders) { folder in
                    NavigationLink(value: folder) {
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill")
                                .font(.title3)
                                .foregroundStyle(.tint)
                            Text(folder.name)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text("\(count(folder.id))")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 12)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Rename", systemImage: "pencil") { onRename(folder) }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            onDelete(folder)
                        }
                    }
                    if folder.id != folders.last?.id {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 14)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct NotesGrid: View {
    let notes: [Note]
    var ideas: IdeasModel
    let onMove: (Note) -> Void

    var body: some View {
        LazyVGrid(columns: ideaColumns, spacing: 14) {
            ForEach(notes) { note in
                Button {
                    ideas.openEditor(for: note)
                } label: {
                    NoteCard(note: note)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Move to Folder…", systemImage: "folder") { onMove(note) }
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        ideas.deleteNote(id: note.id)
                    }
                    .tint(.red)
                }
            }
        }
    }
}

/// Where a note is filed, chosen from the folders that exist — or a new one
/// named on the spot.
struct MoveToFolderSheet: View {
    var ideas: IdeasModel
    let note: Note

    @State private var prompt: FolderPrompt?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(name: "Notes", systemImage: "note.text", folderId: nil)
                    ForEach(ideas.folders) { folder in
                        row(name: folder.name, systemImage: "folder", folderId: folder.id)
                    }
                }
                Section {
                    Button("New Folder…", systemImage: "folder.badge.plus") { prompt = .create }
                }
            }
            .navigationTitle("Move Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            // A folder made here takes the note with it.
            .folderPrompt($prompt, ideas: ideas) { folder in
                ideas.move(noteId: note.id, to: folder.id)
                dismiss()
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(name: String, systemImage: String, folderId: UUID?) -> some View {
        Button {
            ideas.move(noteId: note.id, to: folderId)
            dismiss()
        } label: {
            HStack {
                Label(name, systemImage: systemImage)
                Spacer()
                if note.folderId == folderId {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
        }
        .foregroundStyle(.primary)
    }
}

/// Naming a folder: the standard alert with a text field, for a new folder or
/// a rename.
enum FolderPrompt: Identifiable {
    case create
    case rename(NoteFolder)

    var id: String {
        switch self {
        case .create: "create"
        case .rename(let folder): folder.id.uuidString
        }
    }

    var title: String {
        switch self {
        case .create: "New Folder"
        case .rename: "Rename Folder"
        }
    }

    var initialName: String {
        switch self {
        case .create: ""
        case .rename(let folder): folder.name
        }
    }
}

extension View {
    func folderPrompt(
        _ prompt: Binding<FolderPrompt?>,
        ideas: IdeasModel,
        onCreate: @escaping (NoteFolder) -> Void = { _ in }
    ) -> some View {
        modifier(FolderPromptModifier(prompt: prompt, ideas: ideas, onCreate: onCreate))
    }
}

private struct FolderPromptModifier: ViewModifier {
    @Binding var prompt: FolderPrompt?
    var ideas: IdeasModel
    let onCreate: (NoteFolder) -> Void

    @State private var name = ""

    func body(content: Content) -> some View {
        content
            .alert(prompt?.title ?? "", isPresented: showing, presenting: prompt) { prompt in
                TextField("Name", text: $name)
                    .textInputAutocapitalization(.words)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    switch prompt {
                    case .create:
                        if let folder = ideas.addFolder(named: name) { onCreate(folder) }
                    case .rename(let folder):
                        ideas.renameFolder(id: folder.id, to: name)
                    }
                }
            } message: { _ in
                Text("Enter a name for this folder.")
            }
            .onChange(of: prompt?.id) { _, _ in
                name = prompt?.initialName ?? ""
            }
    }

    private var showing: Binding<Bool> {
        Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } })
    }
}

struct NoteCard: View {
    let note: Note

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !note.title.isEmpty {
                Text(note.title)
                    .font(.subheadline.weight(.bold))
            }
            Text(note.body)
                .font(.footnote)
                .opacity(0.75)
                .lineLimit(8)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color.notePaperInk)
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        .background(note.color.backgroundColor)
        .overlay(alignment: .bottomTrailing) {
            FoldCorner()
                .fill(note.color.accentColor)
                .frame(width: 30, height: 30)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

struct FoldCorner: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct InspirationCard: View {
    let item: InspirationItem
    var ideas: IdeasModel

    var body: some View {
        // A saved link becomes its media: the cloud fetches the source and the
        // phone brings the video or photo down, so the card plays what the
        // link pointed at. Until it lands the card holds the source's name.
        if let media = item.media {
            let url = ideas.mediaURL(fileName: media.fileName)
            MediaTile(ratio: 3 / 4) {
                if media.isVideo {
                    VideoPlayer(player: AVPlayer(url: url))
                } else if let image = UIImage(contentsOfFile: url.localPath) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
            }
        } else if let link = item.link {
            LinkCard(url: link, state: item.importState)
        }
    }
}

/// A saved link with no media yet: fetching, or a source that had none.
struct LinkCard: View {
    let url: URL
    let state: InspirationImport

    var body: some View {
        let host = url.host()?.replacingOccurrences(of: "www.", with: "") ?? "link"
        Link(destination: url) {
            VStack(alignment: .leading, spacing: 8) {
                Label(host, systemImage: "link")
                    .font(.footnote.weight(.bold))
                    .lineLimit(1)
                if state == .failed {
                    Text(url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .multilineTextAlignment(.leading)
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Fetching…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            .background(.fill.tertiary)
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
    }
}

struct LinkSheet: View {
    @Bindable var app: AppModel
    var ideas: IdeasModel

    @State private var urlText = ""
    @FocusState private var urlFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                TextField("TikTok, Reels, YouTube, link...", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($urlFocused)
                    .onSubmit(saveURL)
            }
            .navigationTitle("Paste Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: saveURL)
                        .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .task { urlFocused = true }
    }

    private func saveURL() {
        guard ideas.addInspiration(urlText: urlText) else { return }
        dismiss()
        app.show(toast: "Fetching the link…")
    }
}
#endif
