#if os(iOS)
import SwiftUI
import UIKit
import DonkeyKitModels

/// How a note's blocks and styles look on one surface: the size and weights
/// of its words, how much bigger headings draw, and which ink its colors take.
///
/// One face serves both the drawing and the measuring: the teleprompter breaks
/// lines with the same fonts it draws them in, and the editor reads bold and
/// italic back off the fonts it drew. Bold is read as a weight from bold up,
/// so every surface an editor reads keeps its plain weights below that.
struct NoteLook {
    var size: CGFloat
    var weight: Font.Weight
    var boldWeight: Font.Weight
    var headingWeight: Font.Weight
    var headingBoldWeight: Font.Weight
    /// How much bigger each heading level draws.
    var headingScale: [CGFloat] = [1.5, 1.3, 1.15]
    /// The ink of words with no color: the note paper's, or the stage's white.
    var ink: Color
    /// Whether colors take their dark-stage ink.
    var onDark: Bool

    /// The note editor, on its paper.
    static let paper = NoteLook(
        size: 20,
        weight: .medium,
        boldWeight: .bold,
        headingWeight: .semibold,
        headingBoldWeight: .bold,
        ink: .notePaperInk,
        onDark: false
    )

    /// A note card in the grid, at the size of footnote text.
    static var card: NoteLook {
        NoteLook(
            size: UIFont.preferredFont(forTextStyle: .footnote).pointSize,
            weight: .regular,
            boldWeight: .bold,
            headingWeight: .semibold,
            headingBoldWeight: .bold,
            headingScale: [1.25, 1.15, 1.05],
            ink: .notePaperInk,
            onDark: false
        )
    }

    /// The script editor on the teleprompter card, over the camera.
    static let scriptCard = NoteLook(
        size: 19,
        weight: .medium,
        boldWeight: .bold,
        headingWeight: .semibold,
        headingBoldWeight: .bold,
        headingScale: [1.35, 1.2, 1.1],
        ink: .white,
        onDark: true
    )

    /// The running prompter, at the reader's text size.
    static func prompter(size: CGFloat) -> NoteLook {
        NoteLook(
            size: size,
            weight: .heavy,
            boldWeight: .black,
            headingWeight: .heavy,
            headingBoldWeight: .black,
            headingScale: [1.4, 1.25, 1.12],
            ink: .white,
            onDark: true
        )
    }

    /// The weight from which a font reads as bold.
    private static let boldThreshold = (UIFont.Weight.semibold.rawValue + UIFont.Weight.bold.rawValue) / 2

    /// The size and the plain and bold weights of a block's words.
    private func face(_ kind: NoteBlockKind) -> (size: CGFloat, weight: Font.Weight, bold: Font.Weight) {
        guard case .heading(let level) = kind else { return (size, weight, boldWeight) }
        return (size * headingScale[min(max(level, 1), headingScale.count) - 1], headingWeight, headingBoldWeight)
    }

    /// The face words draw in. Bold and italic ride on the plain face as
    /// modifiers, the way the system's format menu writes them, so the menu
    /// can take them off again.
    func font(_ kind: NoteBlockKind, _ marks: NoteMarks) -> Font {
        let face = face(kind)
        var font = Font.system(size: face.size, weight: face.weight)
        if marks.bold { font = face.bold == .bold ? font.bold() : font.weight(face.bold) }
        if marks.italic { font = font.italic() }
        return font
    }

