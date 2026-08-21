#if os(iOS)
import SwiftUI
import UIKit
import DonkeyKitModels

struct CameraScreen<CameraPreview: View>: View {
    @Bindable var camera: CameraModel
    var ideas: IdeasModel
    var media: MediaModel
    let cameraPreview: () -> CameraPreview

    @State private var showsZoomPicker = false
    @State private var showsQualityPopover = false
    @State private var showsTeleSettings = false
    @State private var showsNotePicker = false
    @State private var playingRecording: Recording?

    var body: some View {
        ZStack {
            stage
            if camera.isFillLightOn, camera.availability == .running {
                FillLightOverlay()
            }
            if camera.isRecording, camera.teleprompter.hasScript {
                TeleprompterOverlay(camera: camera)
            }
            controls
        }
        .background(.black, ignoresSafeAreaEdges: .all)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showsNotePicker) {
            NotePickerSheet(ideas: ideas) { note in
                camera.loadTeleprompter(script: note.script)
                showsNotePicker = false
            }
        }
        .fullScreenCover(item: $playingRecording) { recording in
            RecordingPlayerView(url: media.movieURL(for: recording))
        }
    }

    @ViewBuilder private var stage: some View {
        switch camera.availability {
        case .running, .starting:
            cameraPreview()
                .ignoresSafeArea()
        case .idle:
            Color.black.ignoresSafeArea()
        case .unavailable(let reason):
            VStack(spacing: 8) {
                Image(systemName: "video.slash")
                    .font(.largeTitle)
                Text(reason)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 40)
        }
    }

    private var controls: some View {
        VStack {
            if camera.isRecording {
                RecordingTimer(camera: camera)
            }
            if camera.teleprompter.isCardShown, !camera.isRecording {
                TeleprompterCard(
                    camera: camera,
                    showsSettings: $showsTeleSettings,
                    onUseNote: { showsNotePicker = true }
                )
                .padding(.horizontal, 16)
                .padding(.top, 4)
            }
            Spacer()
        }
        // Fill the screen so the leading/bottom overlays anchor to its edges;
        // without this the stack hugs its content and the rail floats mid-screen.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .leading) { rail }
        .overlay(alignment: .bottom) { recordButton }
        .overlay(alignment: .bottomLeading) { thumbnailWell }
        .animation(.spring(duration: 0.45), value: media.recordings.first?.id)
        .animation(.spring(duration: 0.45), value: camera.isRecording)
        .padding(.top, 8)
    }

    /// The last recording, docked in the corner the way the system camera
    /// does it; tapping plays it.
    @ViewBuilder private var thumbnailWell: some View {
        if !camera.isRecording, let recording = media.recordings.first {
            Button {
                playingRecording = recording
            } label: {
                ZStack {
                    if let url = media.thumbnailURL(for: recording),
                       let image = UIImage(contentsOfFile: url.path()) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Rectangle().fill(.fill.secondary)
                        Image(systemName: "play.fill")
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 54, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.white.opacity(0.5), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.leading, 20)
            .padding(.bottom, 44)
            .id(recording.id)
            .transition(.scale(scale: 0.25, anchor: .bottomLeading).combined(with: .opacity))
            .accessibilityLabel("Play last recording")
        }
    }

    private var rail: some View {
        GlassEffectContainer {
            VStack(spacing: 16) {
                Button {
                    showsZoomPicker.toggle()
                    showsQualityPopover = false
                } label: {
                    Text(zoomLabel(camera.zoom))
                        .font(.footnote.weight(.bold))
                        .frame(width: 40, height: 40)
                }
                .glassEffect(.regular.interactive())
                .popover(isPresented: $showsZoomPicker, arrowEdge: .leading) {
                    zoomPicker.presentationCompactAdaptation(.popover)
                }

                Button {
                    camera.teleprompter.isCardShown.toggle()
                } label: {
                    Image(systemName: "text.viewfinder")
                        .frame(width: 40, height: 40)
                }
                .glassEffect(camera.teleprompter.isCardShown ? .regular.tint(.white.opacity(0.25)).interactive() : .regular.interactive())

                Spacer().frame(height: 10)

                Button {
                    camera.toggleTorch()
                } label: {
                    Image(systemName: camera.isTorchOn ? "bolt.fill" : "bolt.slash")
                        .foregroundStyle(camera.isTorchOn ? .yellow : .white)
                        .frame(width: 40, height: 40)
                }
                .glassEffect(.regular.interactive())
                .disabled(!camera.flashAvailable)
                .opacity(camera.flashAvailable ? 1 : 0.4)

                Button {
                    camera.flip()
                } label: {
                    Image(systemName: "arrow.trianglehead.2.clockwise.rotate.90.camera")
                        .frame(width: 40, height: 40)
                }
                .glassEffect(.regular.interactive())

                Button {
                    showsQualityPopover.toggle()
                    showsZoomPicker = false
                } label: {
                    VStack(spacing: 0) {
                        Text(camera.effectiveSettings.resolution.rawValue)
                        Text("\(camera.effectiveSettings.frameRate.rawValue)")
                    }
                    .font(.caption2.weight(.bold))
                    .frame(width: 40, height: 40)
                }
                .glassEffect(.regular.interactive())
                .popover(isPresented: $showsQualityPopover, arrowEdge: .leading) {
                    qualityPopover.presentationCompactAdaptation(.popover)
                }
                .disabled(camera.isRecording)
            }
            .foregroundStyle(.white)
        }
        .padding(.leading, 14)
    }

    private var zoomPicker: some View {
        VStack(spacing: 4) {
            ForEach(camera.zoomMapping.options.reversed(), id: \.self) { option in
                Button {
                    camera.select(zoom: option)
                    showsZoomPicker = false
                } label: {
                    Text(zoomLabel(option))
                        .font(.headline.weight(.bold))
                        .frame(width: 72, height: 44)
                        .background(
                            camera.zoom == option ? AnyShapeStyle(.white) : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 14)
                        )
                        .foregroundStyle(camera.zoom == option ? .black : .primary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
    }

    private var qualityPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Resolution")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Picker("Resolution", selection: resolutionBinding) {
                ForEach(CaptureResolution.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            Text("Frame Rate")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Picker("Frame Rate", selection: frameRateBinding) {
                ForEach(CaptureFrameRate.allCases, id: \.self) { Text("\($0.rawValue)").tag($0) }
            }
            .pickerStyle(.segmented)

            Text("Color")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Picker("Color", selection: colorBinding) {
                ForEach(CaptureColorMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
        }
        .padding(16)
        .frame(minWidth: 280)
    }

    private var resolutionBinding: Binding<CaptureResolution> {
        Binding(
            get: { camera.settings.resolution },
            set: { value in camera.update { $0.resolution = value } }
        )
    }

    private var frameRateBinding: Binding<CaptureFrameRate> {
        Binding(
            get: { camera.settings.frameRate },
            set: { value in camera.update { $0.frameRate = value } }
        )
    }

    private var colorBinding: Binding<CaptureColorMode> {
        Binding(
            get: { camera.settings.colorMode },
            set: { value in camera.update { $0.colorMode = value } }
        )
    }

    private var recordButton: some View {
        Button {
            camera.toggleRecording()
        } label: {
            ZStack {
                Circle()
                    .fill(.white)
                    .frame(width: 84, height: 84)
                RoundedRectangle(cornerRadius: camera.isRecording ? 9 : 34)
                    .fill(Color.recordPink)
                    .frame(
                        width: camera.isRecording ? 34 : 68,
                        height: camera.isRecording ? 34 : 68
                    )
            }
            .animation(.snappy(duration: 0.2), value: camera.isRecording)
        }
        .buttonStyle(.plain)
        .disabled(camera.availability != .running)
        .opacity(camera.availability == .running ? 1 : 0.5)
        .padding(.bottom, 30)
        .accessibilityLabel(camera.isRecording ? "Stop recording" : "Record")
    }
}

/// A bright frame around the preview: the screen fill light for cameras
/// without a torch.
struct FillLightOverlay: View {
    var body: some View {
        Rectangle()
            .strokeBorder(.white.opacity(0.95), lineWidth: 64)
            .blur(radius: 22)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}

struct RecordingTimer: View {
    var camera: CameraModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            if let startedAt = camera.recordingStartedAt {
                Text(formattedDuration(context.date.timeIntervalSince(startedAt)))
                    .font(.footnote.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(Color.recordPink.opacity(0.9), in: Capsule())
            }
        }
    }
}

struct TeleprompterCard: View {
    @Bindable var camera: CameraModel
    @Binding var showsSettings: Bool
    let onUseNote: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Spacer()
                Button {
                    camera.teleprompter.isCardShown = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.bold))
                }
            }
            TextEditor(text: $camera.teleprompter.script)
                .font(.system(size: 19, weight: .semibold))
                .scrollContentBackground(.hidden)
                .frame(minHeight: 96, maxHeight: 160)
                .overlay(alignment: .topLeading) {
                    if camera.teleprompter.script.isEmpty {
                        Text("Add your script here...")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
            HStack(spacing: 14) {
                Button {
                    showsSettings.toggle()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .popover(isPresented: $showsSettings, arrowEdge: .top) {
                    TeleprompterSettingsView(camera: camera)
                        .presentationCompactAdaptation(.popover)
                }
                Button(action: onUseNote) {
                    Image(systemName: "note.text")
                }
                Spacer()
            }
            .font(.body.weight(.semibold))
        }
        .foregroundStyle(.white)
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct TeleprompterSettingsView: View {
    @Bindable var camera: CameraModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Reading speed · \(Int(camera.teleprompter.settings.wordsPerMinute)) wpm")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Slider(value: $camera.teleprompter.settings.wordsPerMinute, in: TeleprompterSettings.speedRange)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Text size")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Slider(value: $camera.teleprompter.settings.textSize, in: TeleprompterSettings.textSizeRange)
            }
        }
        .padding(16)
        .frame(minWidth: 260)
    }
}

