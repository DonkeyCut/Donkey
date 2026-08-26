#if os(iOS)
import AVFoundation
import AVKit
import Combine
import Photos
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
    /// The inspiration item open full screen. A card is a tile; the media
    /// plays in the viewer, the way a Library clip does.
    @State private var viewing: InspirationItem?
    @State private var path: [NoteFolder] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if media.waitingForWiFi {
                    WiFiBanner()
                }
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
        .fullScreenCover(item: $viewing) { item in
            InspirationViewer(item: item, ideas: ideas)
        }
        .folderPrompt($folderPrompt, ideas: ideas)
        .photosPicker(
            isPresented: $showsPhotoPicker,
            selection: $pickerItems,
            matching: .any(of: [.images, .videos]),
            photoLibrary: .shared()
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
                    guard let saved = ideas.addInspiration(mediaData: data, isVideo: isVideo),
                          let media = saved.localMedia else { continue }
                    // The card takes the media's own shape, so what landed is
                    // measured here the way the cloud measures what it fetches.
                    if let size = await mediaPixelSize(
                        at: ideas.mediaURL(fileName: media.fileName),
                        isVideo: isVideo
                    ) {
                        ideas.recordSize(id: saved.id, width: size.width, height: size.height)
                    }
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
            Button("Camera roll", systemImage: "photo") { openCameraRoll() }
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

    /// The camera roll reads the library, so the import asks for access
    /// before it opens. Full access shows everything; a limited grant shows
    /// the items the user hands over, with Manage inside the picker to add
    /// more. Either choice is changeable later in Settings.
    private func openCameraRoll() {
        Task {
            switch await PHPhotoLibrary.requestAuthorization(for: .readWrite) {
            case .authorized, .limited:
                showsPhotoPicker = true
            default:
                app.show(toast: "Allow photo access in Settings to import from your camera roll.")
            }
        }
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

    // Cards keep their media's shape, so the two columns run at their own
    // heights and each item is placed in whichever column is shorter.
    private var inspirationGrid: some View {
        HStack(alignment: .top, spacing: 14) {
            ForEach(Array(inspirationColumns.enumerated()), id: \.offset) { _, column in
                VStack(spacing: 14) {
                    ForEach(column) { item in
                        InspirationCard(item: item, ideas: ideas) { viewing = item }
                            .contextMenu {
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    ideas.deleteInspiration(id: item.id)
                                }
                                .tint(.red)
                            }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// The items dealt into columns by the height each one will take at a
    /// column's width: the next card goes to whichever column is shorter, so
    /// the two ends stay level however the shapes fall.
    private var inspirationColumns: [[InspirationItem]] {
        var columns: [[InspirationItem]] = [[], []]
        var heights = [0.0, 0.0]
        for item in ideas.inspiration {
            let target = heights[0] <= heights[1] ? 0 : 1
            columns[target].append(item)
            heights[target] += 1 / (item.aspectRatio ?? InspirationCard.defaultRatio)
        }
        return columns
    }
}

let ideaColumns = [GridItem(.adaptive(minimum: 160, maximum: 260), spacing: 14)]

/// What a photo or a video imported from the photo library measures, in
/// pixels, read off the file the store just wrote.
func mediaPixelSize(at url: URL, isVideo: Bool) async -> (width: Int, height: Int)? {
    if !isVideo {
        guard let image = UIImage(contentsOfFile: url.localPath) else { return nil }
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        return (Int(size.width.rounded()), Int(size.height.rounded()))
    }
    let asset = AVURLAsset(url: url)
    guard let track = try? await asset.loadTracks(withMediaType: .video).first,
          let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform)
    else { return nil }
    let rect = CGRect(origin: .zero, size: natural).applying(transform)
    return (Int(abs(rect.width).rounded()), Int(abs(rect.height).rounded()))
}

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
                    NoteCard(note: note, labels: ideas.labels(on: note))
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
    var labels: [NoteLabel] = []

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
            if !labels.isEmpty {
                NoteLabelChips(names: labels.map(\.name))
            }
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

/// The labels a note wears, as small chips wrapping onto as many lines as
/// they need. Drawn in the note paper's ink, on the card and in the editor.
struct NoteLabelChips: View {
    let names: [String]

    var body: some View {
        ChipWrap(spacing: 5) {
            ForEach(names, id: \.self) { name in
                Text(name)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.black.opacity(0.1), in: Capsule())
            }
        }
        // Stay clear of the card's folded corner.
        .padding(.trailing, 18)
    }
}

/// Lays subviews left to right, wrapping to a new line when the width runs
/// out.
///
/// The height depends on the width, and a container is free to ask for a size
/// without naming one — a card measured inside a scrolling grid does exactly
/// that. Answering such an ask with a single line would report a height the
/// placement then overflows, and the extra rows would be clipped by the card,
/// so the width the layout was last placed at is remembered and answers for
/// the one that was not given. The same cache holds the frames themselves,
/// which the measure and the placement would otherwise each compute.
struct ChipWrap: Layout {
    var spacing: CGFloat = 5

    struct Cache {
        /// The last width `frames` was computed for, and its result.
        var width: CGFloat?
        var frames: [CGRect] = []
        var bounds: CGSize = .zero
        /// The width the layout was actually placed at, for an ask that names none.
        var placed: CGFloat?
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache.width = nil
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        layout(subviews, in: proposal.width ?? cache.placed ?? .infinity, cache: &cache).bounds
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        cache.placed = bounds.width
        for (frame, subview) in zip(layout(subviews, in: bounds.width, cache: &cache).frames, subviews) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size)
            )
        }
    }

    private func layout(
        _ subviews: Subviews,
        in width: CGFloat,
        cache: inout Cache
    ) -> (frames: [CGRect], bounds: CGSize) {
        if cache.width == width { return (cache.frames, cache.bounds) }
        let laid = frames(for: subviews, in: width)
        cache.width = width
        cache.frames = laid.frames
        cache.bounds = laid.bounds
        return laid
    }

    private func frames(for subviews: Subviews, in width: CGFloat) -> (frames: [CGRect], bounds: CGSize) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            widest = max(widest, x - spacing)
        }
        return (frames, CGSize(width: widest, height: y + rowHeight))
    }
}

