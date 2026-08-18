import CoreGraphics
import Foundation

/// One reading of the pointer during a recording: where it sat in the recorded frame and whether a
/// button was down. Positions are fractions of the frame (0…1) from its top-left corner, so a track
/// survives any scale the video is exported at.
public struct CursorSample: Codable, Equatable, Sendable {
    /// Seconds from the moment capture started.
    public let t: Double
    public let x: Double
    public let y: Double
    /// Any mouse button held at this reading — the beat an auto-zoom wants to land on.
    public let pressed: Bool
    /// Whether the pointer was inside the recorded frame. `x`/`y` stay unclamped when it is not, so a
    /// consumer can tell "just off the left edge" from "parked at the left edge".
    public let inside: Bool

    public init(t: Double, x: Double, y: Double, pressed: Bool, inside: Bool) {
        self.t = t
        self.x = x
        self.y = y
        self.pressed = pressed
        self.inside = inside
    }
}

/// The pointer's path through a recording, written beside the `.mov`. The video itself never draws a
/// cursor: the path rides as data so an editor can draw its own pointer, follow it with a zoom, or
/// ignore it.
public struct CursorTrack: Codable, Equatable, Sendable {
    public static let version = 1

    public let version: Int
    /// Readings per second the recorder aimed for. Samples are dropped while nothing moves, so the
    /// gaps between them are uneven; hold the last reading across a gap.
    public let sampleRate: Int
    /// The recorded frame in points, the rect the fractions are measured against.
    public let frameWidth: Double
    public let frameHeight: Double
    public let samples: [CursorSample]

    public init(sampleRate: Int, frameSize: CGSize, samples: [CursorSample]) {
        self.version = Self.version
        self.sampleRate = sampleRate
        self.frameWidth = Double(frameSize.width)
        self.frameHeight = Double(frameSize.height)
        self.samples = samples
    }
}

/// Samples the pointer for the length of a recording. The capture rect is asked for on every reading
/// rather than captured once, so a window that gets dragged mid-recording still yields positions in
/// its own frame.
@MainActor
public final class CursorTrackRecorder {
    private let sampleRate: Int
    private var captureRect: (@MainActor () -> CGRect?)?
    private var timer: Timer?
    private var startedAt: Date?
    private var samples: [CursorSample] = []
    private var frameSize: CGSize = .zero
    private var last: (x: Double, y: Double, pressed: Bool, inside: Bool)?

    public init(sampleRate: Int = 60) {
        self.sampleRate = max(1, sampleRate)
    }

    /// Begin sampling. `captureRect` answers in CoreGraphics global points (top-left origin) — the
    /// space `SCWindow.frame` and `CGDisplayBounds` report.
    public func start(captureRect: @escaping @MainActor () -> CGRect?) {
        stopTimer()
        self.captureRect = captureRect
        samples = []
        last = nil
        frameSize = captureRect()?.size ?? .zero
        startedAt = Date()
        sample()
        let timer = Timer(timeInterval: 1.0 / Double(sampleRate), repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sample() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Stop sampling and hand back what was recorded.
    public func finish() -> CursorTrack {
        stopTimer()
        let track = CursorTrack(sampleRate: sampleRate, frameSize: frameSize, samples: samples)
        captureRect = nil
        startedAt = nil
        samples = []
        last = nil
        return track
    }

    private func sample() {
        guard let startedAt, let rect = captureRect?(), rect.width > 0, rect.height > 0 else { return }
        frameSize = rect.size
        let point = Self.cursorLocation()
        let x = Double((point.x - rect.minX) / rect.width)
        let y = Double((point.y - rect.minY) / rect.height)
        let pressed = Self.anyButtonDown()
        let inside = (0...1).contains(x) && (0...1).contains(y)
        let reading = (x: round(x), y: round(y), pressed: pressed, inside: inside)
        // A still pointer writes nothing: the track keeps its turns, not its idle time.
        if let last, last == reading { return }
        last = reading
        samples.append(CursorSample(
            t: Date().timeIntervalSince(startedAt),
            x: reading.x,
            y: reading.y,
            pressed: pressed,
            inside: inside
        ))
    }

    /// Fractions to five places — a pixel on an 8K frame, and it keeps the sidecar small.
    private func round(_ value: Double) -> Double {
        (value * 100_000).rounded() / 100_000
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    /// The pointer in CoreGraphics global points (top-left origin) — the space the capture rects
    /// come in, straight from the event system with no AppKit in the way.
    private static func cursorLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private static func anyButtonDown() -> Bool {
        let buttons: [CGMouseButton] = [.left, .right, .center]
        return buttons.contains { CGEventSource.buttonState(.combinedSessionState, button: $0) }
    }
}
