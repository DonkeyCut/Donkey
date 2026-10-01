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

/// One block of prompter copy, broken into the lines the screen draws. The
/// block's marker — a bullet, a number, a box — leads its first line.
nonisolated public struct PacedBlock: Equatable, Sendable {
    public var kind: NoteBlockKind
    public var lines: [[NoteRun]]

    public init(kind: NoteBlockKind, lines: [[NoteRun]]) {
        self.kind = kind
        self.lines = lines
    }
}

/// Prompter copy from a note's body, broken into the lines the screen draws.
///
/// Spacing is the prompter's job: runs of spaces collapse and every block of
/// the note is its own paragraph, so nobody has to format a note to read it.
/// The words keep their styles. Inside a paragraph, words stay together while
/// they fit — a line ends where the next word would run off the picture, and a
/// short clause shares its line with what follows it. Blocks with no words in
/// them are left out.
///
/// The measurer belongs to the caller, so the words are measured on the face
/// and the size they will be drawn in: it gets a line's runs and the block
/// they sit in. `room` is the width they are drawn in, in whatever unit that
/// measurer answers in.
nonisolated public func pacedScript(
    _ script: String,
    room: Double,
    measure: ([NoteRun], NoteBlockKind) -> Double
) -> [PacedBlock] {
    let blocks = NoteMarkdown.parse(script)
    let numbers = NoteMarkdown.numbering(blocks)
    return zip(blocks, numbers).compactMap { block, number in
        let lines = pacedLines(
            block,
            marker: NoteRichText.marker(for: block, number: number),
            room: room,
            measure: { measure($0, block.kind) }
        )
        return lines.isEmpty ? nil : PacedBlock(kind: block.kind, lines: lines)
    }
}

private nonisolated func pacedLines(
    _ block: NoteBlock,
    marker: String,
    room: Double,
    measure: ([NoteRun]) -> Double
) -> [[NoteRun]] {
    typealias Styled = [(Character, NoteMarks)]
    // The words, each with the marks of its characters, and the marks of the
    // space that went before each one.
    var words: [Styled] = []
    var gaps: [NoteMarks] = []
    var word: Styled = []
    var gap: NoteMarks?
    for run in block.runs {
        for ch in run.text {
            if ch.isWhitespace {
                if !word.isEmpty {
                    words.append(word)
                    word = []
                }
                if gap == nil { gap = run.marks }
            } else {
                if word.isEmpty {
                    gaps.append(gap ?? NoteMarks())
                    gap = nil
                }
                word.append((ch, run.marks))
            }
        }
    }
    if !word.isEmpty { words.append(word) }
    guard !words.isEmpty else { return [] }

    func runs(_ styled: Styled) -> [NoteRun] {
        var out: [NoteRun] = []
        for (ch, marks) in styled {
            if let last = out.last, last.marks == marks {
                out[out.count - 1].text.append(ch)
            } else {
                out.append(NoteRun(String(ch), marks))
            }
        }
        return out
    }

    let lead: Styled = marker.map { ($0, NoteMarks()) }
    var lines: [Styled] = []
    var line = lead
    var lineHasWords = false
    for (index, word) in words.enumerated() {
        let candidate = lineHasWords ? line + [(" ", gaps[index])] + word : line + word
        // No room to speak of: the paragraph is one line and the screen
        // decides where it falls. A word wider than the room takes its own
        // line whole; breaking it would leave the reader with half a word.
        if room > 0, lineHasWords, measure(runs(candidate)) > room {
            lines.append(line)
            line = word
        } else {
            line = candidate
        }
        lineHasWords = true
    }
    lines.append(line)
    return lines.map(runs)
}

/// How long the script takes to read aloud at the given pace: its words, with
/// the markup taken out.
nonisolated public func readDuration(of script: String, wordsPerMinute: Double) -> TimeInterval {
    let words = NoteMarkdown.plainText(script).split(whereSeparator: { $0.isWhitespace }).count
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
    /// How far the reader has moved the script from where the pacing puts
    /// it, in points. It rides along with the scroll rather than replacing
    /// it, so a nudge mid-take moves the words and the pace carries on. A
    /// drag on the phone and the crown on the watch both land here.
    public var nudge: Double = 0

    public init() {}

    public var hasScript: Bool {
        !NoteMarkdown.plainText(script).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The copy the overlay renders: the script's blocks, broken to the room
    /// the screen gives them.
    public func displayScript(room: Double, measure: ([NoteRun], NoteBlockKind) -> Double) -> [PacedBlock] {
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
