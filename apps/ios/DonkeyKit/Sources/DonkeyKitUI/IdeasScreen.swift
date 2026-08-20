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

    @State private var showsInspirationSheet = false

    private let columns = [GridItem(.adaptive(minimum: 160, maximum: 260), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    filterChips
                    content
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Ideas")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarMenu(app: app, auth: auth)
                }
            }
            .overlay(alignment: .bottomTrailing) { fab }
            .fullScreenCover(item: $ideas.draft) { _ in
                NoteEditorView(app: app, ideas: ideas, onRecordNote: onRecordNote)
            }
            .sheet(isPresented: $showsInspirationSheet) {
                InspirationSheet(app: app, ideas: ideas)
                    .presentationDetents([.height(240)])
            }
        }
    }

    private var filterChips: some View {
        HStack(spacing: 10) {
            ForEach(IdeasFilter.allCases, id: \.self) { filter in
                Button {
                    ideas.filter = filter
                } label: {
                    Text(filter.rawValue.capitalized)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                }
                .buttonStyle(.plain)
                .background(
                    Capsule().fill(ideas.filter == filter ? Color.primary.opacity(0.12) : Color.clear)
                )
                .overlay(
                    Capsule().strokeBorder(
                        ideas.filter == filter ? Color.primary : Color.secondary.opacity(0.35),
                        lineWidth: 1.5
                    )
                )
            }
            Spacer()
        }
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
                    }
            }
        }
    }

    private var fab: some View {
        Button {
            if ideas.filter == .inspiration {
                showsInspirationSheet = true
            } else {
                ideas.openEditor()
            }
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.bold))
                .frame(width: 60, height: 60)
        }
        .glassEffect(.regular.interactive())
        .padding(.trailing, 20)
        .padding(.bottom, 20)
        .accessibilityLabel(ideas.filter == .inspiration ? "Save inspiration" : "New note")
    }
}

struct NoteCard: View {
    let note: Note

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(note.title)
                .font(.subheadline.weight(.bold))
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
            Group {
                if isVideo {
                    VideoPlayer(player: AVPlayer(url: url))
                } else if let image = UIImage(contentsOfFile: url.path()) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Rectangle().fill(.fill.tertiary)
                }
            }
            .aspectRatio(3 / 4, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct InspirationSheet: View {
    @Bindable var app: AppModel
    var ideas: IdeasModel

    @State private var urlText = ""
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var urlFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Save inspiration")
                .font(.headline)
            TextField("TikTok, Reels, YouTube, link...", text: $urlText)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($urlFocused)
                .onSubmit(saveURL)
            HStack(spacing: 10) {
                PhotosPicker(selection: $pickerItems, matching: .any(of: [.images, .videos])) {
                    Label("Camera roll", systemImage: "photo.on.rectangle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button("Save", action: saveURL)
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                    .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .presentationDragIndicator(.visible)
        .task { urlFocused = true }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
                    ideas.addInspiration(mediaData: data, isVideo: isVideo)
                }
                pickerItems = []
                dismiss()
                app.show(toast: "Saved to Inspiration")
            }
        }
    }

    private func saveURL() {
        guard ideas.addInspiration(urlText: urlText) else { return }
        dismiss()
        app.show(toast: "Saved to Inspiration")
    }
}
#endif
