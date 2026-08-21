#if os(iOS)
import AVKit
import PhotosUI
import SwiftUI
import DonkeyKitModels

struct IdeasScreen: View {
    @Bindable var app: AppModel
    @Bindable var ideas: IdeasModel
    var auth: AuthModel
    let onRecordNote: (Note) -> Void

    @State private var showsLinkSheet = false
    @State private var showsPhotoPicker = false
    @State private var pickerItems: [PhotosPickerItem] = []

    private let columns = [GridItem(.adaptive(minimum: 160, maximum: 260), spacing: 14)]

    var body: some View {
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
        }
        .overlay(alignment: .bottomTrailing) { addMenu }
        .fullScreenCover(item: $ideas.draft) { _ in
            NoteEditorView(app: app, ideas: ideas, onRecordNote: onRecordNote)
        }
        .sheet(isPresented: $showsLinkSheet) {
            LinkSheet(app: app, ideas: ideas)
                .presentationDetents([.medium])
        }
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
    }

    private var addMenu: some View {
        Menu {
            Button("Paste link", systemImage: "link") { showsLinkSheet = true }
            Button("Camera roll", systemImage: "photo") { showsPhotoPicker = true }
            Button("New note", systemImage: "pencil") { ideas.openEditor() }
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

    @ViewBuilder private var content: some View {
        switch ideas.filter {
        case .all:
            if ideas.notes.isEmpty && ideas.inspiration.isEmpty {
                EmptyState(
                    title: "Nothing here yet",
                    message: "Add a note or save some inspiration to get started."
                )
            } else {
                if !ideas.notes.isEmpty {
                    sectionLabel("Notes")
                    notesGrid
                }
                if !ideas.inspiration.isEmpty {
                    sectionLabel("Inspiration")
                    inspirationGrid
                }
            }
        case .notes:
            if ideas.notes.isEmpty {
                EmptyState(title: "No notes yet", message: "Tap the note button to capture an idea.")
            } else {
                notesGrid
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

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.bold))
            .foregroundStyle(.secondary)
    }

    private var notesGrid: some View {
        LazyVGrid(columns: columns, spacing: 14) {
            ForEach(ideas.notes) { note in
                Button {
                    ideas.openEditor(for: note)
                } label: {
                    NoteCard(note: note)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        ideas.deleteNote(id: note.id)
                    }
                    .tint(.red)
                }
            }
        }
    }

    private var inspirationGrid: some View {
        LazyVGrid(columns: columns, spacing: 14) {
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
        switch item.kind {
        case .link(let url):
            Link(destination: url) {
                VStack(alignment: .leading, spacing: 8) {
                    Label(url.host()?.replacingOccurrences(of: "www.", with: "") ?? "link", systemImage: "link")
                        .font(.footnote.weight(.bold))
                        .lineLimit(1)
                    Text(url.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
                .background(.fill.tertiary)
                .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            .buttonStyle(.plain)
        case .media(let fileName, let isVideo):
            let url = ideas.mediaURL(fileName: fileName)
            MediaTile(ratio: 3 / 4) {
                if isVideo {
                    VideoPlayer(player: AVPlayer(url: url))
                } else if let image = UIImage(contentsOfFile: url.localPath) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
            }
        }
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
        app.show(toast: "Saved to Inspiration")
    }
}
#endif
