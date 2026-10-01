#if os(iOS)
import SwiftUI
import DonkeyKitModels

/// The state of a note body being edited as rich text: the blocks, the
/// attributed text the editor shows for them, and the selection in it.
///
/// Every edit runs one way. The keyboard or the system's format menu changes
/// the text; the styles are read back off its fonts and decorations; the
/// blocks take the edit; and when the blocks draw differently from what the
/// editor holds — a marker to add, a face to put back — the text is redrawn
/// and the insertion point put where the edit left it. The body is written
/// from the blocks, so it is always the dialect. A body nobody changed is
/// handed back exactly as it came in, whatever the editor would have written.
@MainActor
@Observable
final class NoteBodyEditing {
    var text: AttributedString
    var selection = AttributedTextSelection()
    private(set) var blocks: [NoteBlock]
    /// The body as it stands, in the note format.
    private(set) var body: String

    let look: NoteLook
    @ObservationIgnored private let onChange: (String) -> Void
    /// The body as loaded, and what the editor writes for it untouched.
    @ObservationIgnored private var loaded = ""
    @ObservationIgnored private var loadedAsWritten = ""
    /// The text last drawn here, so a change that is only that drawing
    /// landing in the editor is not read back as an edit.
    @ObservationIgnored private var drawn = AttributedString()

    init(body: String, look: NoteLook, onChange: @escaping (String) -> Void) {
        self.look = look
        self.onChange = onChange
        self.body = body
        self.blocks = []
        self.text = AttributedString()
        load(body)
    }

    /// Show a body that came from elsewhere: a note picked into the
    /// prompter, say.
    func load(_ body: String) {
        loaded = body
        blocks = NoteMarkdown.parse(body)
        loadedAsWritten = NoteMarkdown.serialize(blocks)
        self.body = body
        drawn = look.text(blocks)
        text = drawn
        selection = AttributedTextSelection()
        // An empty body has no words to take a face from, so the first
        // keystroke is set to type in the body's own.
        if text.characters.isEmpty { place(caret: 0) }
    }

    /// The block the insertion point sits in.
    var currentBlock: NoteBlock? {
        let line = NoteRichText.position(of: selectedOffsets().upperBound, in: blocks).line
        return blocks.indices.contains(line) ? blocks[line] : nil
    }

    /// Read what the editor made of the text back into blocks.
    func textChanged(in context: Font.Context) {
        guard text != drawn else { return }
        var read = AttributedString()
        for run in text.runs {
            var piece = AttributedString(text[run.range])
            piece[NoteMarksAttribute.self] = look.marks(of: run.attributes, in: context)
            read += piece
        }
        let selected = selectedOffsets()
        let before = blocks.count
        let edit = NoteRichText.edit(blocks, to: read, caret: selected.upperBound)
        blocks = edit.blocks
        let fresh = look.text(blocks)
        let sameCharacters = String(fresh.characters) == String(text.characters)
        if sameCharacters, look.appearance(of: fresh, in: context) == look.appearance(of: text, in: context) {
            drawn = text
            // A line break leaves the next character to be typed in the face
            // of the line above; the new line's own face goes in its place.
            if blocks.count != before { place(caret: edit.cursor) }
        } else {
            drawn = fresh
            text = fresh
            if sameCharacters {
                select(selected)
            } else {
                place(caret: edit.cursor)
            }
        }
        publish()
    }

    // MARK: Formatting

    func setKind(_ kind: NoteBlockKind) {
        changeLines { NoteRichText.setting(kind, lines: $1, of: $0) }
    }

    func indent(by step: Int) {
        changeLines { NoteRichText.indenting(lines: $1, by: step, of: $0) }
    }

    /// Check a to-do off, or open it again.
    func toggleChecked() {
        changeLines { blocks, lines in
            var out = blocks
            for i in lines {
                if case .todo(let checked) = out[i].kind { out[i].kind = .todo(checked: !checked) }
            }
            return out
        }
    }

