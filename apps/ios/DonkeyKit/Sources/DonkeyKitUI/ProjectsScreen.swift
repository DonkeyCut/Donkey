#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct ProjectsScreen: View {
    @Bindable var app: AppModel
    var projects: ProjectsModel
    var auth: AuthModel

    @State private var playing: Project?

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(projects.projects) { project in
                        ProjectCard(project: project) { playing = project }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Projects")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarMenu(app: app, auth: auth)
                }
            }
            .fullScreenCover(item: $playing) { project in
                ProjectPlayerView(project: project)
            }
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
                        RoundedRectangle(cornerRadius: 16).fill(.fill.secondary)
                        Circle()
                            .fill(.white.opacity(0.14))
                            .frame(width: 46, height: 46)
                            .overlay {
                                Image(systemName: "play.fill")
                                    .font(.body.weight(.bold))
                                    .foregroundStyle(.primary)
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
            case .exporting(let percent):
                GhostCard(title: project.name, subtitle: "Exporting \(percent)%")
                    .overlay(alignment: .bottom) {
                        ProgressView(value: Double(percent), total: 100)
                            .tint(.recordPink)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                    }
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

/// Plays the project's latest render. Playback is a clock over the render's
/// duration until renders stream from the cloud.
struct ProjectPlayerView: View {
    let project: Project

    @State private var time: TimeInterval = 0
    @State private var isPlaying = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3.weight(.bold))
                        .frame(width: 40, height: 40)
                }
                Text(project.name)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
                Spacer().frame(width: 40)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer()

            Button {
                isPlaying.toggle()
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.title.weight(.bold))
                    .frame(width: 76, height: 76)
                    .background(.white.opacity(0.15), in: Circle())
            }

            Spacer()

            VStack(alignment: .leading, spacing: 8) {
                scrubber
                HStack {
                    Text(formattedDuration(time))
                    Spacer()
                    Text(formattedDuration(project.duration))
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.75))
                if case .ready(let renderedOn) = project.export {
                    Text("Latest render · \(renderedOn)")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.white.opacity(0.14), in: Capsule())
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .foregroundStyle(.white)
        .background(Color.black.ignoresSafeArea())
        .task(id: isPlaying) {
            guard isPlaying else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(0.1))
                time = min(time + 0.1, project.duration)
                if time >= project.duration {
                    isPlaying = false
                    return
                }
            }
        }
    }

    private var scrubber: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.22))
                Capsule()
                    .fill(.white)
                    .frame(width: max(0, proxy.size.width * progress))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { value in
                    let fraction = min(max(value.location.x / proxy.size.width, 0), 1)
                    time = fraction * project.duration
                }
            )
        }
        .frame(height: 5)
    }

    private var progress: Double {
        project.duration > 0 ? time / project.duration : 0
    }
}
#endif