    /// The same face, for measuring.
    func uiFont(_ kind: NoteBlockKind, _ marks: NoteMarks) -> UIFont {
        let face = face(kind)
        let font = UIFont.systemFont(ofSize: face.size, weight: Self.uiWeight(marks.bold ? face.bold : face.weight))
        guard marks.italic,
              let italic = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic))
        else { return font }
        return UIFont(descriptor: italic, size: face.size)
    }

    private static func uiWeight(_ weight: Font.Weight) -> UIFont.Weight {
        let weights: [(Font.Weight, UIFont.Weight)] = [
            (.ultraLight, .ultraLight), (.thin, .thin), (.light, .light), (.regular, .regular),
            (.medium, .medium), (.semibold, .semibold), (.bold, .bold), (.heavy, .heavy), (.black, .black),
        ]
        return weights.first { $0.0 == weight }?.1 ?? .regular
    }

    func color(_ color: NoteTextColor) -> Color {
        Color(hex: onDark ? color.dark : color.paper)
    }

    /// The attributes a run draws with. Markers draw plain, in the line's face.
    func attributes(_ kind: NoteBlockKind, _ marks: NoteMarks, marker: Bool = false) -> AttributeContainer {
        let marks = marker ? NoteMarks() : marks
        var container = AttributeContainer()
        container[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = font(kind, marks)
        if let color = marks.color {
            container[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = self.color(color)
        }
        if marks.underline {
            container[AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = Text.LineStyle.single
        }
        if marks.strike {
            container[AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute.self] = Text.LineStyle.single
        }
        return container
    }

    /// The text of these blocks as this surface draws them, markers included.
    func text(_ blocks: [NoteBlock]) -> AttributedString {
        let source = NoteRichText.attributedText(blocks)
        var out = AttributedString()
        for run in source.runs {
            let kind = run[NoteLineAttribute.self]?.kind ?? .paragraph
            let marks = run[NoteMarksAttribute.self] ?? NoteMarks()
            let marker = run[NoteMarkerAttribute.self] ?? false
            out += AttributedString(
                String(source[run.range].characters),
                attributes: attributes(kind, marks, marker: marker)
            )
        }
        return out
    }

    /// Paced prompter copy as this surface draws it: a line break inside a
    /// block, a blank line between blocks.
    func text(_ paced: [PacedBlock]) -> AttributedString {
        var out = AttributedString()
        for (index, block) in paced.enumerated() {
            if index > 0 { out += AttributedString("\n\n", attributes: attributes(.paragraph, NoteMarks())) }
            for (number, line) in block.lines.enumerated() {
                if number > 0 { out += AttributedString("\n", attributes: attributes(block.kind, NoteMarks())) }
                for run in line {
                    out += AttributedString(run.text, attributes: attributes(block.kind, run.marks))
                }
            }
        }
        return out
    }

    /// How wide a line of runs draws in this face.
    func width(_ runs: [NoteRun], _ kind: NoteBlockKind) -> Double {
        let line = NSMutableAttributedString()
        for run in runs {
            line.append(NSAttributedString(string: run.text, attributes: [.font: uiFont(kind, run.marks)]))
        }
        return line.size().width
    }

    // MARK: Reading the editor back

    /// The styles a run of the editor's text shows: bold and italic off its
    /// face, lines off its decorations, and its color as the nearest of the
    /// note colors — the system's format menu offers any color, and the note
    /// keeps the one it reads as.
    func marks(of attributes: AttributeContainer, in context: Font.Context) -> NoteMarks {
        var marks = NoteMarks()
        if let face = ctFont(of: attributes, in: context) {
            let traits = CTFontCopyTraits(face) as? [CFString: Any]
            let weight = (traits?[kCTFontWeightTrait] as? NSNumber)?.doubleValue ?? 0
            marks.bold = weight >= Self.boldThreshold
            marks.italic = CTFontGetSymbolicTraits(face).contains(.traitItalic)
        }
        marks.underline = attributes[AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] != nil
            || (attributes[AttributeScopes.UIKitAttributes.UnderlineStyleAttribute.self].map { $0 != [] } ?? false)
        marks.strike = attributes[AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute.self] != nil
            || (attributes[AttributeScopes.UIKitAttributes.StrikethroughStyleAttribute.self].map { $0 != [] } ?? false)
        marks.color = noteColor(of: attributes)
        return marks
    }

    /// The point size a run is drawn at, or zero when it names no face.
    func pointSize(of attributes: AttributeContainer, in context: Font.Context) -> Double {
        ctFont(of: attributes, in: context).map { Double(CTFontGetSize($0)) } ?? 0
    }

    private func ctFont(of attributes: AttributeContainer, in context: Font.Context) -> CTFont? {
        if let font = attributes[AttributeScopes.SwiftUIAttributes.FontAttribute.self] {
            return font.resolve(in: context).ctFont
        }
        if let font = attributes[AttributeScopes.UIKitAttributes.FontAttribute.self] {
            return font as CTFont
        }
        return nil
    }

    private func noteColor(of attributes: AttributeContainer) -> NoteTextColor? {
        let rgb: (Double, Double, Double)
        if let color = attributes[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] {
            rgb = Self.components(color)
        } else if let color = attributes[AttributeScopes.UIKitAttributes.ForegroundColorAttribute.self] {
            rgb = Self.components(Color(uiColor: color))
        } else {
            return nil
        }
        func distance(_ other: Color) -> Double {
            let o = Self.components(other)
            return pow(rgb.0 - o.0, 2) + pow(rgb.1 - o.1, 2) + pow(rgb.2 - o.2, 2)
        }
        let nearest = NoteTextColor.allCases.min { distance(color($0)) < distance(color($1)) }
        guard let nearest, distance(color(nearest)) < distance(ink) else { return nil }
        return nearest
    }

    private static func components(_ color: Color) -> (Double, Double, Double) {
        let resolved = color.resolve(in: EnvironmentValues())
        return (Double(resolved.red), Double(resolved.green), Double(resolved.blue))
    }

    /// The text as a reader sees it: for each stretch, the styles it reads
    /// as and the size it draws at. Two texts that look alike compare equal
    /// however their attributes are spelled.
    func appearance(of text: AttributedString, in context: Font.Context) -> [NoteAppearance] {
        var out: [NoteAppearance] = []
        for run in text.runs {
            let look = NoteAppearance(
                marks: marks(of: run.attributes, in: context),
                pointSize: (pointSize(of: run.attributes, in: context) * 10).rounded(),
                length: text[run.range].characters.count
            )
            if let last = out.last, last.marks == look.marks, last.pointSize == look.pointSize {
                out[out.count - 1].length += look.length
            } else {
                out.append(look)
            }
        }
        return out
    }
}

struct NoteAppearance: Equatable {
    var marks: NoteMarks
    var pointSize: Double
    var length: Int
}
#endif