    /// Whether every selected character wears a mark — or, with nothing
    /// selected, whether the next one typed will.
    func isMarked(_ mark: NoteMark, in context: Font.Context) -> Bool {
        let range = selectedOffsets()
        if range.isEmpty { return typingMarks(in: context)[mark] }
        return NoteRichText.marks(from: range.lowerBound, to: range.upperBound, in: blocks).allSatisfy { $0[mark] }
    }

    func toggle(_ mark: NoteMark, in context: Font.Context) {
        let on = !isMarked(mark, in: context)
        restyle(in: context) { $0[mark] = on }
    }

    func setColor(_ color: NoteTextColor?, in context: Font.Context) {
        restyle(in: context) { $0.color = color }
    }

    private func restyle(in context: Font.Context, _ change: @escaping (inout NoteMarks) -> Void) {
        let range = selectedOffsets()
        if range.isEmpty {
            var marks = typingMarks(in: context)
            change(&marks)
            place(caret: range.lowerBound, marks: marks)
            return
        }
        blocks = NoteRichText.restyling(from: range.lowerBound, to: range.upperBound, in: blocks, change)
        redraw()
        select(range)
        publish()
    }

    /// Apply a change to the lines the selection touches, keeping the
    /// selection on the same words.
    private func changeLines(_ change: ([NoteBlock], ClosedRange<Int>) -> [NoteBlock]) {
        let range = selectedOffsets()
        let start = NoteRichText.position(of: range.lowerBound, in: blocks)
        let end = NoteRichText.position(of: range.upperBound, in: blocks)
        blocks = change(blocks, start.line...end.line)
        redraw()
        select(
            NoteRichText.offset(line: start.line, content: start.content, in: blocks)
                ..< NoteRichText.offset(line: end.line, content: end.content, in: blocks)
        )
        publish()
    }

    private func redraw() {
        drawn = look.text(blocks)
        text = drawn
    }

    private func publish() {
        let written = NoteMarkdown.serialize(blocks)
        body = written == loadedAsWritten ? loaded : written
        onChange(body)
    }

    // MARK: Selection

    private func offset(of index: AttributedString.Index) -> Int {
        text.characters.distance(from: text.startIndex, to: index)
    }

    private func index(at offset: Int) -> AttributedString.Index {
        text.characters.index(text.startIndex, offsetBy: min(max(offset, 0), text.characters.count))
    }

    private func selectedOffsets() -> Range<Int> {
        switch selection.indices(in: text) {
        case .insertionPoint(let index):
            let at = offset(of: index)
            return at..<at
        case .ranges(let ranges):
            guard let first = ranges.ranges.first, let last = ranges.ranges.last else { return 0..<0 }
            return offset(of: first.lowerBound)..<offset(of: last.upperBound)
        }
    }

    private func select(_ range: Range<Int>) {
        if range.isEmpty {
            place(caret: range.lowerBound)
        } else {
            selection = AttributedTextSelection(range: index(at: range.lowerBound)..<index(at: range.upperBound))
        }
    }

    /// Put the insertion point at an offset, set to type in the face of the
    /// words before it on its line — or plain, at the head of a line.
    private func place(caret: Int, marks: NoteMarks? = nil) {
        let position = NoteRichText.position(of: caret, in: blocks)
        guard blocks.indices.contains(position.line) else { return }
        let block = blocks[position.line]
        let typing = marks ?? (position.content > 0
            ? NoteRichText.marks(from: caret - 1, to: caret, in: blocks).first ?? NoteMarks()
            : NoteMarks())
        selection = AttributedTextSelection(
            insertionPoint: index(at: caret),
            typingAttributes: look.attributes(block.kind, typing)
        )
    }

    private func typingMarks(in context: Font.Context) -> NoteMarks {
        look.marks(of: selection.typingAttributes(in: text), in: context)
    }
}

/// The note body as rich text, over a placeholder while it is empty.
struct NoteBodyEditor: View {
    @Bindable var editing: NoteBodyEditing
    var placeholder: String

    @Environment(\.fontResolutionContext) private var fontContext

