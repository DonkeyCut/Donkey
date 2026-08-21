import Foundation

// Every path-taking API in the app reads through these two properties.
// `URL.path()` percent-encodes by default, and the app's own container is
// rooted at "Application Support" — a name with a space in it — so the encoded
// form names nothing on disk: image loads come back empty and file sizes read
// as zero, which is silent in both cases.

extension URL {
    /// The filesystem path, decoded, for APIs that take a path string.
    nonisolated public var localPath: String { path(percentEncoded: false) }

    /// Bytes on disk, or nil when the file is missing or empty.
    nonisolated public var fileByteCount: Int64? {
        guard let size = try? resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size > 0 else { return nil }
        return Int64(size)
    }
}
