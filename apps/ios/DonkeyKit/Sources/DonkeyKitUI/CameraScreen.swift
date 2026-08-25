#if os(iOS)
import SwiftUI
import UIKit
import DonkeyKitModels

/// The clip parked in the corner after a take: the poster the flight
/// animation carries down, and the recording the well opens.
private struct CornerClip: Identifiable {
    var recording: Recording
    var poster: UIImage?

    var id: UUID { recording.id }
}

struct CameraScreen<CameraPreview: View>: View {
    var app: AppModel
    @Bindable var camera: CameraModel
    var ideas: IdeasModel
    var media: MediaModel
    let cameraPreview: () -> CameraPreview

    @State private var showsZoomPicker = false
    @State private var showsQualityPopover = false
    @State private var showsTeleSettings = false
    @State private var showsNotePicker = false
    @State private var playingRecording: Recording?
    /// The take that just finished, docked in the corner until it is watched
    /// or `Self.wellLifetime` passes.
    @State private var corner: CornerClip?
    /// True while the poster is still flying from the stage into the well.
    @State private var isFlying = false
    /// The well's rectangle in stage coordinates — the flight's landing spot.
    @State private var wellFrame: CGRect = .zero
    /// True while a tap is holding the chrome on a stage that would otherwise
    /// be clear. It stays until the next tap: a hand working the controls is
    /// never raced by a clock.
    @State private var showsChrome = false

    private static var stageSpace: String { "cameraStage" }
    private static var wellSide: CGFloat { 54 }
    private static var wellLifetime: Duration { .seconds(30) }

    /// Whether the screen belongs to the picture alone.
    ///
    /// Reading a script is the same job whether or not the camera is rolling,
    /// so a rehearsal looks exactly like a take: the buttons go, the words and
    /// the picture stay.
    private var stageIsClear: Bool { camera.isRecording || camera.teleprompter.isRunning }

    /// Whether the controls are on screen at all.
    private var chromeShown: Bool { !stageIsClear || showsChrome }

    var body: some View {
        ZStack {
            stage
            if camera.isFillLightOn, camera.availability == .running {
                FillLightOverlay()
            }
            // Play hands the screen to the prompter, recording or not: the
            // script runs on a loop so the speed and size a person just set
            // are something they can watch before the take.
            if camera.teleprompter.hasScript, camera.teleprompter.isRunning {
                TeleprompterOverlay(camera: camera, onTap: toggleChrome)
            }
            controls
            if isFlying, let poster = corner?.poster, wellFrame != .zero {
                CaptureFlight(poster: poster, landing: wellFrame, corner: 10) {
                    isFlying = false
                }
            }
        }
        .coordinateSpace(.named(Self.stageSpace))
        // The tabs are chrome too: a run gets the whole screen, and they come
        // back with everything else.
        .toolbar(chromeShown ? .visible : .hidden, for: .tabBar)
        // A tap on the picture works the chrome. The words take their own taps
        // and hand them here; a control takes its own and keeps the chrome up.
        .contentShape(Rectangle())
        .onTapGesture { toggleChrome() }
        .background(.black, ignoresSafeAreaEdges: .all)
        // The stage is live video: the chrome is dark whatever the app-wide
        // appearance says. Setting the environment (not a color-scheme
        // preference) keeps the root appearance choice from overriding it.
        .environment(\.colorScheme, .dark)
        .onChange(of: media.recordings.first?.id) { _, _ in dockLatestTake() }
        // A run begins on a clear stage, and the controls are back the moment
        // it ends.
        .onChange(of: stageIsClear) { _, _ in showsChrome = false }
        // The docked clip keeps itself to one appearance: watching it or
        // waiting out the timer both retire it.
        .task(id: corner?.id) {
            guard corner != nil else { return }
            try? await Task.sleep(for: Self.wellLifetime)
            guard !Task.isCancelled else { return }
            corner = nil
        }
        .sheet(isPresented: $showsNotePicker) {
            NotePickerSheet(ideas: ideas) { note in
                camera.loadTeleprompter(script: note.script)
                showsNotePicker = false
            }
        }
        .fullScreenCover(item: $playingRecording, onDismiss: { corner = nil }) { recording in
            RecordingPlayerView(url: media.movieURL(for: recording)) {
                playingRecording = nil
                app.selectedTab = .media
            }
        }
    }

