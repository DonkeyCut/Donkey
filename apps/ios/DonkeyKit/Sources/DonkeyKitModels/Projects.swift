import Foundation

nonisolated public enum ProjectExport: Equatable, Sendable {
    case none
    case ready(renderedOn: String)
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
    private let service: (any CloudProjectsServicing)?

    public init(service: (any CloudProjectsServicing)? = nil) {
        self.service = service
    }

    /// Pull the listing and per-project latest exports, then fill thumbnails
    /// as they cache — cards paint with names first, posters as they land.
    public func refresh() async {
        guard let service, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        guard let remote = try? await service.fetchProjects() else { return }
        summaries = Dictionary(uniqueKeysWithValues: remote.map { ($0.id, $0) })
        projects = remote.map { project(for: $0, latest: nil, thumbnail: nil) }
        await withTaskGroup(of: (String, RemoteExport?).self) { group in
            for summary in remote {
                group.addTask { (summary.id, (try? await service.fetchExports(projectId: summary.id))?.first) }
            }
            for await (id, latest) in group {
                latestExports[id] = latest
                guard let summary = summaries[id],
                      let index = projects.firstIndex(where: { $0.id == id }) else { continue }
                projects[index] = project(for: summary, latest: latest, thumbnail: projects[index].thumbnail)
            }
        }
        await withTaskGroup(of: (String, URL?).self) { group in
            for summary in remote {
                group.addTask { (summary.id, await service.thumbnailFile(for: summary)) }
            }
            for await (id, file) in group {
                guard let file, let index = projects.firstIndex(where: { $0.id == id }) else { continue }
                projects[index].thumbnail = file
            }
        }
    }

    /// The URL a tap streams: the newest export, or the composited preview
    /// proxy. Resolved at tap time because the CDN links expire.
    public func streamURL(for project: Project) async -> URL? {
        guard let service, let summary = summaries[project.id] else { return nil }
        return try? await service.streamURL(project: summary, export: latestExports[project.id])
    }

    private func project(for summary: RemoteProject, latest: RemoteExport?, thumbnail: URL?) -> Project {
        let export: ProjectExport =
            if let latest {
                .ready(renderedOn: latest.modifiedAt.formatted(date: .abbreviated, time: .omitted))
            } else if summary.hasPreview {
                .ready(renderedOn: summary.updatedAt.formatted(date: .abbreviated, time: .omitted))
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
