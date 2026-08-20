import Foundation

nonisolated public enum ProjectExport: Equatable, Sendable {
    case none
    case exporting(percent: Int)
    case ready(renderedOn: String)

    public var isExporting: Bool {
        if case .exporting = self { true } else { false }
    }
}

nonisolated public struct Project: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var duration: TimeInterval
    public var export: ProjectExport

    public init(id: UUID = UUID(), name: String, duration: TimeInterval, export: ProjectExport) {
        self.id = id
        self.name = name
        self.duration = duration
        self.export = export
    }
}

@Observable
public final class ProjectsModel {
    public private(set) var projects: [Project]

    /// Sample projects and a simulated export: the cloud projects API is not
    /// wired up yet, so the tab shows every card state on realistic data.
    public init() {
        projects = [
            Project(name: "6: End of Week Demo", duration: 108, export: .ready(renderedOn: "Aug 18")),
            Project(name: "Pizza", duration: 27, export: .ready(renderedOn: "Aug 15")),
            Project(name: "Animation", duration: 158, export: .exporting(percent: 48)),
            Project(name: "Local project", duration: 0, export: .none),
        ]
        advanceExports()
    }

    private func advanceExports() {
        Task {
            while let index = projects.firstIndex(where: { $0.export.isExporting }) {
                try? await Task.sleep(for: .seconds(0.9))
                guard case .exporting(let percent) = projects[index].export else { continue }
                projects[index].export = percent + 2 >= 100
                    ? .ready(renderedOn: "Today")
                    : .exporting(percent: percent + 2)
            }
        }
    }
}