    private func dockLatestTake() {
        // The head of the list also changes when a clip is deleted over in the
        // Library; only a take that just finished gets docked.
        guard let recording = media.recordings.first,
              recording.createdAt.timeIntervalSinceNow > -5 else { return }
        let poster = media.thumbnailURL(for: recording)
            .flatMap { UIImage(contentsOfFile: $0.localPath) }
        corner = CornerClip(recording: recording, poster: poster)
        isFlying = poster != nil && wellFrame != .zero
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
        .animation(.spring(duration: 0.45), value: corner?.id)
        .animation(.spring(duration: 0.45), value: camera.isRecording)
        .padding(.top, 8)
        // A clear stage keeps its controls laid out and invisible: they fade
        // in place, so a tap brings them back exactly where the hand left
        // them, and while they are gone the picture underneath takes every
        // touch.
        .opacity(chromeShown ? 1 : 0)
        .allowsHitTesting(chromeShown)
        .animation(.spring(duration: 0.3), value: chromeShown)
    }

    /// A tap on a clear stage works the controls: one brings them back —
    /// enough to stop the take, light the room, or turn the camera round —
    /// and the next puts them away, on the tap and not a moment later.
    private func toggleChrome() {
        guard stageIsClear else { return }
        showsChrome.toggle()
    }

