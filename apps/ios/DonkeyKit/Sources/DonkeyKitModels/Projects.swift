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

/// A render the phone asked the cloud for, from the ask to the file landing on
/// this device. The photo library is the UI layer's to write, so the run stops
/// at `ready` and the screen reports back what the library said.
nonisolated public enum ProjectExportState: Equatable, Sendable {
    case queued
    /// Rendering, 0…1.
    case rendering(Double)
    case downloading
    /// The finished render, on this device.
    case ready(URL)
    case saved
    case failed(String)
}

/// The sizes the phone offers, named as the editor's export dialog names them.
/// The ids are the dialog's own — the worker builds the render spec from them.
nonisolated public struct ProjectExportSize: Identifiable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var note: String

    public init(id: String, label: String, note: String) {
        self.id = id
        self.label = label
        self.note = note
    }

    public static let all: [ProjectExportSize] = [
        ProjectExportSize(id: "original", label: "Original · matches source", note: "H.264 · best quality"),
        ProjectExportSize(id: "tiktok", label: "Best · 1080p", note: "smaller file"),
        ProjectExportSize(id: "light", label: "Draft · 720p", note: "fastest render"),
    ]
}

@Observable
public final class ProjectsModel {
    public private(set) var projects: [Project] = []
    public private(set) var isLoading = false
    /// Renders in flight, by project id. A run outlives the screen that asked
    /// for it, so closing the player and coming back finds it where it was.
    public private(set) var exportRuns: [String: ProjectExportState] = [:]

    private var summaries: [String: RemoteProject] = [:]
    private var latestExports: [String: RemoteExport] = [:]
    private var thumbnails: [String: URL] = [:]
    private var exportTasks: [String: Task<Void, Never>] = [:]
    private let service: (any CloudProjectsServicing)?

    public init(service: (any CloudProjectsServicing)? = nil) {
        self.service = service
    }

    // MARK: Exporting

    /// Render this project's whole timeline in the cloud and bring the file
    /// down. The cut is composited from the stored document, so what lands is
    /// the same file the editor's own export produces — overlays, captions,
    /// soundtrack and all.
    public func export(_ project: Project, size: ProjectExportSize) {
        guard let service, exportTasks[project.id] == nil else { return }
        exportRuns[project.id] = .queued
        let id = project.id
        exportTasks[id] = Task { [weak self] in
            do {
                let jobId = try await service.startExport(projectId: id, preset: size.id)
                try await self?.followExport(jobId: jobId, project: id, service: service)
            } catch is CancellationError {
                self?.exportRuns[id] = nil
            } catch {
                self?.exportRuns[id] = .failed(Self.message(for: error))
            }
            self?.exportTasks[id] = nil
        }
    }

    private func followExport(
        jobId: String,
        project id: String,
        service: any CloudProjectsServicing
    ) async throws {
        while true {
            try await Task.sleep(for: .seconds(1.5))
            switch try await service.exportProgress(jobId: jobId) {
            case .queued:
                exportRuns[id] = .queued
            case .running(let ratio):
                exportRuns[id] = .rendering(ratio)
            case .failed(let message):
                exportRuns[id] = .failed(message)
                return
            case .done:
                exportRuns[id] = .downloading
                let url = try await service.exportFile(jobId: jobId)
                exportRuns[id] = .ready(try await Self.downloadedCopy(of: url))
                // The finished render is a new export on the project, so the
                // card stops offering the preview the moment it lands.
                await refresh()
                return
            }
        }
    }

    /// What the photo library said about the file this run produced. The
    /// screen writes it there; the run ends here either way, and the temporary
    /// copy goes with it.
    public func finishExport(_ id: String, error: String?) {
        if case .ready(let file) = exportRuns[id] {
            try? FileManager.default.removeItem(at: file)
        }
        exportRuns[id] = error.map { .failed($0) } ?? .saved
    }

    public func clearExport(_ id: String) {
        if case .ready(let file) = exportRuns[id] {
            try? FileManager.default.removeItem(at: file)
        }
        exportTasks[id]?.cancel()
        exportTasks[id] = nil
        exportRuns[id] = nil
    }

    /// The render on disk, named with an extension Photos recognizes — the
    /// download's own temp file has none, and the library reads the container
    /// from the name.
    private static func downloadedCopy(of url: URL) async throws -> URL {
        let (temp, response) = try await URLSession.shared.download(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: temp)
            throw CloudSyncError.transport
        }
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temp, to: file)
        return file
    }

    private static func message(for error: any Error) -> String {
        switch error {
        case CloudSyncError.refused(let message): message
        case CloudSyncError.storageFull: "Your cloud storage is full — free some space and try again."
        case CloudSyncError.unauthorized: "Sign in again to export this project."
        default: "Couldn't export this project."
        }
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
