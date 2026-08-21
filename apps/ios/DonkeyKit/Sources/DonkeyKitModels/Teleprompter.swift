import Foundation

nonisolated public struct TeleprompterSettings: Equatable, Codable, Sendable {
    /// Reading speed in words per minute. The scroll rate is derived from the
    /// script: however the words are spaced, they pass the reader at this pace.
    public var wordsPerMinute: Double
    /// Body text size in points.
    public var textSize: Double

    public static let speedRange: ClosedRange<Double> = 80...220
    public static let textSizeRange: ClosedRange<Double> = 16...40

    public init(wordsPerMinute: Double = 150, textSize: Double = 24) {
        self.wordsPerMinute = wordsPerMinute
        self.textSize = textSize
    }
}

/// Prompter copy from a raw note. Spacing is the prompter's job: runs of
/// spaces collapse, the writer's own line breaks hold as paragraph breaks,
/// and a long unbroken paragraph wraps into short lines at clause boundaries
/// so the eye has a rhythm to follow. Nobody has to format a note to read it.
nonisolated public func pacedScript(_ raw: String) -> String {
    let paragraphs = raw
        .split(separator: "\n", omittingEmptySubsequences: true)
        .map { pacedParagraph(String($0)) }
        .filter { !$0.isEmpty }
    return paragraphs.joined(separator: "\n\n")
}

/// Words a line holds before it breaks anyway.
private nonisolated let lineWordCap = 6
/// Words after which a clause end (comma, period, dash…) takes the break.
private nonisolated let clauseBreakMin = 2

private nonisolated func pacedParagraph(_ text: String) -> String {
    let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    var lines: [String] = []
    var line: [String] = []
    for word in words {
        line.append(word)
        let clauseEnd = word.last.map { ",.;:!?—".contains($0) } ?? false
        if line.count >= lineWordCap || (clauseEnd && line.count >= clauseBreakMin) {
            lines.append(line.joined(separator: " "))
            line = []
        }
    }
    if !line.isEmpty { lines.append(line.joined(separator: " ")) }
    return lines.joined(separator: "\n")
}

/// How long the script takes to read aloud at the given pace.
nonisolated public func readDuration(of script: String, wordsPerMinute: Double) -> TimeInterval {
    let words = script.split(whereSeparator: { $0.isWhitespace }).count
    guard words > 0, wordsPerMinute > 0 else { return 0 }
    return Double(words) / wordsPerMinute * 60
}

nonisolated public struct TeleprompterState: Equatable, Sendable {
    public var script: String = ""
    public var isCardShown = false
    public var settings = TeleprompterSettings()

    public init() {}

    public var hasScript: Bool {
        !script.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The text the overlay renders: the raw script, paced.
    public var displayScript: String { pacedScript(script) }

    /// Seconds the whole script takes at the set pace.
    public var duration: TimeInterval { readDuration(of: script, wordsPerMinute: settings.wordsPerMinute) }

    /// Vertical offset of the script at `elapsed` seconds into a recording.
    /// The text starts 60% down the overlay and travels its own rendered
    /// height plus that lead-in over the read duration, so the last words
    /// leave the top exactly when the speaker should be finishing them.
    /// Paragraph gaps are part of the height, so they read as natural pauses.
    public func scrollOffset(elapsed: TimeInterval, overlayHeight: Double, textHeight: Double) -> Double {
        let lead = overlayHeight * 0.6
        let total = duration
        guard total > 0 else { return lead }
        let speed = (textHeight + lead) / total
        return lead - speed * elapsed
    }
}
