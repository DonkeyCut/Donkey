import Foundation

// The note body's format: a line-per-block Markdown that the web editor, this
// phone's editor, its teleprompter and the chat all read and write.
//
// Every line is one block, so a note written as plain text — one thought to a
// line — reads exactly as it was typed. A line opens with its block's marker:
//
//   # Heading         ## Smaller          ### Smallest
//   - Bullet          1. Numbered         - [ ] To-do      - [x] Done
//   > Quote
//
// List lines nest two spaces per level. Inside a line, **bold**, *italic*,
// ~~strikethrough~~, <u>underline</u> and <span color="red">color</span> style
// the words, and a backslash keeps the next character literal. The site's
// site/src/cut/lib/noteMarkdown.ts is the reference; this file follows it, and a
// change there changes this too.

/// Text colors, by name, with the ink each one takes on the note's paper and
/// on the dark teleprompter.
nonisolated public enum NoteTextColor: String, CaseIterable, Hashable, Sendable {
    case gray, brown, orange, yellow, green, blue, purple, pink, red

    public var name: String { rawValue.capitalized }

    public var paper: String {
        switch self {
        case .gray: "#787774"
        case .brown: "#9f6b53"
        case .orange: "#d9730d"
        case .yellow: "#cb912f"
        case .green: "#448361"
        case .blue: "#337ea9"
        case .purple: "#9065b0"
        case .pink: "#c14c8a"
        case .red: "#d44c47"
        }
    }

    public var dark: String {
        switch self {
        case .gray: "#9b9b9b"
        case .brown: "#ba856f"
        case .orange: "#c77d48"
        case .yellow: "#ca9849"
        case .green: "#529e72"
        case .blue: "#5e87c9"
        case .purple: "#9d68d3"
        case .pink: "#d15796"
        case .red: "#df5452"
        }
    }
}

nonisolated public enum NoteBlockKind: Hashable, Sendable {
    case paragraph
    /// Heading size, 1 to 3.
    case heading(Int)
    case bullet
    case number
    case todo(checked: Bool)
    case quote

    /// Bullets, numbers and to-dos: the kinds that nest.
    public var isList: Bool {
        switch self {
        case .bullet, .number, .todo: true
        case .paragraph, .heading, .quote: false
        }
    }
}

/// The styles a stretch of words wears.
nonisolated public struct NoteMarks: Hashable, Sendable {
    public var bold = false
    public var italic = false
    public var underline = false
    public var strike = false
    public var color: NoteTextColor?

    public init(
        bold: Bool = false,
        italic: Bool = false,
        underline: Bool = false,
        strike: Bool = false,
        color: NoteTextColor? = nil
    ) {
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strike = strike
        self.color = color
    }

    public subscript(mark: NoteMark) -> Bool {
        get {
            switch mark {
            case .bold: bold
            case .italic: italic
            case .underline: underline
            case .strike: strike
            }
        }
        set {
            switch mark {
            case .bold: bold = newValue
            case .italic: italic = newValue
            case .underline: underline = newValue
            case .strike: strike = newValue
            }
        }
    }
}

/// The on-or-off styles, for code that flips one of them.
nonisolated public enum NoteMark: CaseIterable, Sendable {
    case bold, italic, underline, strike
}

nonisolated public struct NoteRun: Hashable, Sendable {
    public var text: String
    public var marks: NoteMarks

    public init(_ text: String, _ marks: NoteMarks = NoteMarks()) {
        self.text = text
        self.marks = marks
    }
}

nonisolated public struct NoteBlock: Hashable, Sendable {
    public var kind: NoteBlockKind
    /// List nesting, 0 at the margin. Only list kinds nest.
    public var indent: Int
    public var runs: [NoteRun]

    public init(_ kind: NoteBlockKind, indent: Int = 0, runs: [NoteRun] = []) {
        self.kind = kind
        self.indent = indent
        self.runs = runs
    }

    /// The block's words without their styles.
    public var text: String { runs.map(\.text).joined() }
}

