import Foundation
import Testing
@testable import DonkeyKitModels

/// The note body format. The cases follow the site's noteMarkdown tests, so
/// the phone and the web read and write the same bodies.
@Suite struct NoteMarkdownTests {
    func roundTrip(_ body: String) -> String { NoteMarkdown.serialize(NoteMarkdown.parse(body)) }

    @Test func aPlainTextNoteReadsOneParagraphPerLine() {
        let body = "Template\nfind a template to replicate\n\nCut Demo"
        #expect(NoteMarkdown.parse(body).map(\.kind) == [.paragraph, .paragraph, .paragraph, .paragraph])
        #expect(roundTrip(body) == body)
    }

    @Test func blockMarkersNestingAndToDosRoundTrip() {
        let body = [
            "# Title",
            "## Section",
            "### Sub",
            "- one",
            "  - nested",
            "    - deeper",
            "1. first",
            "2. second",
            "  - aside",
            "3. third",
            "- [ ] open",
            "- [x] done",
            "> quoted",
            "",
            "plain",
        ].joined(separator: "\n")
        #expect(roundTrip(body) == body)
        let blocks = NoteMarkdown.parse(body)
        #expect(blocks[4].kind == .bullet && blocks[4].indent == 1)
        #expect(blocks[5].indent == 2)
        #expect(blocks[11].kind == .todo(checked: true))
        #expect(blocks[1].kind == .heading(2))
    }

    @Test func numberedRunsRenumberAndOtherBulletsReadAsBullets() {
        #expect(roundTrip("5. a\n9. b\ntext\n3. c") == "1. a\n2. b\ntext\n1. c")
        #expect(roundTrip("* a\n• b") == "- a\n- b")
    }

    @Test func nestingDeeperThanTheLimitClamps() {
        let blocks = NoteMarkdown.parse(String(repeating: "  ", count: 8) + "- deep")
        #expect(blocks[0].indent == NoteMarkdown.indentMax)
    }

    @Test func oddSpacingAndUnspacedMarkersAreText() {
        #expect(NoteMarkdown.parse("   - three spaces")[0].kind == .paragraph)
        #expect(NoteMarkdown.parse("-no space")[0].kind == .paragraph)
        #expect(NoteMarkdown.parse("#### four")[0].kind == .paragraph)
        #expect(NoteMarkdown.parse(">quote")[0].kind == .paragraph)
    }

