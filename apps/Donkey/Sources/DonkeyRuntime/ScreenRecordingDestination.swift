import Foundation

/// Where a finished screen recording is written and how it is named — QuickTime's default: a
/// timestamped `.mov` on the Desktop, de-collided so a second recording in the same second doesn't
/// overwrite the first. Pure path logic (no AppKit) so the naming rule is unit-testable; revealing the
/// file in Finder lives with the AppKit controllers.
public enum ScreenRecordingDestination {
    /// `Screen Recording 2026-07-21 at 15.24.05` — QuickTime's filename shape, stable across locales.
    public static func fileName(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return "Screen Recording \(formatter.string(from: date))"
    }

    /// The first non-colliding URL: `<base>.<ext>`, then `<base> (2).<ext>`, `(3)`, and so on.
    /// `fileExists` is injected so tests can drive collisions without touching the filesystem.
    public static func uniqueURL(
        in directory: URL,
        baseName: String,
        ext: String,
        fileExists: (URL) -> Bool
    ) -> URL {
        var candidate = directory.appendingPathComponent("\(baseName).\(ext)")
        var counter = 2
        while fileExists(candidate) {
            candidate = directory.appendingPathComponent("\(baseName) (\(counter)).\(ext)")
            counter += 1
        }
        return candidate
    }

    /// The concrete output URL for a recording starting now, on the real Desktop.
    public static func makeOutputURL(now: Date = Date()) -> URL {
        let fileManager = FileManager.default
        let desktop = fileManager.urls(for: .desktopDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
        return uniqueURL(
            in: desktop,
            baseName: fileName(for: now),
            ext: "mov",
            fileExists: { fileManager.fileExists(atPath: $0.path) }
        )
    }
}
