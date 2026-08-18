import AppKit
import SwiftUI

/// The three things a screen recording can capture, as the control bar presents them.
public enum RecordingCaptureMode: String, CaseIterable, Sendable {
    case fullScreen
    case window
    case region

    var symbolName: String {
        switch self {
        case .fullScreen: return "rectangle.inset.filled"
        case .window: return "macwindow"
        case .region: return "rectangle.dashed"
        }
    }

    var tooltip: String {
        switch self {
        case .fullScreen: return "Record Entire Screen"
        case .window: return "Record Window"
        case .region: return "Record Selected Portion"
        }
    }
}

/// One selectable audio source for the input picker: system output, a specific microphone, or none.
public struct RecordingAudioInput: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case none
        case systemAudio
        case microphone(deviceID: String)
    }

    public let id: String
    public let kind: Kind
    public let label: String

    public init(id: String, kind: Kind, label: String) {
        self.id = id
        self.kind = kind
        self.label = label
    }
}

/// State + callbacks the control bar renders from. The controller owns the truth and mutates these;
/// the view is a pure projection and routes taps back through the closures.
@MainActor
public final class RecordingControlBarModel: ObservableObject {
    @Published public var mode: RecordingCaptureMode = .fullScreen
    @Published public var audioInputs: [RecordingAudioInput] = []
    @Published public var selectedAudioInputID = ""
    @Published public var isRecording = false
    @Published public var isBusy = false
    @Published public var elapsedText = "0:00"
    @Published public var canRecord = true
    /// An inline hint under the bar (e.g. a permission prompt); `nil` hides it.
    @Published public var statusMessage: String?

    public var onSelectMode: ((RecordingCaptureMode) -> Void)?
    public var onSelectAudioInput: ((String) -> Void)?
    public var onRecord: (() -> Void)?
    public var onStop: (() -> Void)?
    public var onClose: (() -> Void)?

    public init() {}

    var selectedAudioInput: RecordingAudioInput? {
        audioInputs.first { $0.id == selectedAudioInputID }
    }

    var selectedAudioInputLabel: String {
        selectedAudioInput?.label ?? "None"
    }

    var audioIconName: String {
        guard let kind = selectedAudioInput?.kind else { return "speaker.slash.fill" }
        switch kind {
        case .none: return "speaker.slash.fill"
        case .systemAudio, .microphone: return "speaker.wave.2.fill"
        }
    }
}

public struct RecordingControlBarView: View {
    /// Fixed panel size — the controller owns framing (`hostingView.sizingOptions = []`), so the bar
    /// paints to a known rect rather than pushing its content size back to the window.
    public static let contentSize = CGSize(width: 500, height: 96)

    /// The lane above the bar that holds the hovered control's name, plus the stack spacing under
    /// it. The controller drops the panel by this much so the bar itself stays put.
    public static let hintLaneHeight: CGFloat = 24

    @ObservedObject private var model: RecordingControlBarModel
    @State private var hint: String?

    public init(model: RecordingControlBarModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 6) {
            hintLabel
            bar
            if let statusMessage = model.statusMessage {
                Text(statusMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(width: Self.contentSize.width, height: Self.contentSize.height, alignment: .top)
    }

    /// The hovered control's name, above the bar. The bar floats over whatever is being recorded
    /// while Donkey sits inactive in the menu bar, and AppKit holds its own tooltips back for an
    /// inactive app — so the bar carries its own.
    private var hintLabel: some View {
        Text(hint ?? " ")
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(.ultraThinMaterial))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            .opacity(hint == nil ? 0 : 1)
            .frame(height: 18)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            iconButton(symbol: "xmark", help: "Close") { model.onClose?() }

            Divider().frame(height: 22)

            if model.isRecording {
                recordingStatus
            } else {
                ForEach(RecordingCaptureMode.allCases, id: \.self) { mode in
                    modeButton(mode)
                }
                Divider().frame(height: 22)
                audioInputPicker
            }

            Spacer(minLength: 4)
            recordButton
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(
            Capsule().fill(.ultraThinMaterial)
        )
        .overlay(
            Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private var recordingStatus: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
            Text(model.elapsedText)
                .font(.system(size: 14, weight: .medium).monospacedDigit())
        }
    }

    private func modeButton(_ mode: RecordingCaptureMode) -> some View {
        let isActive = model.mode == mode
        return Button {
            model.onSelectMode?(mode)
        } label: {
            Image(systemName: mode.symbolName)
                .font(.system(size: 15, weight: .medium))
                .frame(width: 34, height: 30)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(isActive ? Color.accentColor.opacity(0.85) : Color.clear)
                )
                .foregroundStyle(isActive ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .hoverHint(mode.tooltip, into: $hint)
    }

    /// The audio input selector: a sound icon, the current input's name, and a chevron opening the
    /// list of sources (System Audio, each microphone, None).
    private var audioInputPicker: some View {
        Menu {
            ForEach(model.audioInputs) { input in
                Button {
                    model.onSelectAudioInput?(input.id)
                } label: {
                    if input.id == model.selectedAudioInputID {
                        Label(input.label, systemImage: "checkmark")
                    } else {
                        Text(input.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: model.audioIconName)
                    .font(.system(size: 13, weight: .medium))
                Text(model.selectedAudioInputLabel)
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 130, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .hoverHint("Audio Input", into: $hint)
    }

    private var recordButton: some View {
        Button {
            if model.isRecording { model.onStop?() } else { model.onRecord?() }
        } label: {
            HStack(spacing: 7) {
                RoundedRectangle(cornerRadius: model.isRecording ? 3 : 8)
                    .fill(Color.red)
                    .frame(width: 16, height: 16)
                Text(model.isRecording ? "Stop" : "Record")
                    .font(.system(size: 14, weight: .regular))
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(
                Capsule().fill(Color.primary.opacity(0.08))
            )
        }
        .buttonStyle(.plain)
        .disabled(model.isBusy || (!model.isRecording && !model.canRecord))
        .opacity(model.isBusy || (!model.isRecording && !model.canRecord) ? 0.5 : 1)
        .hoverHint(model.isRecording ? "Stop Recording" : "Start Recording", into: $hint)
    }

    private func iconButton(symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .frame(width: 30, height: 30)
                .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        .hoverHint(help, into: $hint)
    }
}

private extension View {
    /// Name this control in the bar's hint lane while the pointer is on it.
    func hoverHint(_ text: String, into hint: Binding<String?>) -> some View {
        overlay(
            HoverTracker { inside in
                if inside {
                    hint.wrappedValue = text
                } else if hint.wrappedValue == text {
                    hint.wrappedValue = nil
                }
            }
        )
    }
}

/// Pointer enter/exit that fires with Donkey inactive. SwiftUI's `onHover` and AppKit's tooltips
/// both wait on the active app; the tracking area asks for `.activeAlways` instead. The view hands
/// every click straight through, so it reports on top of a button without taking its taps.
private struct HoverTracker: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: TrackingView, context: Context) {
        view.onChange = onChange
    }

    final class TrackingView: NSView {
        var onChange: ((Bool) -> Void)?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            for area in trackingAreas { removeTrackingArea(area) }
            addTrackingArea(NSTrackingArea(
                rect: bounds,
                options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
                owner: self,
                userInfo: nil
            ))
        }

        override func mouseEntered(with event: NSEvent) { onChange?(true) }
        override func mouseExited(with event: NSEvent) { onChange?(false) }
    }
}