    @Test func inlineMarksParseAndNestAcrossSeams() {
        let runs = NoteMarkdown.parseInline("**bold *both* bold** <u>under</u> ~~gone~~ <span color=\"red\">red</span>")
        #expect(runs == [
            NoteRun("bold ", NoteMarks(bold: true)),
            NoteRun("both", NoteMarks(bold: true, italic: true)),
            NoteRun(" bold", NoteMarks(bold: true)),
            NoteRun(" "),
            NoteRun("under", NoteMarks(underline: true)),
            NoteRun(" "),
            NoteRun("gone", NoteMarks(strike: true)),
            NoteRun(" "),
            NoteRun("red", NoteMarks(color: .red)),
        ])
        for body in ["**bold *both* bold**", "<span color=\"blue\"><u>**a**</u></span>b", "*a***b**"] {
            #expect(roundTrip(roundTrip(body)) == roundTrip(body))
            #expect(NoteMarkdown.parse(roundTrip(body)) == NoteMarkdown.parse(body))
        }
    }

    @Test func canonicalBodiesSerializeToThemselves() {
        for body in [
            "",
            "plain\n\nlines",
            "# Title\n- a\n  - b\n    1. c\n    2. d\n- e\n- [ ] f\n  - [x] g\n> q1\n> q2\ntext",
            "**bold** *it* <u>u</u> ~~s~~ <span color=\"green\">**g**</span>",
            "<span color=\"red\"><u>~~***all***~~</u></span>",
            "a \\* b \\\\ c \\~\\~ d \\<u>",
        ] {
            #expect(roundTrip(body) == body)
        }
    }

    @Test func strayDelimitersAndUnknownTagsStayLiteral() {
        #expect(NoteMarkdown.plainText("5 * 3 = 15") == "5 * 3 = 15")
        #expect(NoteMarkdown.plainText("a <b>tag</b> and <span color=\"teal\">x</span>") == "a <b>tag</b> and <span color=\"teal\">x</span>")
        #expect(NoteMarkdown.plainText("close </u> first") == "close </u> first")
        #expect(NoteMarkdown.plainText("**one** **two** **three") == "one two **three")
        #expect(NoteMarkdown.plainText("<u>open never closed") == "<u>open never closed")
    }

    @Test func aLoneStarIsWrittenBackEscaped() {
        // The words survive; the star picks up the backslash that keeps it a
        // star from here on.
        #expect(roundTrip("5 * 3 = 15") == "5 \\* 3 = 15")
        #expect(NoteMarkdown.plainText(roundTrip("5 * 3 = 15")) == "5 * 3 = 15")
    }

    @Test func backslashKeepsTheNextCharacterLiteral() {
        #expect(NoteMarkdown.parseInline("\\*not italic\\*") == [NoteRun("*not italic*")])
        #expect(NoteMarkdown.parseInline("ends in \\") == [NoteRun("ends in \\")])
        #expect(NoteMarkdown.parse("\\- text")[0] == NoteBlock(.paragraph, runs: [NoteRun("- text")]))
    }

    @Test func literalTextThatLooksLikeMarkupIsEscapedAndReadsBack() {
        let blocks = [
            NoteBlock(.paragraph, runs: [NoteRun("- not a bullet *or* <u>tag</u> \\ ~~")]),
            NoteBlock(.paragraph, runs: [NoteRun("1. not a number")]),
            NoteBlock(.paragraph, runs: [NoteRun("# not a heading")]),
            NoteBlock(.paragraph, runs: [NoteRun("> not a quote")]),
            NoteBlock(.paragraph, runs: [NoteRun("  - not nested")]),
        ]
        #expect(NoteMarkdown.parse(NoteMarkdown.serialize(blocks)) == blocks)
    }

    @Test func colorsCarryBothInks() {
        #expect(NoteTextColor.allCases.count == 9)
        #expect(NoteTextColor.red.paper == "#d44c47")
        #expect(NoteTextColor.red.dark == "#df5452")
        #expect(NoteTextColor.gray.name == "Gray")
    }
}

/// The phone editor's attributed text and how edits read back into blocks.
@Suite struct NoteRichTextTests {
    let body = "# Title\n- a\n  - b\n1. one\n2. two\n- [ ] open\n- [x] done\n> quote\n\n**bold** <span color=\"blue\">blue</span>"

    /// The editor's text after the keyboard has had it: the drawn text with
    /// `change` applied to its characters.
    func typed(_ blocks: [NoteBlock], _ change: (inout String) -> Void) -> AttributedString {
        let drawn = NoteRichText.attributedText(blocks)
        var chars = String(drawn.characters)
        change(&chars)
        // Styles ride along on the characters that stayed; anything new is
        // plain, which is what a keyboard types after plain words.
        let old = Array(drawn.characters)
        let new = Array(chars)
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        var out = AttributedString(chars)
        if prefix > 0 {
            let end = out.characters.index(out.startIndex, offsetBy: prefix)
            let source = drawn.characters.index(drawn.startIndex, offsetBy: prefix)
            out.replaceSubrange(out.startIndex..<end, with: drawn[drawn.startIndex..<source])
        }
        return out
    }

    func body(after blocks: [NoteBlock], _ change: (inout String) -> Void, caret: Int? = nil) -> String {
        NoteMarkdown.serialize(NoteRichText.edit(blocks, to: typed(blocks, change), caret: caret).blocks)
    }

