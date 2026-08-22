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
/// The cut can be kept: an export control under the player's own sound button
/// opens a sheet of sizes, and picking one renders the whole timeline in the
/// cloud — the same render the editor's export produces — then puts the
/// finished file in the photo library. The render outlives this screen, so
/// closing the player and coming back finds it where it was.
struct ProjectPlayerView: View {
    let project: Project
    var projects: ProjectsModel

    @State private var player: AVPlayer?
    @State private var streamed: URL?
    @State private var failed = false
    @State private var showingExport = false
    @State private var choice = ProjectExportSize.all[0].id
    /// What the direct save of an existing render is doing. A cloud render
    /// reports through the model instead, so it survives this screen.
    @State private var local: ExportPhase = .idle
    @State private var chromeShown = true
    /// Bumped on every tap, so the fade-out timer starts over.
    @State private var chromeTick = 0
    @Environment(\.dismiss) private var dismiss

    /// The row of choices the sheet shows, plus how the export control reads.
    private enum ExportPhase: Equatable {
        case idle
        /// Working, with the step it is on and how far along, when that is known.
        case working(String, Double?)
        case saved
        case failed(String)
    }

    /// The choice that saves the render the project already has, without
    /// spending a new one. Offered only when what streams is a real export.
    private static let latestId = "latest"

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            video
            chrome
            exportControl
        }
        .task { await load() }
        .onDisappear { player?.pause() }
        .sheet(isPresented: $showingExport) { exportSheet }
        // A render that finished while this screen was away lands here: the
        // file is on the device, and the photo library is this layer's to write.
        .task(id: readyFile) {
            guard let readyFile else { return }
            await commit(readyFile)
        }
        // What a finished export says clears itself, so the control goes back
        // to offering the next one instead of wearing its last answer.
        .task(id: phase) {
            guard settled else { return }
            try? await Task.sleep(for: .seconds(2.5))
            projects.clearExport(project.id)
            local = .idle
        }
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

    /// The close button and the project's name, on the same row as the
    /// player's own controls — which own the corner, so the row stops short
    /// of it.
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
            Text(live.name)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .lineLimit(1)
            Spacer(minLength: 8)
        }
        .padding(16)
        .padding(.trailing, 52)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .opacity(chromeShown ? 1 : 0)
        .allowsHitTesting(chromeShown)
        .animation(.easeInOut(duration: 0.2), value: chromeShown)
        // Fades out the way the player's controls do, and stays while the
        // video is paused.
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

    /// The export control, directly under the player's sound button and lined
    /// up with it: same corner, same inset, same round glass, and on screen
    /// exactly when the sound button is. A render in flight shows its progress
    /// on the button itself, so what it is doing reads without a second panel.
    private var exportControl: some View {
        VStack(alignment: .trailing, spacing: 8) {
            // The player's own top row owns this much of the corner; the
            // control sits under it.
            Color.clear.frame(width: 40, height: 40)
            Button {
                showingExport = true
            } label: {
                Group {
                    switch phase {
                    case .idle:
                        Image(systemName: "square.and.arrow.down")
                    case .working(_, let ratio):
                        if let ratio {
                            ProgressRing(ratio: ratio)
                        } else {
                            ProgressView().tint(.white)
                        }
                    case .saved:
                        Image(systemName: "checkmark")
                    case .failed:
                        Image(systemName: "exclamationmark.triangle")
                    }
                }
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
            }
            .glassEffect(.regular.interactive())
            .disabled(working)
            .accessibilityLabel("Export video")
            if let note {
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
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .opacity(chromeShown && player != nil ? 1 : 0)
        .allowsHitTesting(chromeShown && player != nil)
        .animation(.easeInOut(duration: 0.2), value: chromeShown)
        .animation(.snappy, value: phase)
    }

    /// The export sheet: the sizes the editor's own dialog offers. Picking one
    /// renders the whole timeline in the cloud, so what saves is the cut as it
    /// stands rather than whatever happens to be streaming.
    private var exportSheet: some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(spacing: 8) {
                    ForEach(choices, id: \.id) { option in
                        Button { choice = option.id } label: { choiceRow(option) }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(choice == option.id ? [.isSelected] : [])
                    }
                }
                Spacer(minLength: 0)
                Button {
                    showingExport = false
                    Task { await start() }
                } label: {
                    Text(choice == Self.latestId ? "Save to Photos" : "Export & Save to Photos")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Text(
                    choice == Self.latestId
                        ? "The render this project already has downloads to this device and lands in your photo library."
                        : "The cut renders in the cloud at full quality, then lands in your photo library. It keeps going if you leave this screen."
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

    private func choiceRow(_ option: ProjectExportSize) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.subheadline.weight(.medium))
                Text(option.note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
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

    /// The project as the listing has it now — a render that just finished is
    /// an export the moment the refresh lands, so the sheet offers it.
    private var live: Project {
        projects.projects.first { $0.id == project.id } ?? project
    }

    /// A finished render is worth keeping without spending another one, so it
    /// leads the list when the project has one.
    private var choices: [ProjectExportSize] {
        let sizes = ProjectExportSize.all
        guard hasExport else { return sizes }
        return [
            ProjectExportSize(
                id: Self.latestId,
                label: "Latest export",
                note: "already rendered · saves right away"
            )
        ] + sizes
    }

    /// Whether what streams is a render someone exported, rather than the
    /// editor's own composited proxy.
    private var hasExport: Bool {
        if case .ready(_, let isPreview) = live.export { return !isPreview }
        return false
    }

    // MARK: Export state

    /// Where the export stands: the cloud render when one is running, and the
    /// direct save of an existing render otherwise.
    private var phase: ExportPhase {
        switch projects.exportRuns[project.id] {
        case .queued: .working("Queued…", nil)
        case .rendering(let ratio): .working("Rendering… \(Int((ratio * 100).rounded()))%", ratio)
        case .downloading: .working("Downloading…", nil)
        case .ready: .working("Saving…", nil)
        case .saved: .saved
        case .failed(let message): .failed(message)
        case nil: local
        }
    }

    /// The rendered file waiting to go into the photo library.
    private var readyFile: URL? {
        if case .ready(let file) = projects.exportRuns[project.id] { return file }
        return nil
    }

    private var working: Bool {
        if case .working = phase { return true }
        return false
    }

    /// An export that has finished, one way or the other.
    private var settled: Bool {
        switch phase {
        case .idle, .working: false
        case .saved, .failed: true
        }
    }

    private var note: String? {
        switch phase {
        case .idle: nil
        case .working(let step, _): step
        case .saved: "Saved to Photos"
        case .failed(let message): message
        }
    }

    // MARK: Work

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
    }

    /// Ask for the photo library first — a render refused at the end would
    /// have spent minutes of encoding for nothing — then either queue the
    /// cloud render or download the render the project already has.
    private func start() async {
        guard await photosAllowed() else {
            local = .failed("Allow photo access in Settings to save videos.")
            return
        }
        if choice == Self.latestId {
            await saveLatest()
            return
        }
        guard let size = ProjectExportSize.all.first(where: { $0.id == choice }) else { return }
        projects.export(project, size: size)
    }

    private func photosAllowed() async -> Bool {
        switch await PHPhotoLibrary.requestAuthorization(for: .addOnly) {
        case .authorized, .limited: true
        default: false
        }
    }

    /// Download the render the project already has and add it to the photo
    /// library. The stream URL is resolved again rather than reused: a CDN
    /// link minted when the view opened can expire while the video plays.
    private func saveLatest() async {
        local = .working("Downloading…", nil)
        guard let url = await projects.streamURL(for: project) ?? streamed else {
            local = .failed("Couldn't reach this project's video.")
            return
        }
        do {
            let file = try await downloadedCopy(of: url)
            defer { try? FileManager.default.removeItem(at: file) }
            local = .working("Saving…", nil)
            try await addToLibrary(file)
            local = .saved
        } catch {
            local = .failed("Couldn't save this video.")
        }
    }

    /// Put a finished cloud render in the photo library and tell the model how
    /// it went, so the run ends and its temporary copy goes with it.
    private func commit(_ file: URL) async {
        guard await photosAllowed() else {
            projects.finishExport(project.id, error: "Allow photo access in Settings to save videos.")
            return
        }
        do {
            try await addToLibrary(file)
            projects.finishExport(project.id, error: nil)
        } catch {
            projects.finishExport(project.id, error: "Couldn't save this video.")
        }
    }

    private func addToLibrary(_ file: URL) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: file, options: nil)
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
}

/// How far a render has got, drawn on the export control itself — the ring the
/// player's own buttons are the size of.
private struct ProgressRing: View {
    let ratio: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.3), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: max(0.02, min(1, ratio)))
                .stroke(.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 22, height: 22)
        .animation(.easeInOut(duration: 0.3), value: ratio)
    }
}

#endif
