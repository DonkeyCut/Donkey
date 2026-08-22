#if os(iOS)
import AVKit
import Photos
import SwiftUI
import DonkeyKitModels

struct ProjectsScreen: View {
    @Bindable var app: AppModel
    var projects: ProjectsModel
    var auth: AuthModel

    @State private var playing: Project?

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Projects", app: app, auth: auth)
            if projects.projects.isEmpty {
                if projects.isLoading {
                    ProgressView()
                        .frame(maxHeight: .infinity)
                } else {
                    EmptyState(
                        title: "No projects yet",
                        message: "Projects you create in Donkey Cut will show up here."
                    )
                    .frame(maxHeight: .infinity)
                }
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(projects.projects) { project in
                            ProjectCard(project: project) { playing = project }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
                .refreshable { await projects.refresh() }
            }
        }
        .task { await projects.refresh() }
        .fullScreenCover(item: $playing) { project in
            ProjectPlayerView(project: project, projects: projects)
        }
    }
}

struct ProjectCard: View {
    let project: Project
    let onPlay: () -> Void

    var body: some View {
        Group {
            switch project.export {
            case .ready(let renderedOn, _):
                Button(action: onPlay) {
                    MediaTile(ratio: 9 / 13) {
                        if let thumbnail = project.thumbnail,
                           let image = UIImage(contentsOfFile: thumbnail.localPath) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        }
                        Circle()
                            .fill(.black.opacity(0.35))
                            .frame(width: 46, height: 46)
                            .overlay {
                                Image(systemName: "play.fill")
                                    .font(.body.weight(.bold))
                                    .foregroundStyle(.white)
                                    .offset(x: 2)
                            }
                    }
                    .overlay(alignment: .topLeading) {
                        ProjectTag(text: formattedDuration(project.duration))
                            .padding(8)
                    }
                    .overlay(alignment: .bottomLeading) {
                        ProjectTag(text: "\(project.name) · \(renderedOn)")
                            .padding(8)
                    }
                }
                .buttonStyle(.plain)
            case .none:
                GhostCard(title: project.name, subtitle: "No export yet")
                    .aspectRatio(9 / 13, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct ProjectTag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct GhostCard: View {
    let title: String
    let subtitle: String

    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .strokeBorder(.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
            .overlay {
                VStack(spacing: 4) {
                    Text(title)
                    Text(subtitle)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
            }
    }
}

/// Streams the project's latest export, or the composited preview when no
/// export exists. The URL resolves at open time because CDN links expire.
///
/// The video can be kept: a save control under the player's own sound button
/// opens the export sheet — the same choices the editor offers on the web,
/// sized off the render itself — and the sheet's Save to Photos button is what
/// commits it.
struct ProjectPlayerView: View {
    let project: Project
    var projects: ProjectsModel

    @State private var player: AVPlayer?
    @State private var streamed: URL?
    @State private var failed = false
    @State private var showingExport = false
    @State private var source: SourceVideo?
    @State private var choice = ExportChoice.original.id
    @State private var save: SaveState = .idle
    @Environment(\.dismiss) private var dismiss

    private enum SaveState: Equatable {
        case idle
        /// Working, with the step it is on — the download, the resize, the file
        /// going into the library.
        case working(String)
        case saved
        case failed(String)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            } else if failed {
                Text("Couldn't load this project's video")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .tint(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 12) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                }
                .glassEffect(.regular.interactive())
                Text(project.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
            .padding(16)
            if player != nil {
                // Down the right edge, under the player's own sound button:
                // the two controls share the inset, so this clears its height.
                saveControl
                    .padding(.top, 68)
                    .padding(.trailing, 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
        .task {
            guard let url = await projects.streamURL(for: project) else {
                failed = true
                return
            }
            streamed = url
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
            source = await SourceVideo.read(url)
        }
        .onDisappear { player?.pause() }
        .sheet(isPresented: $showingExport) { exportSheet }
    }

    private var saveControl: some View {
        VStack(alignment: .trailing, spacing: 8) {
            Button {
                showingExport = true
            } label: {
                Group {
                    switch save {
                    case .idle: Image(systemName: "square.and.arrow.down")
                    case .working: ProgressView().tint(.white)
                    case .saved: Image(systemName: "checkmark")
                    case .failed: Image(systemName: "exclamationmark.triangle")
                    }
                }
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
            }
            .glassEffect(.regular.interactive())
            .disabled(working)
            .accessibilityLabel("Export video")
            if let note = saveNote {
                Text(note)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.trailing)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 190, alignment: .trailing)
            }
        }
        .animation(.snappy, value: save)
        // What a finished save says clears itself, so the control goes back to
        // offering the export instead of wearing its last answer.
        .task(id: save) {
            guard settled else { return }
            try? await Task.sleep(for: .seconds(2.5))
            save = .idle
        }
    }

    /// The export sheet: the choices the web dialog offers, measured against
    /// this render. Original is always the largest, and a size is offered only
    /// while it is smaller than the render itself — resizing up would cost
    /// bytes and quality for nothing.
    private var exportSheet: some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(spacing: 8) {
                    ForEach(choices) { option in
                        Button { choice = option.id } label: { choiceRow(option) }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(choice == option.id ? [.isSelected] : [])
                    }
                }
                Spacer(minLength: 0)
                Button {
                    let picked = choices.first { $0.id == choice } ?? choices[0]
                    showingExport = false
                    Task { await saveToPhotos(picked) }
                } label: {
                    Text("Save to Photos")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Text(
                    playingPreview
                        ? "This project has no export yet, so what saves is the preview the editor renders for itself. Export it in Donkey Cut for a full-quality file."
                        : "The video downloads to this device and lands in your photo library."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }
            .padding(20)
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingExport = false }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func choiceRow(_ option: ExportChoice) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.subheadline.weight(.medium))
                Text(option.detail(for: source))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let size = option.sizeText(for: source) {
                Text(size)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            choice == option.id ? Color.accentColor.opacity(0.12) : Color(.secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(choice == option.id ? Color.accentColor : .clear, lineWidth: 1.5)
        }
    }

    private var choices: [ExportChoice] {
        ExportChoice.all(for: source, isPreview: playingPreview)
    }

    /// Whether what is streaming is the editor's own composited proxy rather
    /// than a render someone exported.
    private var playingPreview: Bool {
        if case .ready(_, let isPreview) = project.export { return isPreview }
        return false
    }

    private var working: Bool {
        if case .working = save { return true }
        return false
    }

    /// A save that has finished, one way or the other.
    private var settled: Bool {
        switch save {
        case .idle, .working: false
        case .saved, .failed: true
        }
    }

    private var saveNote: String? {
        switch save {
        case .idle: nil
        case .working(let step): step
        case .saved: "Saved to Photos"
        case .failed(let message): message
        }
    }

    /// Download the render, resize it when a smaller size was picked, and add
    /// it to the photo library. The stream URL is resolved again rather than
    /// reused: a CDN link minted when the view opened can expire while the
    /// video plays.
    private func saveToPhotos(_ option: ExportChoice) async {
        save = .working("Saving…")
        switch await PHPhotoLibrary.requestAuthorization(for: .addOnly) {
        case .authorized, .limited: break
        default:
            save = .failed("Allow photo access in Settings to save videos.")
            return
        }
        guard let url = await projects.streamURL(for: project) ?? streamed else {
            save = .failed("Couldn't reach this project's video.")
            return
        }
        do {
            save = .working("Downloading…")
            let downloaded = try await downloadedCopy(of: url)
            var file = downloaded
            if let preset = option.preset {
                save = .working("Resizing…")
                do {
                    file = try await resized(downloaded, preset: preset)
                    try? FileManager.default.removeItem(at: downloaded)
                } catch {
                    // The render is in hand and the library takes it as it is,
                    // so a resize that fails saves the original instead of
                    // costing the whole export.
                    file = downloaded
                }
            }
            defer { try? FileManager.default.removeItem(at: file) }
            save = .working("Saving…")
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: file, options: nil)
            }
            save = .saved
        } catch {
            save = .failed("Couldn't save this video.")
        }
    }

    /// The render on disk, named with an extension Photos recognizes — the
    /// download's own temp file has none, and the library reads the container
    /// from the name.
    private func downloadedCopy(of url: URL) async throws -> URL {
        let (temp, response) = try await URLSession.shared.download(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: temp)
            throw CloudSyncError.transport
        }
        let ext = url.pathExtension.isEmpty ? "mp4" : url.pathExtension.lowercased()
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(ext)")
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temp, to: file)
        return file
    }