    @Test func drawnTextShowsMarkersAndWords() {
        let text = NoteRichText.attributedText(NoteMarkdown.parse(body))
        #expect(String(text.characters) == "Title\n• a\n\u{2003}◦ b\n1. one\n2. two\n☐ open\n☑\u{FE0E} done\n▎ quote\n\nbold blue")
    }

    @Test func anUneditedTextReadsBackToTheSameBody() {
        for body in [body, "", "plain\n\nlines", "5 \\* 3", "# \n- \n1. ", "  - first line nested"] {
            let blocks = NoteMarkdown.parse(body)
            let edit = NoteRichText.edit(blocks, to: NoteRichText.attributedText(blocks))
            #expect(edit.blocks == blocks)
            #expect(NoteMarkdown.serialize(edit.blocks) == body)
        }
    }

    @Test func marksRideTheAttributedText() {
        let blocks = NoteMarkdown.parse("plain **bold**")
        var text = NoteRichText.attributedText(blocks)
        // The editor turned "plain" italic.
        let end = text.characters.index(text.startIndex, offsetBy: 5)
        text[text.startIndex..<end][NoteMarksAttribute.self] = NoteMarks(italic: true)
        let edit = NoteRichText.edit(blocks, to: text)
        #expect(NoteMarkdown.serialize(edit.blocks) == "*plain* **bold**")
    }

    @Test func typingInsideAWordKeepsTheLine() {
        let blocks = NoteMarkdown.parse("- milk\n- eggs")
        #expect(body(after: blocks, { $0 = $0.replacingOccurrences(of: "milk", with: "milky") }) == "- milky\n- eggs")
    }

    @Test func returnAtTheEndOfAnItemOpensAnother() {
        let blocks = NoteMarkdown.parse("1. one\n- [x] done")
        #expect(body(after: blocks, { $0 = $0.replacingOccurrences(of: "1. one", with: "1. one\nnext") }) == "1. one\n2. next\n- [x] done")
        let todo = NoteMarkdown.parse("- [x] done")
        #expect(body(after: todo, { $0 += "\nmore" }) == "- [x] done\n- [ ] more")
    }

    @Test func returnOnAnEmptyItemEndsTheList() {
        let blocks = NoteMarkdown.parse("- a\n- ")
        let edit = NoteRichText.edit(blocks, to: typed(blocks) { $0 += "\n" })
        #expect(NoteMarkdown.serialize(edit.blocks) == "- a\n")
        #expect(edit.cursor == String(NoteRichText.attributedText(edit.blocks).characters).count)
        let nested = NoteMarkdown.parse("- a\n  - ")
        #expect(body(after: nested, { $0 += "\n" }) == "- a\n- ")
    }

    @Test func returnAfterAHeadingWritesText() {
        let blocks = NoteMarkdown.parse("# Title\n- x")
        // The new line could be read on either side of the line break; the
        // caret says it went after the title.
        #expect(body(after: blocks, { $0 = $0.replacingOccurrences(of: "Title", with: "Title\n") }, caret: 6) == "# Title\n\n- x")
        // Without the caret, the earliest reading stands, which is the same.
        #expect(body(after: blocks, { $0 = $0.replacingOccurrences(of: "Title", with: "Title\n") }) == "# Title\n\n- x")
        // Split in the middle, both halves stay headings.
        #expect(body(after: blocks, { $0 = $0.replacingOccurrences(of: "Title", with: "Ti\ntle") }) == "# Ti\n# tle\n- x")
    }

    @Test func backspaceIntoAMarkerTurnsTheLineBackToText() {
        let blocks = NoteMarkdown.parse("- milk")
        let edit = NoteRichText.edit(blocks, to: typed(blocks) { $0 = "•milk" })
        #expect(NoteMarkdown.serialize(edit.blocks) == "milk")
        #expect(edit.cursor == 0)
        // A nested item steps out a level instead.
        let nested = NoteMarkdown.parse("- a\n  - b")
        #expect(body(after: nested, { $0 = $0.replacingOccurrences(of: "◦ b", with: "◦b") }) == "- a\n- b")
    }

