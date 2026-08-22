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
    @Environment(\.scenePhase) private var scenePhase

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "Projects", app: app, auth: auth)
            ScrollView {
                if projects.projects.isEmpty {
                    if projects.isLoading {
                        ProgressView()
                            .padding(.top, 80)
                    } else {
                        EmptyState(
                            title: "No projects yet",
                            message: "Projects you create in Donkey Cut will show up here."
                        )
                    }
                } else {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(projects.projects) { project in
                            ProjectCard(project: project) { playing = project }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
            }
            .refreshable { await projects.refresh() }
        }
        // Projects are edited at the desk, so the listing is read again every
        // time this screen comes back into view — opening the tab, coming back
        // to the app, closing a project.
        .task { await projects.refresh() }
        .onChange(of: app.selectedTab) { _, tab in
            guard tab == .projects else { return }
            Task { await projects.refresh() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, app.selectedTab == .projects else { return }
            Task { await projects.refresh() }
        }
        .fullScreenCover(item: $playing, onDismiss: { Task { await projects.refresh() } }) { project in
            ProjectPlayerView(project: project, projects: projects)
        }
    }
}

struct ProjectCard: View {
    let project: Project
    let onPlay: () -> Void

    var body: some View {
        Button(action: onPlay) {
            MediaTile(ratio: 9 / 13) {
                if let thumbnail = project.thumbnail,
                   let image = UIImage(contentsOfFile: thumbnail.localPath) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
                Circle()
                    .fill(ready ? AnyShapeStyle(Color.accentBlue) : AnyShapeStyle(.black.opacity(0.35)))
                    .frame(width: 46, height: 46)
                    .overlay {
                        Image(systemName: "play.fill")
                            .font(.body.weight(.bold))
                            .foregroundStyle(.white)
                            .offset(x: 2)
                    }
                    .animation(.snappy(duration: 0.2), value: ready)
            }
            .overlay(alignment: .topLeading) {
                ProjectTag(text: formattedDuration(project.duration))
                    .padding(8)
            }
            .overlay(alignment: .bottomLeading) {
                ProjectTag(text: caption)
                    .padding(8)
            }
        }
        .buttonStyle(PressableTile())
        .frame(maxWidth: .infinity)
    }

    /// The render this card plays is in hand. The play button is grey while
    /// the listing is still resolving what a tap would stream and turns blue
    /// once it has it.
    private var ready: Bool {
        if case .ready = project.export { return true }
        return false
    }

    /// The card's name line. A project whose render the last listing did not
    /// see still opens: the player reads the project again on the way in.
    private var caption: String {
        switch project.export {
        case .ready(let renderedOn, _): "\(project.name) · \(renderedOn)"
        case .none: project.name
        }
    }
}

/// A tile that answers a touch the moment it lands, before whatever the tap
/// opens has anything to show.
struct PressableTile: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
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

/// Streams the project's latest export, or the composited preview when no
/// export exists. The URL resolves at open time because CDN links expire, and
/// the project is read again on the way in so an edit made at the desk is what
/// plays.
///
/// The video can be kept: a save control beside the player's own sound button
/// opens the export sheet — the same choices the editor offers on the web,
/// sized off the render itself — and the sheet's Save to Photos button is what
/// commits it. It rides with the player's controls, appearing and fading on a
/// tap the way the sound button does.
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
    @State private var chromeShown = true
    /// Bumped on every tap, so the fade-out timer starts over.
    @State private var chromeTick = 0
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
            video
            chrome
        }
        .task { await load() }
        .onDisappear { player?.pause() }
        .sheet(isPresented: $showingExport) { exportSheet }
    }

    @ViewBuilder
    private var video: some View {
        if let player {
            VideoPlayer(player: player)
                .ignoresSafeArea()
                // The player's own controls answer the same tap; watching it
                // alongside them keeps this chrome on their clock.
                .simultaneousGesture(TapGesture().onEnded {
                    chromeShown.toggle()
                    chromeTick += 1
                })
        } else if failed {
            VStack(spacing: 14) {
                Text("Couldn't load this project's video")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Button("Try again") {
                    failed = false
                    Task { await load() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.white.opacity(0.2))
                .foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView()
                .tint(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The close button, the project's name, and the save control, on one row
    /// with the player's sound button — which owns the corner, so the row
    /// stops short of it.
    private var chrome: some View {
        HStack(alignment: .top, spacing: 12) {
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
            Spacer(minLength: 8)
            if player != nil {
                saveControl
            }
        }
        .padding(16)
        .padding(.trailing, 52)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(visible)
        .animation(.easeInOut(duration: 0.2), value: visible)
        // Fades out the way the player's controls do, and stays while the
        // video is paused or a save is running.
        .task(id: chromeTick) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                guard player?.timeControlStatus == .playing else { continue }
                chromeShown = false
                return
            }
        }
    }

    /// Whether the chrome is on screen: what the tap says, and always while a
    /// save is telling the user where it is.
    private var visible: Bool {
        chromeShown || save != .idle
    }

    private func load() async {
        guard let url = await projects.streamURL(for: project) else {
            failed = true
            return
        }
        streamed = url
        let player = AVPlayer(url: url)
        self.player = player
        player.play()
        chromeShown = true
        chromeTick += 1
        source = await SourceVideo.read(url)
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