    /// The same picture inside a smaller box. AVFoundation fits the frame to
    /// the preset and keeps the aspect, so a portrait cut stays portrait.
    private func resized(_ file: URL, preset: String) async throws -> URL {
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: file), presetName: preset) else {
            throw CloudSyncError.transport
        }
        let out = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: out)
        try await session.export(to: out, as: .mp4)
        return out
    }
}

/// What the render on the other end of the stream is: its frame, its length,
/// and how many bytes it holds. The export sheet is measured from this, so the
/// choices describe the video the phone would actually save.
struct SourceVideo: Equatable, Sendable {
    var width: Int
    var height: Int
    var duration: TimeInterval
    /// Bytes over the wire, or 0 when the host answered no HEAD.
    var bytes: Int64

    var shortSide: Int { min(width, height) }
    var pixels: Int { max(1, width * height) }

    static func read(_ url: URL) async -> SourceVideo? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (size, transform) = try? await track.load(.naturalSize, .preferredTransform)
        else { return nil }
        let frame = size.applying(transform)
        let seconds = (try? await asset.load(.duration))?.seconds ?? 0
        var head = URLRequest(url: url)
        head.httpMethod = "HEAD"
        let response = try? await URLSession.shared.data(for: head).1
        let bytes = response?.expectedContentLength ?? -1
        return SourceVideo(
            width: Int(abs(frame.width).rounded()),
            height: Int(abs(frame.height).rounded()),
            duration: seconds.isFinite ? seconds : 0,
            bytes: bytes > 0 ? bytes : 0
        )
    }
}