    var body: some View {
        TextEditor(text: $editing.text, selection: $editing.selection)
            .font(editing.look.font(.paragraph, NoteMarks()))
            .onChange(of: editing.text) { editing.textChanged(in: fontContext) }
            .overlay(alignment: .topLeading) {
                if editing.text.characters.isEmpty {
                    Text(placeholder)
                        .font(editing.look.font(.paragraph, NoteMarks()))
                        .opacity(0.4)
                        .padding(.horizontal, 5)
                        .padding(.top, 8)
                        .allowsHitTesting(false)
                }
            }
    }
}

/// The formatting controls for a note body: the block the lines are, the
/// styles the words wear, and their color. They ride the keyboard.
struct NoteFormatControls: View {
    var editing: NoteBodyEditing

    @Environment(\.fontResolutionContext) private var fontContext

    private struct Kind {
        var name: String
        var symbol: String
        var kind: NoteBlockKind
    }

    private static let kinds = [
        Kind(name: "Text", symbol: "text.alignleft", kind: .paragraph),
        Kind(name: "Heading 1", symbol: "textformat.size.larger", kind: .heading(1)),
        Kind(name: "Heading 2", symbol: "textformat.size", kind: .heading(2)),
        Kind(name: "Heading 3", symbol: "textformat.size.smaller", kind: .heading(3)),
        Kind(name: "Bulleted List", symbol: "list.bullet", kind: .bullet),
        Kind(name: "Numbered List", symbol: "list.number", kind: .number),
        Kind(name: "To-do", symbol: "checklist", kind: .todo(checked: false)),
        Kind(name: "Quote", symbol: "text.quote", kind: .quote),
    ]

    var body: some View {
        let block = editing.currentBlock
        Menu {
            ForEach(Self.kinds, id: \.name) { item in
                Button {
                    editing.setKind(item.kind)
                } label: {
                    Label(item.name, systemImage: Self.same(block?.kind, item.kind) ? "checkmark" : item.symbol)
                }
            }
            if let block, block.kind.isList {
                Divider()
                if case .todo(let checked) = block.kind {
                    Button(checked ? "Mark Not Done" : "Mark Done", systemImage: checked ? "circle" : "checkmark.circle") {
                        editing.toggleChecked()
                    }
                }
                Button("Indent", systemImage: "increase.indent") { editing.indent(by: 1) }
                    .disabled(block.indent >= NoteMarkdown.indentMax)
                Button("Outdent", systemImage: "decrease.indent") { editing.indent(by: -1) }
                    .disabled(block.indent == 0)
            }
        } label: {
            Image(systemName: "textformat")
        }
        .accessibilityLabel("Block style")

        markButton(.bold, symbol: "bold", name: "Bold")
        markButton(.italic, symbol: "italic", name: "Italic")
        markButton(.underline, symbol: "underline", name: "Underline")
        markButton(.strike, symbol: "strikethrough", name: "Strikethrough")

        Menu {
            Button("Default") { editing.setColor(nil, in: fontContext) }
            ForEach(NoteTextColor.allCases, id: \.self) { color in
                Button {
                    editing.setColor(color, in: fontContext)
                } label: {
                    Label {
                        Text(color.name)
                    } icon: {
                        Image(systemName: "circle.fill")
                            .foregroundStyle(editing.look.color(color))
                    }
                }
            }
        } label: {
            Image(systemName: "paintpalette")
        }
        .accessibilityLabel("Text color")
    }

    private func markButton(_ mark: NoteMark, symbol: String, name: String) -> some View {
        Button {
            editing.toggle(mark, in: fontContext)
        } label: {
            Image(systemName: symbol)
        }
        .accessibilityLabel(name)
    }

    /// Whether a line is the kind a menu item names. A to-do is a to-do,
    /// checked or not.
    private static func same(_ a: NoteBlockKind?, _ b: NoteBlockKind) -> Bool {
        if case .todo = a, case .todo = b { return true }
        return a == b
    }
}
#endif
