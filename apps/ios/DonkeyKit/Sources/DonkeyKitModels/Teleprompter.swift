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

/// Prompter copy from a raw note, broken into the lines the screen draws.
///
/// Spacing is the prompter's job: runs of spaces collapse and the writer's
/// own line breaks hold as paragraph breaks, so nobody has to format a note
/// to read it. Inside a paragraph, words stay together while they fit — a
/// line ends where the next word would run off the picture, and a short
/// clause shares its line with what follows it.
///
/// The measurer belongs to the caller, so the words are measured on the face
/// and the size they will be drawn in. `room` is the width they are drawn in,
/// in whatever unit that measurer answers in.
nonisolated public func pacedScript(
    _ raw: String,
    room: Double,
    measure: (String) -> Double
) -> String {
    let paragraphs = raw
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .split(separator: "\n", omittingEmptySubsequences: true)
        .map { pacedParagraph(String($0), room: room, measure: measure) }
        .filter { !$0.isEmpty }
    return paragraphs.joined(separator: "\n\n")
}

private nonisolated func pacedParagraph(
    _ text: String,
    room: Double,
    measure: (String) -> Double
) -> String {
    let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    // No room to speak of: the paragraph is one line and the screen decides
    // where it falls.
    guard room > 0 else { return words.joined(separator: " ") }
    var lines: [String] = []
    var line = ""
    for word in words {
        let candidate = line.isEmpty ? word : "\(line) \(word)"
        // A word wider than the room takes its own line whole; breaking it
        // would leave the reader with half a word.
        if !line.isEmpty, measure(candidate) > room {
            lines.append(line)
            line = word
        } else {
            line = candidate
        }
    }
    if !line.isEmpty { lines.append(line) }
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
    /// True while the script runs on screen. Play starts it, closing the
    /// prompter ends it: the words are on the picture only when asked for.
    public var isRunning = false
    public var settings = TeleprompterSettings()
    /// When the run was asked for, so the script starts from the top.
    public var runStartedAt: Date?

    public init() {}

    public var hasScript: Bool {
        !script.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The text the overlay renders: the raw script, broken to the room the
    /// screen gives it.
    public func displayScript(room: Double, measure: (String) -> Double) -> String {
        pacedScript(script, room: room, measure: measure)
    }

    /// Seconds the whole script takes at the set pace.
    public var duration: TimeInterval { readDuration(of: script, wordsPerMinute: settings.wordsPerMinute) }

    /// Where the first line sits before the script starts moving, as a share
    /// of the prompter's height.
    public static let leadShare = 0.5

    /// Where the script sits at `elapsed` seconds in, and how many copies of
    /// it the screen needs to stay covered.
    ///
    /// The script starts halfway down the prompter and rises at the reading
    /// pace — its own rendered height per read duration, so the words pass the
    /// reader at the set words per minute, paragraph gaps included as natural
    /// pauses. `nudge` is the reader's own hand on the script; it moves with
    /// the pacing rather than fighting it.
    ///
    /// One pass is drawn every `textHeight + gap`, above the window as well as
    /// below it, and the offset it starts from is always within one pass of the
    /// top. However long the run goes and wherever the loop has reached, the
    /// screen is covered top to bottom: a reader never watches the words leave
    /// and nothing take their place.
    public func prompterPass(
        elapsed: TimeInterval,
        overlayHeight: Double,
        textHeight: Double,
        gap: Double,
        nudge: Double = 0
    ) -> PrompterPass {
        let lead = overlayHeight * Self.leadShare
        let total = duration
        let cycle = textHeight + gap
        guard total > 0, textHeight > 0, cycle > 0 else {
            return PrompterPass(offset: lead + nudge, copies: 1)
        }
        let travelled = textHeight / total * elapsed
        // The first copy's top, carried back up to within one pass of the
        // window's own top: the passes before it are drawn, so the words that
        // have already gone by are still there to run off the screen.
        let raw = lead - travelled + nudge
        let wrapped = raw.truncatingRemainder(dividingBy: cycle)
        let offset = wrapped > 0 ? wrapped - cycle : wrapped
        // Enough passes to reach the foot of the window from there, plus one
        // waiting below it so the next is always on its way up.
        let copies = Int(((overlayHeight - offset) / cycle).rounded(.up)) + 1
        return PrompterPass(offset: offset, copies: max(2, copies))
    }
}

/// One frame of the prompter's loop: where the first copy of the script sits
/// and how many copies follow it down the screen.
nonisolated public struct PrompterPass: Equatable, Sendable {
    /// The top of the first copy, in the prompter's own space.
    public var offset: Double
    /// Copies to draw, spaced a gap apart.
    public var copies: Int

    public init(offset: Double, copies: Int) {
        self.offset = offset
        self.copies = copies
    }
}
