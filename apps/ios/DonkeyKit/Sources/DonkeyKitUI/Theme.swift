#if os(iOS)
import SwiftUI
import DonkeyKitModels

extension Color {
    /// Parses "#rrggbb" strings; the note palette lives in DonkeyKitModels as hex.
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255
        )
    }

    static let recordPink = Color(hex: "#d81b60")
    /// The Cut app's accent blue; tints everything except recording controls.
    static let accentBlue = Color(hex: "#0a84ff")
    static let notePaperInk = Color(hex: "#201a0d")
}

extension NoteColor {
    var backgroundColor: Color { Color(hex: background) }
    var accentColor: Color { Color(hex: accent) }
}

extension AppearancePreference {
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
#endif
