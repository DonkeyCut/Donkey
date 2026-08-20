import Foundation

nonisolated public struct TeleprompterSettings: Equatable, Codable, Sendable {
    /// Scroll speed in points per second.
    public var speed: Double
    /// Body text size in points.
    public var textSize: Double

    public static let speedRange: ClosedRange<Double> = 10...100
    public static let textSizeRange: ClosedRange<Double> = 16...40

    public init(speed: Double = 40, textSize: Double = 24) {
        self.speed = speed
        self.textSize = textSize
    }
}

nonisolated public struct TeleprompterState: Equatable, Sendable {
    public var script: String = ""
    public var isCardShown = false
    public var settings = TeleprompterSettings()

    public init() {}

    public var hasScript: Bool {
        !script.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Vertical offset of the script at `elapsed` seconds into a recording:
    /// text starts 60% down the overlay and scrolls up at the set speed.
    public func scrollOffset(elapsed: TimeInterval, overlayHeight: Double) -> Double {
        overlayHeight * 0.6 - settings.speed * elapsed
    }
}
