import AppKit
import DonkeyUI
import SwiftUI

/// The floating QuickTime-style control bar, pinned center-bottom of a screen. A borderless,
/// non-activating panel so its buttons click without stealing focus from the app being recorded. The
/// controller owns framing (`hostingView.sizingOptions = []`) to avoid the SwiftUI layout re-entrancy
/// crash the other overlays document.
@MainActor
final class RecordingControlBarController {
    let model: RecordingControlBarModel
    private var panel: NSPanel?
    private var hostingView: NSHostingView<RecordingControlBarView>?

    init(model: RecordingControlBarModel) {
        self.model = model
    }

    /// The bar's window number, so the recorder can exclude it from the captured video.
    var windowNumber: Int? { panel?.windowNumber }

    func show(on screen: NSScreen) {
        guard panel == nil else {
            reposition(on: screen)
            return
        }
        let size = RecordingControlBarView.contentSize
        let hostingView = NSHostingView(rootView: RecordingControlBarView(model: model))
        hostingView.sizingOptions = []
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.autoresizingMask = [.width, .height]
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor

        let panel = NSPanel(
            contentRect: frame(for: size, on: screen),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Screen Recording Controls"
        panel.contentView = hostingView
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = false
        panel.level = DonkeyOverlayWindowLevel.recordingControlBar
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .ignoresCycle,
            .stationary
        ]
        panel.orderFrontRegardless()
        self.panel = panel
        self.hostingView = hostingView
    }

    func reposition(on screen: NSScreen) {
        guard let panel else { return }
        panel.setFrame(frame(for: panel.frame.size, on: screen), display: true)
    }

    func close() {
        panel?.close()
        panel = nil
        hostingView = nil
    }

    private func frame(for size: CGSize, on screen: NSScreen) -> CGRect {
        let x = screen.frame.midX - size.width / 2
        // The panel drops by the hint lane it carries above the bar, so the bar itself sits the
        // same 24pt off the bottom of the screen whether or not a hint is showing.
        let y = screen.visibleFrame.minY + 24 - RecordingControlBarView.hintLaneHeight
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }
}
