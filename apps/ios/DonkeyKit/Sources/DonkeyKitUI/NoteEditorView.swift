#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct NoteEditorView: View {
    @Bindable var app: AppModel
    @Bindable var ideas: IdeasModel
    let onRecordNote: (Note) -> Void

    @FocusState private var bodyFocused: Bool

    var body: some View {
        let color = ideas.draft?.color ?? .butter
        VStack(spacing: 0) {
            HStack {
                Button {
                    ideas.closeEditor()
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3.weight(.bold))
                }
                Spacer()
                Button {
                    ideas.cycleDraftColor()
                } label: {
                    Circle()
                        .fill(color.accentColor)
                        .strokeBorder(Color.notePaperInk.opacity(0.75), lineWidth: 3)
                        .frame(width: 28, height: 28)
                }
                .accessibilityLabel("Note color")
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)

            TextField("Untitled", text: titleBinding)
                .font(.system(size: 32, weight: .bold))
                .padding(.horizontal, 22)
                .padding(.top, 12)

            TextEditor(text: bodyBinding)
                .font(.system(size: 20, weight: .medium))
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 18)
                .focused($bodyFocused)
                .overlay(alignment: .topLeading) {
                    if (ideas.draft?.body ?? "").isEmpty {
                        Text("Write down an idea...")
                            .font(.system(size: 20, weight: .medium))
                            .opacity(0.4)
                            .padding(.horizontal, 23)
                            .padding(.top, 8)
                            .allowsHitTesting(false)
                    }
                }

            HStack {
                Button {
                    guard let note = ideas.saveDraft() else { return }
                    onRecordNote(note)
                } label: {
                    Label("Record", systemImage: "record.circle")
                        .font(.body.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: 14))
                .disabled(!(ideas.draft?.hasContent ?? false))

                Spacer()

                Button {
                    let wasNew = ideas.draft?.isNew ?? true
                    guard ideas.saveDraft() != nil else { return }
                    app.show(toast: wasNew ? "Note saved" : "Note updated")
                } label: {
                    Text("Save")
                        .font(.body.weight(.bold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 14))
                .disabled(!(ideas.draft?.hasContent ?? false))
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .foregroundStyle(Color.notePaperInk)
        .tint(Color.notePaperInk)
        .background(color.backgroundColor, ignoresSafeAreaEdges: .all)
        .task { bodyFocused = true }
        .animation(.easeInOut(duration: 0.2), value: color)
    }

    private var titleBinding: Binding<String> {
        Binding(
            get: { ideas.draft?.title ?? "" },
            set: { ideas.draft?.title = $0 }
        )
    }

    private var bodyBinding: Binding<String> {
        Binding(
            get: { ideas.draft?.body ?? "" },
            set: { ideas.draft?.body = $0 }
        )
    }
}
#endif
