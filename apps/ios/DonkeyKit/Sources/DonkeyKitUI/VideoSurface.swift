#if os(iOS)
import AVFoundation
import SwiftUI

// The video surface every full-screen player in the app shares. AVKit's
// VideoPlayer draws its own buttons in the top corners and its own scrubber
// along the bottom, which land on top of the chrome each screen puts there;
// these two carry the picture and the transport, and the screen owns the rest.

/// The picture alone.
struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    final class PlayerView: UIView {
        override public class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// Play, position, and how much is left, in the viewer's own hand.
struct PlaybackBar: View {
    let player: AVPlayer

    @State private var time = 0.0
    @State private var duration = 0.0
    @State private var scrubbing = false
    @State private var playing = true

    var body: some View {
        HStack(spacing: 12) {
            Button {
                if playing { player.pause() } else { player.play() }
            } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.body.weight(.bold))
                    .frame(width: 24, height: 24)
            }
            Text(clock(time))
            Slider(value: $time, in: 0...max(duration, 0.1)) { editing in
                scrubbing = editing
                if !editing {
                    player.seek(
                        to: CMTime(seconds: time, preferredTimescale: 600),
                        toleranceBefore: .zero,
                        toleranceAfter: .zero
                    )
                }
            }
            Text("−" + clock(max(duration - time, 0)))
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.white)
        .tint(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.black.opacity(0.55))
        .task {
            if let asset = player.currentItem?.asset,
               let length = try? await asset.load(.duration).seconds, length.isFinite {
                duration = length
            }
            while !Task.isCancelled {
                let now = player.currentTime().seconds
                if !scrubbing, now.isFinite { time = now }
                playing = player.timeControlStatus != .paused
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    private func clock(_ seconds: Double) -> String {
        let whole = Int(seconds.isFinite ? seconds : 0)
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}
#endif