struct InspirationCard: View {
    let item: InspirationItem
    var ideas: IdeasModel
    let onOpen: () -> Void

    @State private var confirmingDelete = false

    /// The shape a card holds while nothing has measured its media yet.
    static let defaultRatio = 9.0 / 14

    var body: some View {
        // A card is the media itself, the way a Library clip and a project
        // card are. What the source said rides along in the viewer.
        if item.localMedia != nil || item.cloud != nil {
            InspirationPoster(item: item, ideas: ideas)
                .contentShape(.rect)
                .onTapGesture(perform: onOpen)
                .contextMenu {
                    InspirationActions(item: item, shareURL: item.link) { confirmingDelete = true }
                }
                .confirmationDialog(
                    "Delete this?",
                    isPresented: $confirmingDelete,
                    titleVisibility: .visible
                ) {
                    Button("Delete", role: .destructive) { ideas.deleteInspiration(id: item.id) }
                } message: {
                    Text("It goes from this phone and from your cloud library.")
                }
        } else if let link = item.link {
            LinkCard(url: link, state: item.importState, text: item.sourceText) {
                ideas.retryInspiration(id: item.id)
            }
        }
    }
}

/// The tile itself: a photo-library import off this phone, or the poster the
/// cloud fetched beside a link's media. A cloud image with no poster paints
/// from the stream.
struct InspirationPoster: View {
    let item: InspirationItem
    var ideas: IdeasModel

    @State private var streamed: URL?
    /// The first frame of a video imported from the photo library, which
    /// arrives as bytes with no still of its own.
    @State private var frame: UIImage?

    var body: some View {
        MediaTile(ratio: item.aspectRatio ?? InspirationCard.defaultRatio) {
            if let image = localImage ?? frame {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let streamed, item.cloud?.isVideo == false {
                AsyncImage(url: streamed) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    ProgressView()
                }
            } else {
                Image(systemName: item.isVideo ? "play.fill" : "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: item.id) {
            guard localImage == nil else { return }
            if let local = item.localMedia, local.isVideo {
                frame = await firstFrame(of: ideas.mediaURL(fileName: local.fileName))
                return
            }
            guard streamed == nil, let cloud = item.cloud else { return }
            let url = await ideas.streamURL(for: cloud)
            streamed = url
            // A source that came back without a cover still gets a tile: the
            // frame is read off the stream itself.
            if let url, cloud.isVideo, cloud.posterFileName == nil {
                frame = await firstFrame(of: url)
            }
        }
    }

    private func firstFrame(of url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        guard let image = try? await generator.image(at: .zero).image else { return nil }
        return UIImage(cgImage: image)
    }

    /// The still this phone holds: an imported photo, or a fetched link's
    /// poster.
    private var localImage: UIImage? {
        if let local = item.localMedia, !local.isVideo {
            return UIImage(contentsOfFile: ideas.mediaURL(fileName: local.fileName).localPath)
        }
        guard let poster = item.cloud?.posterFileName else { return nil }
        return UIImage(contentsOfFile: ideas.mediaURL(fileName: poster).localPath)
    }
}

/// The actions an item carries wherever it shows: the card's long press and
/// the viewer's menu offer the same ones.
struct InspirationActions: View {
    let item: InspirationItem
    let shareURL: URL?
    let onDelete: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        if let shared = shareURL {
            ShareLink(item: shared) { Label("Share", systemImage: "square.and.arrow.up") }
        }
        if let link = item.link {
            Button { openURL(link) } label: { Label("Open original", systemImage: "safari") }
        }
        Divider()
        Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
    }
}

/// One inspiration item full screen: the video plays under chrome this view
/// draws itself, a photo fills the screen, and close, share, open and delete
/// ride the same glass the Library player wears.
struct InspirationViewer: View {
    let item: InspirationItem
    var ideas: IdeasModel

