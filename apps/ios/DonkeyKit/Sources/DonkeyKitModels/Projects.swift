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

    /// Empty until projects stream from the cloud projects API.
    public init() {
        projects = []
    }
}