nonisolated public enum NoteMarkdown {
    /// How deep a list nests.
    public static let indentMax = 5

    // MARK: Reading

    /// Read a body into its blocks.
    public static func parse(_ body: String) -> [NoteBlock] {
        body.components(separatedBy: "\n").map(parseLine)
    }

    /// The words of a body with its markup taken out.
    public static func plainText(_ body: String) -> String {
        parse(body).map(\.text).joined(separator: "\n")
    }

    private typealias Scalars = [Unicode.Scalar]

    /// A list line's opening: its nesting, its kind and how many scalars the
    /// marker takes. Mirrors `^((?: {2})*)(?:([-*•]) \[( |x|X)\] |([-*•]) |(\d+)\. )`.
    private static func listMarker(_ s: Scalars) -> (indent: Int, kind: NoteBlockKind, length: Int)? {
        var spaces = 0
        while spaces < s.count, s[spaces] == " " { spaces += 1 }
        // Pairs of spaces only: an odd one out leaves a space where the
        // marker has to be.
        guard spaces % 2 == 0 else { return nil }
        let at = spaces
        func scalar(_ i: Int) -> Unicode.Scalar? { i < s.count ? s[i] : nil }
        let bullets: Set<Unicode.Scalar> = ["-", "*", "•"]
        if let c = scalar(at), bullets.contains(c), scalar(at + 1) == " " {
            if scalar(at + 2) == "[", let box = scalar(at + 3), [" ", "x", "X"].contains(box),
               scalar(at + 4) == "]", scalar(at + 5) == " " {
                return (spaces / 2, .todo(checked: box != " "), at + 6)
            }
            return (spaces / 2, .bullet, at + 2)
        }
        var digits = at
        while let c = scalar(digits), ("0"..."9").contains(c) { digits += 1 }
        if digits > at, scalar(digits) == ".", scalar(digits + 1) == " " {
            return (spaces / 2, .number, digits + 2)
        }
        return nil
    }

    /// A heading line's level and marker length. Mirrors `^(#{1,3}) `.
    private static func headingMarker(_ s: Scalars) -> (level: Int, length: Int)? {
        var hashes = 0
        while hashes < s.count, s[hashes] == "#" { hashes += 1 }
        guard (1...3).contains(hashes), hashes < s.count, s[hashes] == " " else { return nil }
        return (hashes, hashes + 1)
    }

    private static func startsQuote(_ s: Scalars) -> Bool {
        s.count >= 2 && s[0] == ">" && s[1] == " "
    }

    private static func parseLine(_ line: String) -> NoteBlock {
        let s = Array(line.unicodeScalars)
        if let list = listMarker(s) {
            return NoteBlock(
                list.kind,
                indent: min(list.indent, indentMax),
                runs: parseInline(s, from: list.length)
            )
        }
        if let heading = headingMarker(s) {
            return NoteBlock(.heading(heading.level), runs: parseInline(s, from: heading.length))
        }
        if startsQuote(s) { return NoteBlock(.quote, runs: parseInline(s, from: 2)) }
        return NoteBlock(.paragraph, runs: parseInline(s, from: 0))
    }

    private enum Toggle { case bold, italic, strike }
    private enum Tagged { case underline, color }

    private enum Token {
        case text(String)
        case toggle(Toggle, String)
        case open(Tagged, NoteTextColor?, String)
        case close(Tagged, String)

        var source: String {
            switch self {
            case .text(let v), .toggle(_, let v), .open(_, _, let v), .close(_, let v): v
            }
        }
    }

    /// A tag at `i`: what it is and how many scalars it takes. Mirrors
    /// `^<(u|\/u|\/span|span color="([a-z]+)")>`.
    private static func tag(_ s: Scalars, at i: Int) -> (name: String, color: String?, length: Int)? {
        func matches(_ literal: String, at j: Int) -> Bool {
            let l = Array(literal.unicodeScalars)
            guard j + l.count <= s.count else { return false }
            return Array(s[j..<(j + l.count)]) == l
        }
        guard i < s.count, s[i] == "<" else { return nil }
        for name in ["u", "/u", "/span"] where matches(name + ">", at: i + 1) {
            return (name, nil, name.unicodeScalars.count + 2)
        }
        let open = "span color=\""
        guard matches(open, at: i + 1) else { return nil }
        var end = i + 1 + open.unicodeScalars.count
        let start = end
        while end < s.count, ("a"..."z").contains(s[end]) { end += 1 }
        guard end > start, matches("\">", at: end) else { return nil }
        var color = String.UnicodeScalarView()
        color.append(contentsOf: s[start..<end])
        return ("span", String(color), end + 2 - i)
    }

    private static func tokenize(_ s: Scalars, from: Int) -> [Token] {
        var out: [Token] = []
        var text = String.UnicodeScalarView()
        func flush() {
            if !text.isEmpty { out.append(.text(String(text))) }
            text = String.UnicodeScalarView()
        }
        func next(_ i: Int) -> Unicode.Scalar? { i < s.count ? s[i] : nil }
        var i = from
        while i < s.count {
            let c = s[i]
            if c == "\\", i + 1 < s.count {
                text.append(s[i + 1])
                i += 2
            } else if c == "*", next(i + 1) == "*" {
                flush()
                out.append(.toggle(.bold, "**"))
                i += 2
            } else if c == "*" {
                flush()
                out.append(.toggle(.italic, "*"))
                i += 1
            } else if c == "~", next(i + 1) == "~" {
                flush()
                out.append(.toggle(.strike, "~~"))
                i += 2
            } else if let tag = tag(s, at: i) {
                var source = String.UnicodeScalarView()
                source.append(contentsOf: s[i..<(i + tag.length)])
                let literal = String(source)
                if tag.name == "span", NoteTextColor(rawValue: tag.color ?? "") == nil {
                    text.append(contentsOf: source)
                } else {
                    flush()
                    switch tag.name {
                    case "u": out.append(.open(.underline, nil, literal))
                    case "/u": out.append(.close(.underline, literal))
                    case "/span": out.append(.close(.color, literal))
                    default: out.append(.open(.color, NoteTextColor(rawValue: tag.color ?? ""), literal))
                    }
                }
                i += tag.length
            } else {
                text.append(c)
                i += 1
            }
        }
        flush()
        return out
    }

    /// A line's styled runs. A delimiter with nothing to pair with — the lone
    /// star in "5 * 3" — is read as the text it is.
    public static func parseInline(_ line: String) -> [NoteRun] {
        parseInline(Array(line.unicodeScalars), from: 0)
    }

    private static func parseInline(_ s: Scalars, from: Int) -> [NoteRun] {
        var tokens = tokenize(s, from: from)
        // Toggles pair up in order; an odd one out is literal.
        for mark in [Toggle.bold, .italic, .strike] {
            let at = tokens.indices.filter {
                if case .toggle(let m, _) = tokens[$0] { return m == mark }
                return false
            }
            if at.count % 2 == 1, let last = at.last { tokens[last] = .text(tokens[last].source) }
        }
        // Tags pair open-to-close; a close with nothing open, or an open never
        // closed, is literal.
        for mark in [Tagged.underline, .color] {
            var open: [Int] = []
            for i in tokens.indices {
                switch tokens[i] {
                case .open(let m, _, _) where m == mark:
                    open.append(i)
                case .close(let m, let v) where m == mark:
                    if open.isEmpty { tokens[i] = .text(v) } else { open.removeLast() }
                default:
                    break
                }
            }
            for i in open { tokens[i] = .text(tokens[i].source) }
        }
        var runs: [NoteRun] = []
        var marks = NoteMarks()
        var colors: [NoteTextColor] = []
        var underline = 0
        for token in tokens {
            switch token {
            case .text(let v):
                var now = marks
                now.underline = underline > 0
                now.color = colors.last
                if let last = runs.last, last.marks == now {
                    runs[runs.count - 1].text += v
                } else {
                    runs.append(NoteRun(v, now))
                }
            case .toggle(.bold, _): marks.bold.toggle()
            case .toggle(.italic, _): marks.italic.toggle()
            case .toggle(.strike, _): marks.strike.toggle()
            case .open(.underline, _, _): underline += 1
            case .open(.color, let color, _): if let color { colors.append(color) }
            case .close(.underline, _): underline -= 1
            case .close(.color, _): _ = colors.popLast()
            }
        }
        return runs
    }

    // MARK: Writing

    /// Write blocks back out as a body. Numbered items count up within their
    /// run at each level.
    public static func serialize(_ blocks: [NoteBlock]) -> String {
        let numbers = numbering(blocks)
        return zip(blocks, numbers).map { block, number in
            let indent = block.kind.isList ? min(max(block.indent, 0), indentMax) : 0
            let pad = String(repeating: "  ", count: indent)
            let text = serializeInline(block.runs)
            switch block.kind {
            case .heading(let level):
                return String(repeating: "#", count: min(max(level, 1), 3)) + " " + text
            case .bullet:
                return pad + "- " + text
            case .number:
                return pad + "\(number). " + text
            case .todo(let checked):
                return pad + (checked ? "- [x] " : "- [ ] ") + text
            case .quote:
                return "> " + text
            case .paragraph:
                // A paragraph that starts like a marker keeps its first
                // character literal, so it reads back as the paragraph it is.
                let s = Array(text.unicodeScalars)
                return listMarker(s) != nil || headingMarker(s) != nil || startsQuote(s) ? "\\" + text : text
            }
        }
        .joined(separator: "\n")
    }

    /// The number each block shows: a numbered run restarts after anything
    /// that is not a deeper list line. Zero for blocks that are not numbered.
    public static func numbering(_ blocks: [NoteBlock]) -> [Int] {
        var counts: [Int] = []
        func resize(_ n: Int) {
            if counts.count > n { counts.removeLast(counts.count - n) }
            while counts.count < n { counts.append(0) }
        }
        return blocks.map { block in
            let indent = block.kind.isList ? min(max(block.indent, 0), indentMax) : 0
            if block.kind == .number {
                resize(indent + 1)
                counts[indent] += 1
                return counts[indent]
            }
            resize(block.kind.isList ? indent + 1 : 0)
            if block.kind.isList { counts[indent] = 0 }
            return 0
        }
    }

    private static func escapeText(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for c in s.unicodeScalars {
            if c == "\\" || c == "*" || c == "~" || c == "<" { out.append("\\") }
            out.append(c)
        }
        return String(out)
    }

    private enum Opened: Equatable {
        case color(NoteTextColor), underline, strike, bold, italic

        var open: String {
            switch self {
            case .color(let c): "<span color=\"\(c.rawValue)\">"
            case .underline: "<u>"
            case .strike: "~~"
            case .bold: "**"
            case .italic: "*"
            }
        }

        var close: String {
            switch self {
            case .color: "</span>"
            case .underline: "</u>"
            default: open
            }
        }
    }

    /// Marks open outside-in in this order and close inside-out, so a run that
    /// shares a mark with the one before it keeps it open across the seam.
    private static func wanted(_ marks: NoteMarks) -> [Opened] {
        var out: [Opened] = []
        if let color = marks.color { out.append(.color(color)) }
        if marks.underline { out.append(.underline) }
        if marks.strike { out.append(.strike) }
        if marks.bold { out.append(.bold) }
        if marks.italic { out.append(.italic) }
        return out
    }

    public static func serializeInline(_ runs: [NoteRun]) -> String {
        var out = ""
        var stack: [Opened] = []
        for run in runs where !run.text.isEmpty {
            let want = wanted(run.marks)
            // Keep the longest prefix of what is open that the run still wears.
            var keep = 0
            while keep < stack.count, keep < want.count, stack[keep] == want[keep] { keep += 1 }
            while stack.count > keep { out += stack.removeLast().close }
            for o in want[keep...] {
                out += o.open
                stack.append(o)
            }
            out += escapeText(run.text)
        }
        while let o = stack.popLast() { out += o.close }
        return out
    }
}
