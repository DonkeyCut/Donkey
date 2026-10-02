import ApplicationServices
import Foundation

public enum RecordingWindowResizeError: LocalizedError {
    case unavailable
    case ambiguous
    case fixedSize
    case tooLarge
    case failed

    public var errorDescription: String? {
        switch self {
        case .unavailable: return "The selected window is unavailable. Select it again."
        case .ambiguous: return "Move the selected window away from overlapping windows, then try again."
        case .fixedSize: return "This window cannot be resized. Exit full screen or select a resizable window."
        case .tooLarge: return "Enter a size that fits on the window’s display."
        case .failed: return "The app could not resize its window. Try again."
        }
    }
}

/// Accessibility calls run off the main thread and only when a size is applied.
public actor RecordingWindowResizer {
    public init() {}

    public nonisolated static func frame(windowID: CGWindowID) -> CGRect? {
        windowInfo(windowID: windowID)?.frame
    }

    public func resize(windowID: CGWindowID, size: CGSize, visibleFrames: [CGRect]) async throws -> CGSize {
        guard let info = Self.windowInfo(windowID: windowID) else {
            throw RecordingWindowResizeError.unavailable
        }
        let target = try Self.targetFrame(current: info.frame, size: size, visibleFrames: visibleFrames)
        let app = AXUIElementCreateApplication(info.pid)
        AXUIElementSetMessagingTimeout(app, 1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else {
            throw RecordingWindowResizeError.unavailable
        }
        // Public Accessibility APIs identify windows by geometry. Require a unique match so
        // identical stacked windows never cause us to resize a different capture target.
        let matches = windows.filter { window in
            guard let frame = Self.axFrame(window) else { return false }
            return Self.matches(frame, info.frame)
        }
        guard let window = matches.first else { throw RecordingWindowResizeError.unavailable }
        guard matches.count == 1 else { throw RecordingWindowResizeError.ambiguous }
        var resizable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(window, kAXSizeAttribute as CFString, &resizable) == .success,
              resizable.boolValue else { throw RecordingWindowResizeError.fixedSize }
        var fullScreen: CFTypeRef?
        if AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString, &fullScreen) == .success,
           (fullScreen as? Bool) == true {
            throw RecordingWindowResizeError.fixedSize
        }
        try Task.checkCancellation()
        // Position first so the destination has room for the requested dimensions.
        if target.origin != info.frame.origin {
            var origin = target.origin
            guard let position = AXValueCreate(.cgPoint, &origin),
                  AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) == .success else {
                throw RecordingWindowResizeError.failed
            }
        }
        var requestedSize = size
        guard let axSize = AXValueCreate(.cgSize, &requestedSize),
              AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, axSize) == .success else {
            throw RecordingWindowResizeError.failed
        }
        // Apps can animate or enforce minimum dimensions. Read the window server's resulting
        // geometry, which is also the geometry ScreenCaptureKit uses when recording starts.
        for _ in 0..<5 {
            try await Task.sleep(for: .milliseconds(100))
            guard let actual = Self.frame(windowID: windowID) else {
                throw RecordingWindowResizeError.unavailable
            }
            if abs(actual.width - size.width) < 1, abs(actual.height - size.height) < 1 {
                return actual.size
            }
        }
        guard let actual = Self.frame(windowID: windowID) else { throw RecordingWindowResizeError.unavailable }
        return actual.size
    }

    static func targetFrame(current: CGRect, size: CGSize, visibleFrames: [CGRect]) throws -> CGRect {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              let screen = visibleFrames.max(by: { intersectionArea(current, $0) < intersectionArea(current, $1) }),
              intersectionArea(current, screen) > 0,
              size.width <= screen.width, size.height <= screen.height else {
            throw RecordingWindowResizeError.tooLarge
        }
        return CGRect(
            x: min(max(current.minX, screen.minX), screen.maxX - size.width),
            y: min(max(current.minY, screen.minY), screen.maxY - size.height),
            width: size.width,
            height: size.height
        )
    }

    private static func intersectionArea(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let rect = a.intersection(b)
        return rect.isNull ? 0 : rect.width * rect.height
    }

    private nonisolated static func windowInfo(windowID: CGWindowID) -> (pid: pid_t, frame: CGRect)? {
        guard let entries = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
              let entry = entries.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == windowID }),
              let pid = entry[kCGWindowOwnerPID as String] as? pid_t,
              let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
        return (pid, frame)
    }

    private static func axFrame(_ window: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue,
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func matches(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1
            && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }
}