    @State private var player: AVPlayer?
    @State private var url: URL?
    @State private var unplayable = false
    @State private var confirmingDelete = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            media
            chrome
        }
        .statusBarHidden()
        .confirmationDialog("Delete this?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                ideas.deleteInspiration(id: item.id)
                dismiss()
            }
        } message: {
            Text("It goes from this phone and from your cloud library.")
        }
        .task {
            guard let url = await source() else { return }
            self.url = url
            guard item.isVideo else { return }
            let asset = AVPlayerItem(url: url)
            let player = AVPlayer(playerItem: asset)
            self.player = player
            player.play()
            // A file iOS can't decode stalls on a black screen otherwise; the
            // item reports it, so say it in words the reader can act on.
            for await status in asset.publisher(for: \.status).values {
                if status == .failed {
                    self.player = nil
                    unplayable = true
                }
                if status != .unknown { return }
            }
        }
        .onDisappear { player?.pause() }
    }

    @ViewBuilder private var media: some View {
        if unplayable {
            Text("This one's format won't play on iPhone. Delete the card and paste the link again.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(32)
        } else if let player {
            PlayerSurface(player: player)
                .ignoresSafeArea()
                .onTapGesture {
                    if player.timeControlStatus == .paused { player.play() } else { player.pause() }
                }
        } else if let url, !item.isVideo {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                ProgressView().tint(.white)
            }
            .ignoresSafeArea()
        } else {
            ProgressView().tint(.white)
        }
    }

    private var chrome: some View {
        VStack(spacing: 0) {
            GlassEffectContainer {
                HStack(spacing: 10) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                    }
                    .glassEffect(.regular.interactive())
                    Spacer()
                    Menu {
                        InspirationActions(item: item, shareURL: item.link ?? url) {
                            confirmingDelete = true
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                    }
                    .glassEffect(.regular.interactive())
                }
            }
            .padding(16)

            Spacer(minLength: 0)

            if let text = item.sourceText, !text.isEmpty {
                ScrollView {
                    Text(text)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                .frame(maxHeight: 160)
                .background(.black.opacity(0.55))
            }
            if let player {
                PlaybackBar(player: player)
            }
        }
    }

    /// Where the bytes are: on this phone for an import, on the account's
    /// shelf for a link the cloud fetched.
    private func source() async -> URL? {
        if let local = item.localMedia { return ideas.mediaURL(fileName: local.fileName) }
        guard let cloud = item.cloud else { return nil }
        return await ideas.streamURL(for: cloud)
    }
}

/// A saved link with no media of its own: on its way, a source that was only
/// words, or an attempt that failed and says why.
struct LinkCard: View {
    let url: URL
    let state: InspirationImport
    let text: String?
    let onRetry: () -> Void

    var body: some View {
        let host = url.host()?.replacingOccurrences(of: "www.", with: "") ?? "link"
        VStack(alignment: .leading, spacing: 8) {
            Link(destination: url) {
                Label(host, systemImage: "link")
                    .font(.footnote.weight(.bold))
                    .lineLimit(1)
            }
            .buttonStyle(.plain)

            switch state {
            case .queued, .fetching, .ready:
                HStack(spacing: 8) {
                    ProgressView()
                    Text(state == .queued ? "Waiting to fetch…" : "Fetching…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            case .noMedia:
                Text(text ?? url.absoluteString)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                    .multilineTextAlignment(.leading)
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
                Button("Try again", action: onRetry)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
        .background(.fill.tertiary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
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
