#if os(iOS)
import AVKit
import SwiftUI
import DonkeyKitModels

struct MediaScreen: View {
    @Bindable var app: AppModel
    var media: MediaModel
    var auth: AuthModel

    @State private var playing: Recording?

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            if media.storageFull {
                StorageBanner()
            }
            ScreenHeader(title: "Library", app: app, auth: auth)
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
                                RecordingCard(recording: recording, media: media)
                                    .onTapGesture { playing = recording }
                                    .contextMenu {
                                        ShareLink(item: media.movieURL(for: recording))
                                        Button("Delete", systemImage: "trash", role: .destructive) {
                                            media.delete(recording)
                                        }
                                        .tint(.red)
                                    }
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 14)
                        .padding(.bottom, 24)
                    }
                }
            }
        }
        .fullScreenCover(item: $playing) { recording in
            RecordingPlayerView(url: media.movieURL(for: recording))
        }
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
    }
}

struct SyncBadge: View {
    let state: RecordingSyncState

    var body: some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
    }

    private var label: String {
        switch state {
        case .onDevice: "On this phone"
        case .uploading(let percent): "Uploading \(percent)%"
        case .synced: "Synced ✓"
        }
    }

    private var background: Color {
        switch state {
        case .synced: Color(hex: "#168c4b").opacity(0.85)
        default: .black.opacity(0.65)
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
                VideoPlayer(player: player)
                    .ignoresSafeArea()
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
                .frame(width: 40, height: 40)
        }
        .glassEffect(.regular.interactive())
        .accessibilityLabel("Close")
    }
}
#endif
