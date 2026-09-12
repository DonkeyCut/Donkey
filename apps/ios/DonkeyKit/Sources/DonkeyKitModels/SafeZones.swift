import Foundation

/// The short-form guide: the parts of a vertical frame that TikTok, Reels
/// and Shorts cover with their own UI or crop away, merged into one keep-out
/// so each region is the widest of the three. It is the same guide the
/// editor's preview draws, measured September 2026 on a 1170×2532 phone and
/// mapped onto a 1080×1920 frame: the top band is the status bar and the
/// search row under it, the rail the actions from the avatar down, the
/// bottom band the username, caption and music line, and the side strips
/// what Reels and Shorts crop when they fill a taller phone screen.
nonisolated public enum ShortFormGuide {
    private static func phone(_ px: Double, of total: Double) -> Double { px / total }

    public static let boxes: [SafeZoneRegion] = [
        SafeZoneRegion(x: 0, y: 0, width: 1, height: phone(215, of: 1920), label: "Top bar"),
        SafeZoneRegion(x: 0, y: 0, width: phone(50, of: 1080), height: 1, label: "Cropped"),
        SafeZoneRegion(x: 1 - phone(50, of: 1080), y: 0, width: phone(50, of: 1080), height: 1, label: "Cropped"),
        SafeZoneRegion(x: phone(895, of: 1080), y: phone(730, of: 1920), width: phone(185, of: 1080), height: phone(730, of: 1920), label: "Actions"),
        SafeZoneRegion(x: 0, y: phone(1460, of: 1920), width: 1, height: phone(460, of: 1920), label: "Caption · music · nav"),
    ]
}

/// A rectangle in a frame's own units: every value is a fraction of the
/// frame's width or height.
nonisolated public struct SafeZoneRegion: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var label: String

    public init(x: Double, y: Double, width: Double, height: Double, label: String) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.label = label
    }
}

/// Where a picture lands on a screen it fills: scaled until it covers the
/// screen, centered, with the overflow off the edges.
nonisolated public struct FrameRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    /// `contentAspect` is the picture's width over its height; the frame it
    /// returns is in the container's coordinates and may start off screen.
    public static func aspectFill(contentAspect: Double, containerWidth: Double, containerHeight: Double) -> FrameRect {
        guard contentAspect > 0, containerWidth > 0, containerHeight > 0 else {
            return FrameRect(x: 0, y: 0, width: containerWidth, height: containerHeight)
        }
        let containerAspect = containerWidth / containerHeight
        if contentAspect > containerAspect {
            // Wider than the screen: full height, sides cropped.
            let width = containerHeight * contentAspect
            return FrameRect(x: (containerWidth - width) / 2, y: 0, width: width, height: containerHeight)
        }
        // Taller than the screen: full width, top and bottom cropped.
        let height = containerWidth / contentAspect
        return FrameRect(x: 0, y: (containerHeight - height) / 2, width: containerWidth, height: height)
    }
}
