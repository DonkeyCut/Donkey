import AVFoundation
import AVKit
import DonkeyKitModels
import SwiftUI
import UIKit

/// SwiftUI has no native capture preview; this hosts an
/// AVCaptureVideoPreviewLayer and attaches the hardware capture events
/// (volume buttons, Camera Control) to the record action.
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    let onCaptureEvent: () -> Void

    func makeUIView(context: Context) -> PreviewHostView {
        let view = PreviewHostView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill

        let interaction = AVCaptureEventInteraction { event in
            guard event.phase == .ended else { return }
            context.coordinator.onCaptureEvent()
        }
        view.addInteraction(interaction)
        return view
    }

    func updateUIView(_ uiView: PreviewHostView, context: Context) {
        context.coordinator.onCaptureEvent = onCaptureEvent
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
