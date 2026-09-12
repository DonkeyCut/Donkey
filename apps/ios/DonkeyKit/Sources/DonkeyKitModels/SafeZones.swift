import Foundation

/// A short-form platform whose own chrome covers part of a vertical frame:
/// the bar across the top, the caption block along the bottom, the action
/// column down the right edge. Whatever a shot needs stays out of them.
nonisolated public enum SafeZonePlatform: String, CaseIterable, Codable, Sendable, Identifiable {
    case tiktok, reels, shorts

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .tiktok: "TikTok"
        case .reels: "Reels"
        case .shorts: "Shorts"
        }
    }

    /// The covered parts of a 9:16 frame, as fractions of its width and
    /// height. The numbers approximate each platform's layout on a phone;
    /// the platforms move their chrome now and then, so these are tuned by
    /// eye against a current phone.
    public var covered: [SafeZoneRegion] {
        switch self {
        case .tiktok: [
            SafeZoneRegion(x: 0, y: 0, width: 1, height: 0.11),
            SafeZoneRegion(x: 0, y: 0.76, width: 1, height: 0.24),
            SafeZoneRegion(x: 0.87, y: 0.36, width: 0.13, height: 0.40),
        ]
        case .reels: [
            SafeZoneRegion(x: 0, y: 0, width: 1, height: 0.12),
            SafeZoneRegion(x: 0, y: 0.74, width: 1, height: 0.26),
            SafeZoneRegion(x: 0.86, y: 0.40, width: 0.14, height: 0.34),
        ]
        case .shorts: [
            SafeZoneRegion(x: 0, y: 0, width: 1, height: 0.09),
            SafeZoneRegion(x: 0, y: 0.78, width: 1, height: 0.22),
            SafeZoneRegion(x: 0.87, y: 0.44, width: 0.13, height: 0.34),
        ]
        }
    }
}

/// A rectangle in a frame's own units: every value is a fraction of the
/// frame's width or height.
nonisolated public struct SafeZoneRegion: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
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
