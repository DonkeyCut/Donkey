import SwiftUI

struct RecordingWindowSizeView: View {
    @ObservedObject var model: RecordingControlBarModel
    @State private var width = ""
    @State private var height = ""

    private struct Preset: Identifiable {
        let id: String
        let width: Int
        let height: Int
    }

    private static let presets = [
        Preset(id: "9:16 · Portrait", width: 540, height: 960),
        Preset(id: "3:4 · Portrait with sidebar", width: 720, height: 960),
        Preset(id: "1:1 · Square", width: 800, height: 800),
        Preset(id: "4:3 · Landscape", width: 960, height: 720),
        Preset(id: "16:9 · Widescreen", width: 1280, height: 720)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Window size").font(.headline)
            Text("Dimensions include the title bar and use screen points. Retina recordings have more pixels.")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(Self.presets) { preset in
                Button {
                    width = String(preset.width)
                    height = String(preset.height)
                    model.onResizeWindow?(preset.width, preset.height)
                } label: {
                    HStack {
                        Text(preset.id)
                        Spacer()
                        Text("\(preset.width) × \(preset.height)").monospacedDigit()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.isBusy)
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                dimensionField("Width", text: $width)
                dimensionField("Height", text: $height)
                Button("Apply") { applyCustomSize() }
                    .disabled(model.isBusy || customSize == nil)
            }
            if let width = model.windowWidth, let height = model.windowHeight {
                Text("Current: \(width) × \(height) pt")
                    .font(.caption.monospacedDigit())
            }
            if model.isBusy {
                ProgressView().controlSize(.small)
            }
            if let message = model.statusMessage {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 340)
        .onAppear {
            width = model.windowWidth.map(String.init) ?? "720"
            height = model.windowHeight.map(String.init) ?? "960"
        }
    }

    private var customSize: (Int, Int)? {
        guard let width = Int(width), let height = Int(height), width > 0, height > 0 else { return nil }
        return (width, height)
    }

    private func dimensionField(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(label, text: text)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Window \(label.lowercased()) in points")
                .onSubmit { applyCustomSize() }
                .disabled(model.isBusy)
        }
    }

    private func applyCustomSize() {
        guard !model.isBusy, let (width, height) = customSize else { return }
        model.onResizeWindow?(width, height)
    }
}
