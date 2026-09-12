import DonkeyKitModels
import SwiftUI

struct WatchCameraView: View {
    var link: WatchCameraLink
    /// The crown's running count. Only the change between turns matters;
    /// the range is wide so it never hits an end mid-take.
    @State private var crown: Double = 0
    @State private var crownRead: Double = 0

    var body: some View {
        ZStack {
            picture
            VStack(spacing: 0) {
                if let startedAt = link.recordingStartedAt {
                    RecordingClock(startedAt: startedAt)
                        .padding(.top, 4)
                }
                Spacer()
                recordButton
                    .padding(.bottom, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .ignoresSafeArea()
        .animation(.spring(duration: 0.3), value: link.recordingStartedAt != nil)
        // The crown scrolls the script on the phone, so a reader mid-take
        // can bring the words back without reaching for the screen.
        .focusable()
        .digitalCrownRotation(
            $crown,
            from: -1_000_000,
            through: 1_000_000,
            by: 1,
            sensitivity: .medium,
            isContinuous: false,
            isHapticFeedbackEnabled: false
        )
        .onChange(of: crown) { _, value in
            link.scrollScript(by: value - crownRead)
            crownRead = value
        }
    }

    @ViewBuilder private var picture: some View {
        if let frame = link.frame {
            // The picture rides as an overlay so its size never reaches the
            // layout: a fill-scaled image laid out directly grows the stack
            // past the screen and pushes the button off the bottom.
            Color.black
                .overlay {
                    Image(uiImage: frame)
                        .resizable()
                        .scaledToFill()
                }
                .clipped()
                .ignoresSafeArea()
        } else if let hint {
            VStack(spacing: 8) {
                Image(systemName: hint.icon)
                    .font(.title2)
                Text(hint.text)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.bottom, 40)
        }
    }

    /// What to say while there is no picture. The phone's own word comes
    /// first; a phone that has been out of reach for a while comes next;
    /// anything in between stays quiet so nothing flashes on the way up.
    private var hint: (icon: String, text: String)? {
        if link.hasState, !link.state.isCameraOpen {
            return ("iphone", "Open the camera on your iPhone")
        }
        if link.isPhoneAway {
            return ("iphone.slash", "Open Donkey Cut on your iPhone")
        }
        return nil
    }

    private var recordButton: some View {
        Button {
            link.toggleRecording()
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(.white, lineWidth: 3)
                    .frame(width: 56, height: 56)
                RoundedRectangle(cornerRadius: link.recordingStartedAt != nil ? 5 : 22)
                    .fill(.red)
                    .frame(
                        width: link.recordingStartedAt != nil ? 22 : 44,
                        height: link.recordingStartedAt != nil ? 22 : 44
                    )
            }
            .animation(.snappy(duration: 0.2), value: link.recordingStartedAt != nil)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(link.recordingStartedAt != nil ? "Stop recording" : "Start recording")
    }
}

/// The red clock: how long the camera has been rolling, with a tally dot
/// that blinks on the second.
struct RecordingClock: View {
    let startedAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let elapsed = context.date.timeIntervalSince(startedAt)
            HStack(spacing: 5) {
                Circle()
                    .fill(.white)
                    .frame(width: 7, height: 7)
                    .opacity(Int(elapsed * 2) % 2 == 0 ? 1 : 0.3)
                Text(formattedDuration(elapsed))
                    .font(.footnote.weight(.bold))
                    .monospacedDigit()
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color.red.opacity(0.9), in: Capsule())
        }
    }
}