    /// Where the take lands. The slot holds its place whether or not a clip
    /// is docked, so the flight always has a measured rectangle to fly to.
    private var thumbnailWell: some View {
        Color.clear
            .frame(width: Self.wellSide, height: Self.wellSide)
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(Self.stageSpace))
            } action: { wellFrame = $0 }
            .overlay {
                if let corner, !camera.isRecording, !isFlying {
                    wellButton(corner)
                }
            }
            .padding(.leading, 20)
            .padding(.bottom, 44)
    }

    private func wellButton(_ clip: CornerClip) -> some View {
        Button {
            playingRecording = clip.recording
        } label: {
            ZStack {
                if let poster = clip.poster {
                    Image(uiImage: poster)
                        .resizable()
                        .scaledToFill()
                } else {
                    Rectangle().fill(.fill.secondary)
                    Image(systemName: "play.fill")
                        .foregroundStyle(.white)
                }
            }
            .frame(width: Self.wellSide, height: Self.wellSide)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.white.opacity(0.5), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .id(clip.id)
        .transition(.scale(scale: 0.25, anchor: .bottomLeading).combined(with: .opacity))
        .accessibilityLabel("Play last recording")
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
                    if camera.isRecording {
                        // Mid-take the card stays away, so the button is the
                        // script's own switch: it leaves the picture and comes
                        // back where the pacing has reached, and the take never
                        // pauses for either.
                        camera.teleprompter.isRunning.toggle()
                    } else if camera.teleprompter.isCardShown {
                        camera.dismissTeleprompter()
                    } else {
                        // A running script comes back to the card to be
                        // edited; the picture is clear while it is open.
                        camera.teleprompter.isRunning = false
                        camera.teleprompter.isCardShown = true
                    }
                } label: {
                    Image(systemName: "text.viewfinder")
                        .frame(width: 40, height: 40)
                }
                .glassEffect(camera.teleprompter.isCardShown || camera.teleprompter.isRunning ? .regular.tint(.white.opacity(0.25)).interactive() : .regular.interactive())

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
                            camera.zoom == option ? AnyShapeStyle(.primary) : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 14)
                        )
                        .foregroundStyle(camera.zoom == option ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
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

/// The take shrinking from the stage into the corner well, the way a
/// screenshot drops to the bottom of the screen.
private struct CaptureFlight: View {
    let poster: UIImage
    let landing: CGRect
    let corner: CGFloat
    let onLanded: () -> Void

    @State private var landed = false

    var body: some View {
        GeometryReader { proxy in
            let frame = landed ? landing : CGRect(origin: .zero, size: proxy.size)
            Image(uiImage: poster)
                .resizable()
                .scaledToFill()
                .frame(width: frame.width, height: frame.height)
                .clipShape(RoundedRectangle(cornerRadius: landed ? corner : 0, style: .continuous))
                .position(x: frame.midX, y: frame.midY)
        }
        .allowsHitTesting(false)
        .task {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.72)) { landed = true }
            try? await Task.sleep(for: .milliseconds(620))
            onLanded()
        }
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
            // The card's controls ride the top row: the camera rail runs up the
            // leading edge and would sit on top of anything in the low corner.
            HStack(spacing: 14) {
                Button {
                    showsSettings.toggle()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                // The card rides the top of the screen, so the sliders drop
                // below the button; upward they run off under the status bar.
                .popover(isPresented: $showsSettings, arrowEdge: .top) {
                    TeleprompterSettingsView(camera: camera)
                        .presentationCompactAdaptation(.popover)
                        // The popover's own chrome follows the phone's
                        // appearance, so in light mode it drew a pale panel
                        // under the camera chrome's white type. It carries the
                        // stage's dark instead.
                        .presentationBackground(Color.black.opacity(0.78))
                }
                Button(action: onUseNote) {
                    Image(systemName: "note.text")
                }
                // A run of the script at the current pace, without spending a
                // take on finding out whether it reads right.
                Button {
                    camera.startTeleprompter()
                } label: {
                    Image(systemName: "play.fill")
                }
                .disabled(!camera.teleprompter.hasScript)
                Spacer()
                Button {
                    camera.dismissTeleprompter()
                } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.bold))
                }
            }
            .font(.body.weight(.semibold))
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
    /// What a tap on the words does. The script covers most of the screen, so
    /// it answers for the picture underneath it.
    var onTap: () -> Void

    /// Rendered height of the paced script, measured off the Text itself so
    /// the scroll rate can pace the exact copy on screen.
    @State private var textHeight: Double = 0
    /// How far the reader has dragged the script from where the pacing puts
    /// it. It rides along with the scroll rather than replacing it, so a nudge
    /// mid-take moves the words and the pace carries on.
    @State private var dragged: Double = 0
    @GestureState private var dragging: Double = 0
    /// Breathing room between one pass of the script and the next, as a share
    /// of the prompter's height.
    private static var gapShare: Double { 0.3 }
    /// Room kept at the foot of the screen, clear of the home indicator. The
    /// script only ever runs on a clear stage, so it takes the screen; the
    /// controls a tap brings back float over the words for their few seconds.
    private static var footRoom: Double { 40 }
    /// Margin each side of the script.
    private static var sidePadding: Double { 24 }

    /// The script broken to the width it is drawn in, measured on the very
    /// face and size it will be drawn in. A line holds as many words as the
    /// picture has room for, so a short clause reads on one line with what
    /// follows it. The last point of the width is left to the layout, so a
    /// line measured here as fitting is never broken again as it draws.
    private func script(room: Double) -> String {
        let font = UIFont.systemFont(
            ofSize: camera.teleprompter.settings.textSize,
            weight: .heavy
        )
        return camera.teleprompter.displayScript(room: room - 1) { line in
            (line as NSString).size(withAttributes: [.font: font]).width
        }
    }

    private func scriptText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: camera.teleprompter.settings.textSize, weight: .heavy))
            .foregroundStyle(.white)
            .lineSpacing(4)
            .shadow(color: .black.opacity(0.7), radius: 6, y: 1)
            // The window the script scrolls through is a fraction of the
            // screen, and a Text offered that height lays out only what fits
            // and ends the last line in an ellipsis. The script is laid out
            // whole and scrolled past the window.
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        GeometryReader { geometry in
            // The script gets the screen, stopping short of the controls.
            let height = max(geometry.size.height - Self.footRoom, 0)
            let gap = height * Self.gapShare
            let lines = script(room: geometry.size.width - Self.sidePadding * 2)
            TimelineView(.animation) { context in
                let elapsed = elapsed(at: context.date)
                // Two passes, one behind the other: the script runs without
                // ever leaving the screen empty, in a take as in a preview.
                VStack(alignment: .leading, spacing: gap) {
                    scriptText(lines)
                        .onGeometryChange(for: Double.self, of: { $0.size.height }) { textHeight = $0 }
                    scriptText(lines)
                }
                .offset(
                    y: camera.teleprompter.scrollOffset(
                        elapsed: elapsed,
                        overlayHeight: height,
                        textHeight: textHeight,
                        gap: gap
                    ) + dragged + dragging
                )
                .padding(.horizontal, Self.sidePadding)
            }
            .frame(height: height, alignment: .top)
            .clipped()
            .background(
                // A scrim over the top of the frame, where the status bar and
                // the brightest part of most rooms are. Past it the script
                // carries its own shadow and the picture stays the picture.
                LinearGradient(
                    colors: [.black.opacity(0.6), .black.opacity(0)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: height * 0.35),
                alignment: .top
            )
            // The reader places the words: a drag anywhere over the picture
            // moves the script. The rail and the record button sit above this
            // in the stack, so they still take their own touches.
            .contentShape(Rectangle())
            .onTapGesture { onTap() }
            .gesture(
                DragGesture(minimumDistance: 6)
                    .updating($dragging) { value, state, _ in state = value.translation.height }
                    .onEnded { dragged += $0.translation.height }
            )
        }
        .ignoresSafeArea()
        // A fresh run puts the script back where the pacing wants it.
        .onChange(of: camera.teleprompter.runStartedAt) { dragged = 0 }
    }

    /// Seconds into the script, counted from the press of play — or from the
    /// top of a take that began while the prompter was up. The loop itself
    /// lives in the offset.
    private func elapsed(at now: Date) -> TimeInterval {
        guard let startedAt = camera.teleprompter.runStartedAt else { return 0 }
        return now.timeIntervalSince(startedAt)
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
