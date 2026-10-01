import Foundation

/// A note body as the phone's editor holds it: an attributed text with one
/// line per block, each list or quote line led by a marker the reader sees —
/// "• ", "1. ", "☐ ", "▎ " — and nested lists set in by an em space a level.
///
/// The blocks are the truth. The editor hands back whatever the keyboard made
/// of the text, and `edit(_:to:caret:)` reads that against the blocks it was
/// drawn from: lines the edit never reached keep their block, a new line
/// continues the list it was opened from, and a keystroke into a marker turns
/// the line back into text. What comes out is blocks again, so the body the
/// phone writes is always the dialect.
nonisolated public enum NoteRichText {
    /// One level of list nesting, as the editor shows it.
    public static let indentUnit: Character = "\u{2003}"

    /// What a line shows ahead of its words.
    public static func marker(for block: NoteBlock, number: Int) -> String {
        let pad = String(repeating: indentUnit, count: block.kind.isList ? clampedIndent(block.indent) : 0)
        switch block.kind {
        case .bullet: return pad + ["•", "◦", "▪"][clampedIndent(block.indent) % 3] + " "
        case .number: return pad + "\(number). "
        case .todo(let checked): return pad + (checked ? "☑\u{FE0E} " : "☐ ")
        case .quote: return "▎ "
        case .paragraph, .heading: return ""
        }
    }

    /// The editor's text for these blocks. Words carry `NoteMarksAttribute`;
    /// every character of a line — marker, words and the line break that ends
    /// it — carries `NoteLineAttribute`; marker characters also carry
    /// `NoteMarkerAttribute`.
    public static func attributedText(_ blocks: [NoteBlock]) -> AttributedString {
        var out = AttributedString()
        let numbers = NoteMarkdown.numbering(blocks)
        for (i, block) in blocks.enumerated() {
            let line = NoteLine(kind: block.kind, indent: block.kind.isList ? clampedIndent(block.indent) : 0)
            let marker = marker(for: block, number: numbers[i])
            if !marker.isEmpty {
                var piece = AttributedString(marker)
                piece[NoteLineAttribute.self] = line
                piece[NoteMarkerAttribute.self] = true
                out += piece
            }
            for run in block.runs where !run.text.isEmpty {
                var piece = AttributedString(run.text)
                piece[NoteLineAttribute.self] = line
                piece[NoteMarksAttribute.self] = run.marks
                out += piece
            }
            if i < blocks.count - 1 {
                var piece = AttributedString("\n")
                piece[NoteLineAttribute.self] = line
                out += piece
            }
        }
        return out
    }

    // MARK: Reading an edit

    /// Read the editor's text back into blocks. `blocks` is what the text was
    /// drawn from; `text` is what the keyboard made of it, with each
    /// character's styles already read into `NoteMarksAttribute`. `caret` is
    /// where the insertion point sits after the edit, which settles which of
    /// two identical characters was typed. The result's cursor is where the
    /// insertion point belongs in the text the new blocks draw.
    public static func edit(_ blocks: [NoteBlock], to text: AttributedString, caret: Int? = nil) -> NoteEdit {
        let old = blocks.isEmpty ? [NoteBlock(.paragraph)] : blocks
        let numbers = NoteMarkdown.numbering(old)
        var oldChars: [Character] = []
        var starts: [Int] = []
        var markerLengths: [Int] = []
        for (i, block) in old.enumerated() {
            if i > 0 { oldChars.append("\n") }
            starts.append(oldChars.count)
            let marker = Array(marker(for: block, number: numbers[i]))
            markerLengths.append(marker.count)
            oldChars += marker
            oldChars += Array(block.text)
        }
        func lineEnd(_ i: Int) -> Int { i + 1 < starts.count ? starts[i + 1] - 1 : oldChars.count }
        func line(at offset: Int) -> Int { starts.lastIndex(where: { $0 <= offset }) ?? 0 }

        var chars: [Character] = []
        var marks: [NoteMarks] = []
        for run in text.runs {
            let m = run[NoteMarksAttribute.self] ?? NoteMarks()
            for ch in text[run.range].characters {
                chars.append(isLineBreak(ch) ? "\n" : ch)
                marks.append(m)
            }
        }
        func runs(_ pieces: [Range<Int>]) -> [NoteRun] {
            var out: [NoteRun] = []
            for piece in pieces {
                for i in piece {
                    if let last = out.last, last.marks == marks[i] {
                        out[out.count - 1].text.append(chars[i])
                    } else {
                        out.append(NoteRun(String(chars[i]), marks[i]))
                    }
                }
            }
            return out
        }

        let change = changedRange(old: oldChars, new: chars, caret: caret)
        let p = change.start, oldEnd = change.oldEnd, newEnd = change.newEnd
        let delta = chars.count - oldChars.count
        let first = line(at: p), last = line(at: oldEnd)
        let start0 = starts[first], markerEnd0 = start0 + markerLengths[first]
        let base = old[first]
        let inserted = chars[p..<newEnd]
        let pureInsertion = oldEnd == p

        func untouched(_ i: Int, shift: Int) -> NoteBlock {
            NoteBlock(old[i].kind, indent: old[i].indent, runs: runs([(starts[i] + markerLengths[i] + shift)..<(lineEnd(i) + shift)]))
        }
        let before = (0..<first).map { untouched($0, shift: 0) }
        let after = ((last + 1)..<old.count).map { untouched($0, shift: delta) }

        // Return on an empty list item or quote ends it: the line steps out a
        // level, or back to text at the margin, and no line is added.
        if pureInsertion, Array(inserted) == ["\n"], base.kind.isList || base.kind == .quote,
           first == last, lineEnd(first) == markerEnd0, p == markerEnd0 {
            let stepped = base.kind.isList && base.indent > 0
                ? NoteBlock(base.kind, indent: base.indent - 1)
                : NoteBlock(.paragraph)
            let result = before + [stepped] + after
            return NoteEdit(blocks: result, cursor: offset(line: first, content: 0, in: result))
        }

        // Typing a marker and a space at the head of a line makes the block it
        // names, the way the web editor does.
        if pureInsertion, Array(inserted) == [" "], first == last, p >= markerEnd0,
           let kind = shortcut(String(chars[markerEnd0..<newEnd]), on: base.kind) {
            let block = NoteBlock(
                kind,
                indent: base.kind.isList && kind.isList ? base.indent : 0,
                runs: runs([newEnd..<(lineEnd(first) + delta)])
            )
            let result = before + [block] + after
            return NoteEdit(blocks: result, cursor: offset(line: first, content: 0, in: result))
        }

        // Markers are drawn from the blocks, so the span's own are dropped:
        // the first line's, or what the edit left of its head, and what it
        // left of the tail of the last line's.
        let insideMarker = p < markerEnd0
        var dropped: [Range<Int>] = [start0..<min(p, markerEnd0)]
        let markerEndLast = starts[last] + markerLengths[last]
        if oldEnd < markerEndLast { dropped.append(newEnd..<(newEnd + markerEndLast - oldEnd)) }
        // Deleting into a marker steps a nested item out a level and takes
        // anything else back to text; typing inside one types at the head of
        // the line's words.
        var firstKind = base.kind, firstIndent = base.indent
        if insideMarker && !pureInsertion {
            if base.kind.isList, base.indent > 0, first == last, newEnd == p {
                firstIndent -= 1
            } else {
                firstKind = .paragraph
                firstIndent = 0
            }
        }

        let spanEnd = lineEnd(last) + delta
        var segments: [(range: Range<Int>, pieces: [Range<Int>])] = []
        var segmentStart = start0
        for i in start0...spanEnd where i == spanEnd || chars[i] == "\n" {
            let range = segmentStart..<i
            var pieces: [Range<Int>] = [range]
            for cut in dropped {
                pieces = pieces.flatMap { piece -> [Range<Int>] in
                    guard piece.overlaps(cut) else { return [piece] }
                    return [piece.lowerBound..<cut.lowerBound, cut.upperBound..<piece.upperBound].filter { !$0.isEmpty }
                }
            }
            segments.append((range, pieces))
            segmentStart = i + 1
        }

        // A line opened from a list item is another item; from anything else
        // it is text. A heading split in the middle stays a heading on both
        // sides.
        let continued: NoteBlockKind = switch firstKind {
        case .bullet, .number: firstKind
        case .todo: .todo(checked: false)
        case .quote: .quote
        case .heading, .paragraph: .paragraph
        }
        let splitMidHeading = first == last && oldEnd < lineEnd(first) && {
            if case .heading = firstKind { return true }
            return false
        }()
        var span: [NoteBlock] = []
        for (index, segment) in segments.enumerated() {
            let isFirst = index == 0
            let keepsHeading = index == segments.count - 1 && splitMidHeading
            let kind = isFirst || keepsHeading ? firstKind : continued
            span.append(NoteBlock(kind, indent: kind.isList ? firstIndent : 0, runs: runs(segment.pieces)))
        }
        let result = before + span + after

        // The insertion point lands after what was typed, counted in the words
        // that survive on its line.
        var cursorLine = first, cursorContent = 0
        for (index, segment) in segments.enumerated()
        where segment.range.lowerBound <= newEnd && newEnd <= segment.range.upperBound {
            cursorLine = first + index
            cursorContent = segment.pieces.reduce(0) { $0 + max(0, min($1.upperBound, newEnd) - $1.lowerBound) }
            break
        }
        return NoteEdit(blocks: result, cursor: offset(line: cursorLine, content: cursorContent, in: result))
    }

    /// The block a typed marker names: "- ", "1. ", "[ ] ", "# ", "> ".
    private static func shortcut(_ typed: String, on kind: NoteBlockKind) -> NoteBlockKind? {
        let todo: [String: NoteBlockKind] = [
            "[] ": .todo(checked: false), "[ ] ": .todo(checked: false),
            "[x] ": .todo(checked: true), "[X] ": .todo(checked: true),
        ]
        if kind == .bullet { return todo[typed] }
        guard kind == .paragraph else { return nil }
        if let found = todo[typed] { return found }
        switch typed {
        case "- ", "* ", "• ": return .bullet
        case "# ": return .heading(1)
        case "## ": return .heading(2)
        case "### ": return .heading(3)
        case "> ": return .quote
        default: break
        }
        let digits = typed.dropLast(2)
        if typed.hasSuffix(". "), !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) { return .number }
        return nil
    }

    private static func isLineBreak(_ ch: Character) -> Bool {
        ch == "\n" || ch == "\r\n" || ch == "\r" || ch == "\u{2028}" || ch == "\u{2029}"
    }

    /// Where the old and new characters differ: from `start` to `oldEnd` in
    /// the old, to `newEnd` in the new. A pure insertion or deletion between
    /// repeated characters could sit at several places; the caret picks one,
    /// and without it the earliest stands.
    private static func changedRange(old: [Character], new: [Character], caret: Int?) -> (start: Int, oldEnd: Int, newEnd: Int) {
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count, suffix < new.count, old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        let shorter = min(old.count, new.count)
        if prefix + suffix >= shorter, old.count != new.count {
            // One side is the other with a stretch added: any start from the
            // earliest the suffix allows to the latest the prefix allows.
            let length = abs(new.count - old.count)
            let earliest = max(0, shorter - suffix)
            let latest = min(prefix, shorter)
            var start = earliest
            if let caret {
                let wanted = new.count > old.count ? caret - length : caret
                if (earliest...latest).contains(wanted) { start = wanted }
            }
            return new.count > old.count
                ? (start, start, start + length)
                : (start, start + length, start)
        }
        let start = prefix
        let common = min(suffix, shorter - prefix)
        return (start, old.count - common, new.count - common)
    }

    // MARK: Positions

    private static func clampedIndent(_ indent: Int) -> Int { min(max(indent, 0), NoteMarkdown.indentMax) }

    /// The line an offset in the editor's text falls on, and how far into
    /// that line's words it sits. An offset inside a marker counts as the
    /// head of the words.
    public static func position(of offset: Int, in blocks: [NoteBlock]) -> (line: Int, content: Int) {
        let numbers = NoteMarkdown.numbering(blocks)
        var start = 0
        for (i, block) in blocks.enumerated() {
            let marker = marker(for: block, number: numbers[i]).count
            let length = block.text.count
            if offset <= start + marker + length || i == blocks.count - 1 {
                return (i, min(max(offset - start - marker, 0), length))
            }
            start += marker + length + 1
        }
        return (0, 0)
    }

    /// The offset in the editor's text of a point in a line's words.
    public static func offset(line: Int, content: Int, in blocks: [NoteBlock]) -> Int {
        let numbers = NoteMarkdown.numbering(blocks)
        var start = 0
        for (i, block) in blocks.enumerated() {
            let marker = marker(for: block, number: numbers[i]).count
            if i == line { return start + marker + min(max(content, 0), block.text.count) }
            start += marker + block.text.count + 1
        }
        return start
    }

    // MARK: Changing blocks

    /// Turn lines into another kind of block. Lists keep their nesting when
    /// they stay lists.
    public static func setting(_ kind: NoteBlockKind, lines: ClosedRange<Int>, of blocks: [NoteBlock]) -> [NoteBlock] {
        var out = blocks
        for i in lines where out.indices.contains(i) {
            out[i].indent = kind.isList && out[i].kind.isList ? out[i].indent : 0
            out[i].kind = kind
        }
        return out
    }

    /// Nest list lines a level deeper, or bring them a level out.
    public static func indenting(lines: ClosedRange<Int>, by step: Int, of blocks: [NoteBlock]) -> [NoteBlock] {
        var out = blocks
        for i in lines where out.indices.contains(i) && out[i].kind.isList {
            out[i].indent = clampedIndent(out[i].indent + step)
        }
        return out
    }

    /// The marks on every character between two offsets.
    public static func marks(from start: Int, to end: Int, in blocks: [NoteBlock]) -> [NoteMarks] {
        var out: [NoteMarks] = []
        forEachCharacter(from: start, to: end, in: blocks) { out.append($0) }
        return out
    }

    /// Restyle the words between two offsets. Markers and line breaks in the
    /// range are passed over.
    public static func restyling(
        from start: Int,
        to end: Int,
        in blocks: [NoteBlock],
        _ change: (inout NoteMarks) -> Void
    ) -> [NoteBlock] {
        let a = position(of: start, in: blocks), b = position(of: end, in: blocks)
        guard a.line < b.line || (a.line == b.line && a.content < b.content) else { return blocks }
        var out = blocks
        for line in a.line...b.line {
            let from = line == a.line ? a.content : 0
            let to = line == b.line ? b.content : out[line].text.count
            var chars: [(Character, NoteMarks)] = out[line].runs.flatMap { run in run.text.map { ($0, run.marks) } }
            for i in from..<min(to, chars.count) { change(&chars[i].1) }
            var runs: [NoteRun] = []
            for (ch, marks) in chars {
                if let last = runs.last, last.marks == marks {
                    runs[runs.count - 1].text.append(ch)
                } else {
                    runs.append(NoteRun(String(ch), marks))
                }
            }
            out[line].runs = runs
        }
        return out
    }

    private static func forEachCharacter(from start: Int, to end: Int, in blocks: [NoteBlock], _ body: (NoteMarks) -> Void) {
        let a = position(of: start, in: blocks), b = position(of: end, in: blocks)
        guard a.line <= b.line else { return }
        for line in a.line...b.line {
            let from = line == a.line ? a.content : 0
            let to = line == b.line ? b.content : blocks[line].text.count
            var index = 0
            for run in blocks[line].runs {
                for _ in run.text {
                    if index >= from, index < to { body(run.marks) }
                    index += 1
                }
            }
        }
    }
}

/// What an edit made of the note: its blocks, and where the insertion point
/// belongs in the text they draw.
nonisolated public struct NoteEdit: Equatable, Sendable {
    public var blocks: [NoteBlock]
    public var cursor: Int
}

/// A line's block, as the editor's text carries it.
nonisolated public struct NoteLine: Hashable, Sendable {
    public var kind: NoteBlockKind
    public var indent: Int

    public init(kind: NoteBlockKind, indent: Int) {
        self.kind = kind
        self.indent = indent
    }
}

nonisolated public enum NoteMarksAttribute: AttributedStringKey {
    public typealias Value = NoteMarks
    public static let name = "DonkeyNoteMarks"
}

nonisolated public enum NoteLineAttribute: AttributedStringKey {
    public typealias Value = NoteLine
    public static let name = "DonkeyNoteLine"
}

nonisolated public enum NoteMarkerAttribute: AttributedStringKey {
    public typealias Value = Bool
    public static let name = "DonkeyNoteMarker"
}