    @Test func typingAMarkerMakesTheBlock() {
        let cases: [(String, String)] = [
            ("- ", "- x"), ("* ", "- x"), ("1. ", "1. x"), ("# ", "# x"), ("### ", "### x"),
            ("> ", "> x"), ("[ ] ", "- [ ] x"), ("[x] ", "- [x] x"),
        ]
        for (marker, expected) in cases {
            let blocks = NoteMarkdown.parse(String(marker.dropLast()) + "x")
            let caret = marker.count
            let edit = NoteRichText.edit(blocks, to: typed(blocks) { $0 = marker + "x" }, caret: caret)
            #expect(NoteMarkdown.serialize(edit.blocks) == expected)
        }
        // A to-do box typed at the head of a bullet makes it a to-do.
        let bullet = NoteMarkdown.parse("- [ ]x")
        #expect(body(after: bullet, { $0 = "• [ ] x" }) == "- [ ] x")
    }

    @Test func aMarkerTypedMidLineIsText() {
        let blocks = NoteMarkdown.parse("a -")
        #expect(body(after: blocks, { $0 = "a - " }) == "a - ")
    }

    @Test func deletingAcrossLinesKeepsTheFirstLinesBlock() {
        let blocks = NoteMarkdown.parse("# Head\n- item")
        #expect(body(after: blocks, { $0 = "Heitem" }) == "# Heitem")
    }

    @Test func pastedLinesContinueTheList() {
        let blocks = NoteMarkdown.parse("- a")
        #expect(body(after: blocks, { $0 += "\r\nb\nc" }) == "- a\n- b\n- c")
    }

    @Test func typedMarkupIsWrittenAsText() {
        let blocks = NoteMarkdown.parse("")
        #expect(body(after: blocks, { $0 = "5 * 3 <u>" }) == "5 \\* 3 \\<u>")
        // A line typed to look like a list without the space shortcut stays
        // the text it is.
        #expect(body(after: blocks, { $0 = "-x" }) == "-x")
    }

    @Test func positionsMapThroughMarkers() {
        let blocks = NoteMarkdown.parse("# T\n- ab")
        func at(_ offset: Int) -> [Int] {
            let position = NoteRichText.position(of: offset, in: blocks)
            return [position.line, position.content]
        }
        #expect(at(0) == [0, 0])
        // Inside the bullet counts as the head of its words.
        #expect(at(2) == [1, 0])
        #expect(at(4) == [1, 0])
        #expect(at(5) == [1, 1])
        #expect(NoteRichText.offset(line: 1, content: 2, in: blocks) == 6)
    }

    @Test func restylingAndBlockChanges() {
        let blocks = NoteMarkdown.parse("hello world\nnext")
        let bold = NoteRichText.restyling(from: 6, to: 11, in: blocks) { $0.bold = true }
        #expect(NoteMarkdown.serialize(bold) == "hello **world**\nnext")
        let red = NoteRichText.restyling(from: 0, to: 16, in: blocks) { $0.color = .red }
        #expect(NoteMarkdown.serialize(red) == "<span color=\"red\">hello world</span>\n<span color=\"red\">next</span>")
        #expect(NoteRichText.marks(from: 6, to: 11, in: bold).allSatisfy { $0.bold })
        let listed = NoteRichText.setting(.number, lines: 0...1, of: blocks)
        #expect(NoteMarkdown.serialize(listed) == "1. hello world\n2. next")
        let nested = NoteRichText.indenting(lines: 1...1, by: 1, of: listed)
        #expect(NoteMarkdown.serialize(nested) == "1. hello world\n  1. next")
        let heading = NoteRichText.setting(.heading(2), lines: 1...1, of: nested)
        #expect(NoteMarkdown.serialize(heading) == "1. hello world\n## next")
    }
}
