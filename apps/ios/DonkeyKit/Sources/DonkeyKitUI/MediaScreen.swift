#if os(iOS)
import AVKit
import SwiftUI
import DonkeyKitModels

struct MediaScreen: View {
    @Bindable var app: AppModel
    var media: MediaModel
    var auth: AuthModel

    @State private var playing: Recording?
    /// Photos' select mode: the header's control turns the grid into a
    /// picker, cards take checkmarks, and the actions that work on many
    /// clips at once ride the bar at the bottom.
    @State private var selecting = false
    @State private var selection: Set<UUID> = []
    @State private var confirmingDelete = false

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            if media.storageFull {
                StorageBanner()
            }
            ScreenHeader(title: headerTitle, app: app, auth: auth) {
                if selecting {
                    Button("Cancel") { endSelecting() }
                        .font(.body.weight(.semibold))
                } else if !media.recordings.isEmpty {
                    Button("Select") { selecting = true }
                        .font(.body.weight(.semibold))
                }
            }
            Group {
                if media.recordings.isEmpty {
                    EmptyState(
                        title: "No clips yet",
                        message: "Anything you record with the camera lands here.",
                        actionTitle: "Open camera"
                    ) {
                        app.selectedTab = .camera
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(media.recordings) { recording in
                                card(for: recording)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 14)
                        .padding(.bottom, 24)
                    }
                    .refreshable { await media.sync?.refreshNow() }
                }
            }
            if selecting {
                SelectionBar(
                    urls: selectedURLs,
                    allSelected: selection.count == media.recordings.count,
                    toggleAll: toggleAll,
                    delete: { confirmingDelete = true }
                )
            }
        }
        .animation(.snappy(duration: 0.2), value: selecting)
        .onChange(of: media.recordings.isEmpty) { _, empty in
            if empty { endSelecting() }
        }
        .confirmationDialog(
            selection.count == 1 ? "Delete Video?" : "Delete \(selection.count) Videos?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { deleteSelected() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The clips go from this phone and from the cloud.")
        }
        .fullScreenCover(item: $playing) { recording in
            RecordingPlayerView(url: media.movieURL(for: recording))
        }
    }

    private var headerTitle: String {
        guard selecting else { return "Library" }
        return selection.isEmpty ? "Select Clips" : "\(selection.count) Selected"
    }

    private var selectedURLs: [URL] {
        media.recordings
            .filter { selection.contains($0.id) }
            .map { media.movieURL(for: $0) }
    }

    @ViewBuilder
    private func card(for recording: Recording) -> some View {
        let tile = RecordingCard(
            recording: recording,
            media: media,
            selecting: selecting,
            selected: selection.contains(recording.id)
        )
        .onTapGesture {
            if selecting {
                toggle(recording)
            } else {
                playing = recording
            }
        }
        if selecting {
            tile
        } else {
            tile.contextMenu {
                ShareLink(item: media.movieURL(for: recording))
                Button("Delete", systemImage: "trash", role: .destructive) {
                    media.delete(recording)
                }
                .tint(.red)
            }
        }
    }

    private func toggle(_ recording: Recording) {
        if selection.contains(recording.id) {
            selection.remove(recording.id)
        } else {
            selection.insert(recording.id)
        }
    }

    private func toggleAll() {
        if selection.count == media.recordings.count {
            selection.removeAll()
        } else {
            selection = Set(media.recordings.map(\.id))
        }
    }

    private func deleteSelected() {
        for recording in media.recordings where selection.contains(recording.id) {
            media.delete(recording)
        }
        endSelecting()
    }

    private func endSelecting() {
        selecting = false
        selection.removeAll()
    }
}

/// The bottom bar of select mode: share what is picked, pick everything or
/// nothing, delete the rest of the way.
struct SelectionBar: View {
    let urls: [URL]
    let allSelected: Bool
    let toggleAll: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack {
            ShareLink(items: urls) {
                Image(systemName: "square.and.arrow.up")
                    .font(.title3.weight(.semibold))
            }
            .disabled(urls.isEmpty)
            Spacer()
            Button(allSelected ? "Deselect All" : "Select All", action: toggleAll)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Button(action: delete) {
                Image(systemName: "trash")
                    .font(.title3.weight(.semibold))
            }
            .disabled(urls.isEmpty)
            .tint(.red)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 12)
        .background(.bar)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Pinned above everything in the library when the cloud is full: edge to
/// edge, under the status bar, just tall enough to say why clips stay local.
struct StorageBanner: View {
    var body: some View {
        Text("Not enough cloud storage — recordings stay on this phone")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .background(Color(hex: "#b3261e").ignoresSafeArea(edges: [.top, .horizontal]))
    }
}

struct RecordingCard: View {
    let recording: Recording
    var media: MediaModel
    var selecting = false
    var selected = false

    var body: some View {
        MediaTile(ratio: 9 / 14) {
            if let url = media.thumbnailURL(for: recording),
               let image = UIImage(contentsOfFile: url.localPath) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "play.fill")
                    .foregroundStyle(.secondary)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Text(formattedDuration(recording.duration))
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 8))
                .padding(8)
        }
        .overlay(alignment: .bottomLeading) {
            SyncBadge(state: media.syncState(for: recording))
                .padding(8)
        }
        .overlay(alignment: .topTrailing) {
            if selecting {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3.weight(.semibold))
                    .symbolRenderingMode(selected ? .palette : .monochrome)
                    .foregroundStyle(.white, Color.accentColor)
                    .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
                    .padding(8)
            }
        }
        .scaleEffect(selected ? 0.94 : 1)
        .animation(.snappy(duration: 0.15), value: selected)
    }
}

/// Shown on a card only while its bytes are on their way up, in the same
/// white-on-scrim overlay the duration reads in. A clip that is settled —
/// on the phone or in the cloud — carries no badge.
struct SyncBadge: View {
    let state: RecordingSyncState

    var body: some View {
        if case .uploading = state {
            Text("Syncing")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

struct RecordingPlayerView: View {
    let url: URL
    /// Set when the player was opened from the camera. The leading control
    /// then reads "< Library" and goes there, the way the system camera's
    /// viewer walks back into Photos; the close button moves to the right.
    var onOpenLibrary: (() -> Void)?

    @State private var player: AVPlayer?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let player {
                PlayerSurface(player: player)
                    .ignoresSafeArea()
                    .onTapGesture {
                        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
                    }
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    PlaybackBar(player: player)
                }
            }
            GlassEffectContainer {
                HStack(spacing: 10) {
                    if let onOpenLibrary {
                        Button(action: onOpenLibrary) {
                            HStack(spacing: 3) {
                                Image(systemName: "chevron.left")
                                    .font(.subheadline.weight(.bold))
                                Text("Library")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .frame(height: 40)
                        }
                        .glassEffect(.regular.interactive())
                    } else {
                        closeButton
                    }
                    Spacer()
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                    }
                    .glassEffect(.regular.interactive())
                    if onOpenLibrary != nil {
                        closeButton
                    }
                }
            }
            .padding(16)
        }
        .task {
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear { player?.pause() }
    }

    private var closeButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
        }
        .glassEffect(.regular.interactive())
        .accessibilityLabel("Close")
    }
}
#endif