/// One row of the export sheet. `preset` is the AVFoundation box the picture
/// is fitted into; the original carries none, since it is saved as it came
/// down.
struct ExportChoice: Identifiable, Equatable, Sendable {
    var id: String
    var label: String
    var note: String
    var shortSide: Int?
    var preset: String?

    static let original = ExportChoice(
        id: "original",
        label: "Original · matches source",
        note: "H.264 · best quality",
        shortSide: nil,
        preset: nil
    )

    /// What stands in for the original when the project has never been
    /// exported: the proxy, named as one.
    static let preview = ExportChoice(
        id: "original",
        label: "Preview · not an export",
        note: "what the editor's grid plays",
        shortSide: nil,
        preset: nil
    )

    /// Original first, then every size smaller than the render — the same
    /// order the editor's dialog lists, largest to smallest.
    static func all(for source: SourceVideo?, isPreview: Bool = false) -> [ExportChoice] {
        let full = isPreview ? preview : original
        let steps = [
            ExportChoice(
                id: "hd",
                label: "Best · 1080p",
                note: "smaller file",
                shortSide: 1080,
                preset: AVAssetExportPreset1920x1080
            ),
            ExportChoice(
                id: "sd",
                label: "Draft · 720p",
                note: "smallest file",
                shortSide: 720,
                preset: AVAssetExportPreset1280x720
            ),
        ]
        guard let source else { return [full] }
        return [full] + steps.filter { step in
            guard let side = step.shortSide else { return false }
            return source.shortSide > side
        }
    }

    /// The frame this choice saves: the render's own, or its aspect fitted to
    /// the short side.
    func frame(for source: SourceVideo) -> (width: Int, height: Int) {
        guard let side = shortSide, source.shortSide > side else {
            return (source.width, source.height)
        }
        let scale = Double(side) / Double(source.shortSide)
        let even = { (n: Int) in 2 * Int((Double(n) * scale / 2).rounded()) }
        return (even(source.width), even(source.height))
    }

    func detail(for source: SourceVideo?) -> String {
        guard let source, source.width > 0 else { return note }
        let frame = frame(for: source)
        return "\(frame.width) × \(frame.height) · \(note)"
    }

    /// What it costs to keep. The original's size is the one the host reported;
    /// a resize is scaled by how much of the picture is left, which is what
    /// changes the bitrate.
    func sizeText(for source: SourceVideo?) -> String? {
        guard let source, source.bytes > 0 else { return nil }
        let frame = frame(for: source)
        let share = Double(frame.width * frame.height) / Double(source.pixels)
        return formattedSize(Double(source.bytes) * min(1, share))
    }

    private func formattedSize(_ bytes: Double) -> String {
        let mb = bytes / (1024 * 1024)
        if mb < 1 { return "~1 MB" }
        if mb < 1000 { return mb < 10 ? String(format: "~%.1f MB", mb) : "~\(Int(mb.rounded())) MB" }
        return String(format: "~%.1f GB", mb / 1024)
    }
}

#endif
