#if os(iOS)
import AVKit
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
            case .ready(let renderedOn):
                Button(action: onPlay) {
                    ZStack {
                        if let thumbnail = project.thumbnail,
                           let image = UIImage(contentsOfFile: thumbnail.path()) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        } else {
                            RoundedRectangle(cornerRadius: 16).fill(.fill.secondary)
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
                    .clipShape(RoundedRectangle(cornerRadius: 16))
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
            }
        }
        .aspectRatio(9 / 13, contentMode: .fit)
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
struct ProjectPlayerView: View {
    let project: Project
    var projects: ProjectsModel

    @State private var player: AVPlayer?
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss

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
        }
        .task {
            guard let url = await projects.streamURL(for: project) else {
                failed = true
                return
            }
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear { player?.pause() }
    }
}
#endif