struct TeleprompterOverlay: View {
    var camera: CameraModel

    /// Rendered height of the paced script, measured off the Text itself so
    /// the scroll rate can pace the exact copy on screen.
    @State private var textHeight: Double = 0

    var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height * 0.42
            TimelineView(.animation) { context in
                let elapsed = camera.recordingStartedAt.map { context.date.timeIntervalSince($0) } ?? 0
                Text(camera.teleprompter.displayScript)
                    .font(.system(size: camera.teleprompter.settings.textSize, weight: .heavy))
                    .foregroundStyle(.white)
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: Double.self, of: { $0.size.height }) { textHeight = $0 }
                    .offset(
                        y: camera.teleprompter.scrollOffset(
                            elapsed: elapsed,
                            overlayHeight: height,
                            textHeight: textHeight
                        )
                    )
                    .padding(.horizontal, 24)
            }
            .frame(height: height, alignment: .top)
            .clipped()
            .background(
                LinearGradient(
                    colors: [.black.opacity(0.75), .black.opacity(0)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: height),
                alignment: .top
            )
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

struct NotePickerSheet: View {
    var ideas: IdeasModel
    let onPick: (Note) -> Void

    private let columns = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)]

    var body: some View {
        NavigationStack {
            Group {
                if ideas.notes.isEmpty {
                    Text("No notes yet. Write one in Ideas first.")
                        .foregroundStyle(.secondary)
                        .padding(24)
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(ideas.notes) { note in
                                Button {
                                    onPick(note)
                                } label: {
                                    NoteCard(note: note)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(20)
                    }
                }
            }
            .navigationTitle("Use a note")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}
#endif
