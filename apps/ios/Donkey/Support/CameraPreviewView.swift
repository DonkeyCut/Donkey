import AVFoundation
import AVKit
import DonkeyKitModels
import SwiftUI
import UIKit

/// SwiftUI has no native capture preview; this hosts the controller's
/// persistent preview view and attaches the hardware capture events
/// (volume buttons, Camera Control) to the record action.
///
/// The preview layer attaches to the session once, at controller init while
/// the session is idle. Attaching or detaching later runs on the main thread
/// and takes the session's lock, which stalls the UI for as long as the
/// capture queue is busy starting or stopping — so the host view lives for
/// the app's lifetime and tab switches only re-parent it.
struct CameraPreviewView: UIViewRepresentable {
    let host: PreviewHostView
    let onCaptureEvent: () -> Void

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        host.frame = container.bounds
        host.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(host)

        let interaction = AVCaptureEventInteraction { event in
            guard event.phase == .ended else { return }
            context.coordinator.onCaptureEvent()
        }
        container.addInteraction(interaction)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onCaptureEvent = onCaptureEvent
        if host.superview !== uiView {
            host.frame = uiView.bounds
            uiView.addSubview(host)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCaptureEvent: onCaptureEvent)
    }

    final class Coordinator {
        var onCaptureEvent: () -> Void

        init(onCaptureEvent: @escaping () -> Void) {
            self.onCaptureEvent = onCaptureEvent
        }
    }

    final class PreviewHostView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer {
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}
