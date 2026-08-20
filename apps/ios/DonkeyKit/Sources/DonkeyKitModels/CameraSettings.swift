import Foundation

nonisolated public enum CaptureResolution: String, CaseIterable, Codable, Sendable {
    case hd = "HD"
    case qhd = "2K"
    case uhd = "4K"

    public var pixelArea: Int {
        switch self {
        case .hd: 1920 * 1080
        case .qhd: 2560 * 1440
        case .uhd: 3840 * 2160
        }
    }
}

nonisolated public enum CaptureFrameRate: Int, CaseIterable, Codable, Sendable {
    case fps24 = 24
    case fps30 = 30
    case fps60 = 60
}

nonisolated public enum CaptureColorMode: String, CaseIterable, Codable, Sendable {
    case sdr = "SDR"
    case hdr = "HDR"
}

nonisolated public struct CameraSettings: Equatable, Codable, Sendable {
    public var resolution: CaptureResolution
    public var frameRate: CaptureFrameRate
    public var colorMode: CaptureColorMode

    public init(resolution: CaptureResolution = .hd, frameRate: CaptureFrameRate = .fps30, colorMode: CaptureColorMode = .sdr) {
        self.resolution = resolution
        self.frameRate = frameRate
        self.colorMode = colorMode
    }
}

nonisolated public enum CameraFacing: Sendable, Equatable {
    case front, back

    public var flipped: CameraFacing { self == .front ? .back : .front }
}

/// A capture format reduced to the facts selection needs, so the choice is
/// pure and testable. `index` points back into the device's format array.
nonisolated public struct CaptureFormatSpec: Equatable, Sendable {
    public var index: Int
    public var width: Int
    public var height: Int
    public var maxFrameRate: Double
    public var supportsHLG: Bool

    public init(index: Int, width: Int, height: Int, maxFrameRate: Double, supportsHLG: Bool) {
        self.index = index
        self.width = width
        self.height = height
        self.maxFrameRate = maxFrameRate
        self.supportsHLG = supportsHLG
    }

    var area: Int { width * height }
}

nonisolated public struct FormatChoice: Equatable, Sendable {
    public var index: Int
    /// What the device could actually honor, after fallbacks.
    public var effective: CameraSettings
}

/// Picks the device format closest to the requested settings, relaxing one
/// axis at a time when the device can't honor the request: HDR falls back to
/// SDR, an unavailable frame rate falls back through 30 to 24, and resolution
/// snaps to the nearest available area.
nonisolated public func chooseFormat(from specs: [CaptureFormatSpec], settings: CameraSettings) -> FormatChoice? {
    guard !specs.isEmpty else { return nil }

    let frameRateFallbacks: [CaptureFrameRate] = switch settings.frameRate {
    case .fps60: [.fps60, .fps30, .fps24]
    case .fps30: [.fps30, .fps24]
    case .fps24: [.fps24]
    }
    let colorFallbacks: [CaptureColorMode] = settings.colorMode == .hdr ? [.hdr, .sdr] : [.sdr]

    for color in colorFallbacks {
        for frameRate in frameRateFallbacks {
            let candidates = specs.filter { spec in
                spec.maxFrameRate >= Double(frameRate.rawValue)
                    && (color == .sdr || spec.supportsHLG)
            }
            guard let best = candidates.min(by: { lhs, rhs in
                let lhsDiff = abs(lhs.area - settings.resolution.pixelArea)
                let rhsDiff = abs(rhs.area - settings.resolution.pixelArea)
                if lhsDiff != rhsDiff { return lhsDiff < rhsDiff }
                return lhs.area < rhs.area
            }) else { continue }
            return FormatChoice(
                index: best.index,
                effective: CameraSettings(resolution: settings.resolution, frameRate: frameRate, colorMode: color)
            )
        }
    }
    return nil
}

/// Maps user-facing zoom factors (0.5×, 1×, 2×…) onto a device's
/// `videoZoomFactor` scale, where 1.0 is the widest constituent camera.
nonisolated public struct ZoomMapping: Equatable, Sendable {
    /// videoZoomFactor that renders the user's 1× (the main wide camera).
    public var wideBase: Double
    public var minDisplay: Double
    public var maxDisplay: Double

    public init(wideBase: Double, minDisplay: Double, maxDisplay: Double) {
        self.wideBase = wideBase
        self.minDisplay = minDisplay
        self.maxDisplay = maxDisplay
    }

    public var options: [Double] {
        [0.5, 1, 2, 3].filter { $0 >= minDisplay && $0 <= maxDisplay }
    }

    public func videoZoomFactor(forDisplay display: Double) -> Double {
        min(max(display, minDisplay), maxDisplay) * wideBase
    }
}

nonisolated public func zoomLabel(_ display: Double) -> String {
    let formatted = display == display.rounded()
        ? String(Int(display))
        : String(display)
    return formatted + "×"
}
