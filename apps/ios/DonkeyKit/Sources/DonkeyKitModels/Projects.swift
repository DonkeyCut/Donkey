import Foundation

nonisolated public enum ProjectExport: Equatable, Sendable {
    case none
    /// Something is there to play. `isPreview` marks the composited proxy the
    /// editor renders for its own grid: it plays, but it is not the render an
    /// export produces, so anything that hands the file to the user says so.
    case ready(renderedOn: String, isPreview: Bool)
}

/// A cloud project as the phone shows it: name, duration, a cached thumbnail
/// file, and which render a tap streams. Only thumbnails sync down — the
/// video stays in the cloud and streams on demand.
nonisolated public struct Project: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var duration: TimeInterval
    public var export: ProjectExport
    public var thumbnail: URL?

    public init(id: String, name: String, duration: TimeInterval, export: ProjectExport, thumbnail: URL? = nil) {
        self.id = id
        self.name = name
        self.duration = duration
        self.export = export
        self.thumbnail = thumbnail
    }
}

@Observable
public final class ProjectsModel {
    public private(set) var projects: [Project] = []
    public private(set) var isLoading = false

    private var summaries: [String: RemoteProject] = [:]
    private var latestExports: [String: RemoteExport] = [:]
    private var thumbnails: [String: URL] = [:]
    private let service: (any CloudProjectsServicing)?

    public init(service: (any CloudProjectsServicing)? = nil) {
        self.service = service
    }

    /// Pull the listing and per-project latest exports, then fill thumbnails
    /// as they cache. A card keeps the poster and export it already carries
    /// while the refresh runs, so revisiting the screen repaints in place.
    public func refresh() async {
        guard let service, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        guard let remote = try? await service.fetchProjects() else { return }
        adopt(remote)
        async let exports: Void = fillExports(remote, service: service)
        async let posters: Void = fillThumbnails(remote, service: service)
        _ = await (exports, posters)
    }

    /// Take a listing as the current set of projects, dropping what is gone
    /// and keeping the posters and exports already in hand for what stayed.
    private func adopt(_ remote: [RemoteProject]) {
        summaries = Dictionary(uniqueKeysWithValues: remote.map { ($0.id, $0) })
        let live = Set(remote.map(\.id))
        latestExports = latestExports.filter { live.contains($0.key) }
        thumbnails = thumbnails.filter { live.contains($0.key) }
        projects = remote.map { project(for: $0, latest: latestExports[$0.id], thumbnail: thumbnails[$0.id]) }
    }

    private func fillExports(_ remote: [RemoteProject], service: any CloudProjectsServicing) async {
        await withTaskGroup(of: (String, [RemoteExport]?).self) { group in
            for summary in remote {
                group.addTask { (summary.id, try? await service.fetchExports(projectId: summary.id)) }
            }
            for await (id, exports) in group {
                // A fetch that failed comes back nil and leaves the export the
                // card already plays alone; only an answer from the server —
                // a list, empty or not — changes what a card offers.
                guard let exports else { continue }
                latestExports[id] = exports.first
                rebuild(id)
            }
        }
    }

    private func fillThumbnails(_ remote: [RemoteProject], service: any CloudProjectsServicing) async {
        await withTaskGroup(of: (String, URL?).self) { group in
            for summary in remote {
                group.addTask { (summary.id, await service.thumbnailFile(for: summary)) }
            }
            for await (id, file) in group {
                guard let file else { continue }
                thumbnails[id] = file
                guard let index = projects.firstIndex(where: { $0.id == id }) else { continue }
                projects[index].thumbnail = file
            }
        }
    }

    /// The URL a tap streams: the newest export, or the composited preview
    /// proxy. The listing and the project's exports are read again here, so
    /// opening a project plays the edit that was made at the desk a moment
    /// ago rather than whatever the last listing saw. Resolved at tap time
    /// because the CDN links expire.
    public func streamURL(for project: Project) async -> URL? {
        guard let service else { return nil }
        async let listing = fetchListing(service)
        async let exports = fetchExports(project.id, service)
        let (remote, latest) = await (listing, exports)
        if let remote { adopt(remote) }
        if let latest {
            latestExports[project.id] = latest.first
            rebuild(project.id)
        }
        guard let summary = summaries[project.id] else { return nil }
        return try? await service.streamURL(project: summary, export: latestExports[project.id])
    }

    private func fetchListing(_ service: any CloudProjectsServicing) async -> [RemoteProject]? {
        try? await service.fetchProjects()
    }

    private func fetchExports(_ id: String, _ service: any CloudProjectsServicing) async -> [RemoteExport]? {
        try? await service.fetchExports(projectId: id)
    }

    /// Repaint one card from the summary, export, and poster now in hand.
    private func rebuild(_ id: String) {
        guard let summary = summaries[id],
              let index = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[index] = project(for: summary, latest: latestExports[id], thumbnail: projects[index].thumbnail)
    }

    private func project(for summary: RemoteProject, latest: RemoteExport?, thumbnail: URL?) -> Project {
        let export: ProjectExport =
            if let latest {
                .ready(
                    renderedOn: latest.modifiedAt.formatted(date: .abbreviated, time: .omitted),
                    isPreview: false
                )
            } else if summary.hasPreview {
                .ready(
                    renderedOn: summary.updatedAt.formatted(date: .abbreviated, time: .omitted),
                    isPreview: true
                )
            } else {
                .none
            }
        return Project(
            id: summary.id,
            name: summary.name,
            duration: summary.duration,
            export: export,
            thumbnail: thumbnail
        )
    }
}
