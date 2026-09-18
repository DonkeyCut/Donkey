#if os(iOS)
import DonkeyKitModels
import SwiftUI

/// Pairing this phone with a Mac, and what the link is doing once it is paired.
///
/// The Mac mints the code — Donkey Cut's settings, under Super user — and this
/// screen is where it gets typed. After that the phone sends every take it
/// shoots to that Mac whenever one is in range, and this screen is only there
/// to show which Mac and to break the pairing.
struct MacLinkSheet: View {
    var link: PhoneLinkModel
    var media: MediaModel
    /// Whether the browse stays on once this sheet closes — the camera screen
    /// wants it, and nothing else does.
    var onDismiss: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedMac: String?
    @State private var code = ""
    @State private var pairing = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let paired = link.pairing {
                    pairedSection(paired)
                } else {
                    pairingSection
                }
            }
            .navigationTitle("Mac Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            link.startBrowsing()
        }
        .onDisappear {
            // The camera screen holds its own browse while a shoot is on; this
            // one only held it for the picker, and a browse nobody is watching
            // is AWDL running for a screen that is gone.
            onDismiss()
        }
    }

    @ViewBuilder
    private func pairedSection(_ paired: PhoneLinkPairing) -> some View {
        Section {
            LabeledContent("Mac", value: paired.macName)
            LabeledContent("In range", value: inRange ? "Yes" : "No")
            LabeledContent("Waiting", value: "\(undelivered) \(undelivered == 1 ? "clip" : "clips")")
        } header: {
            Text("Paired")
        } footer: {
            Text("Clips go to this Mac over Wi-Fi Direct whenever it is nearby, with or without a network. They still upload to the cloud separately once there is internet.")
        }

        Section {
            Button("Send waiting clips now") {
                Task { await link.drain(media) }
            }
            .disabled(!inRange || undelivered == 0)
            Button("Unpair", role: .destructive) {
                link.unpair()
            }
        }
    }

    @ViewBuilder
    private var pairingSection: some View {
        Section {
            if link.macs.isEmpty {
                HStack {
                    ProgressView()
                    Text("Looking for Macs…").foregroundStyle(.secondary)
                }
            }
            ForEach(link.macs) { mac in
                Button {
                    selectedMac = mac.id
                    codeFocused = true
                } label: {
                    HStack {
                        Label(mac.name, systemImage: "laptopcomputer")
                        Spacer()
                        if selectedMac == mac.id {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .tint(.primary)
            }
        } header: {
            Text("Macs nearby")
        } footer: {
            Text("Both devices need Wi-Fi and Bluetooth on. They do not need to be on a network.")
        }

        Section {
            TextField("000-000", text: $code)
                .keyboardType(.numbersAndPunctuation)
                .textContentType(.oneTimeCode)
                .focused($codeFocused)
            Button(pairing ? "Pairing…" : "Pair") {
                guard let selectedMac else { return }
                pairing = true
                Task {
                    await link.pair(with: selectedMac, code: code)
                    pairing = false
                    if link.pairing != nil { code = "" }
                }
            }
            .disabled(selectedMac == nil || code.count < 6 || pairing)
        } header: {
            Text("Pairing code")
        } footer: {
            if let error = link.lastError {
                Text(error).foregroundStyle(.red)
            } else {
                Text("On the Mac, open Donkey Cut settings → Profile → Super user → Phone link, and start pairing.")
            }
        }
    }

    private var inRange: Bool {
        guard let paired = link.pairing else { return false }
        return link.macs.contains { $0.id == paired.macName }
    }

    private var undelivered: Int {
        media.recordings.count { !link.wasDelivered($0.id) }
    }
}
#endif
