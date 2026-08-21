#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct NoteEditorView: View {
    @Bindable var app: AppModel
    @Bindable var ideas: IdeasModel
    let onRecordNote: (Note) -> Void

    private enum Field { case title, body }

    @FocusState private var focused: Field?

    var body: some View {
        let color = ideas.draft?.color ?? .butter
        let hasContent = ideas.draft?.hasContent ?? false
        VStack(spacing: 0) {
            // Close on the left, and on the right the two things a finished
            // note is for: reading it to camera, and putting it away.
            HStack(spacing: 18) {
                Button {
                    ideas.closeEditor()
                } label: {
                    Image(systemName: "xmark")
                        .font(.title3.weight(.bold))
                }
                .accessibilityLabel("Close")

                Spacer()

                Button {
                    guard let note = ideas.saveDraft() else { return }
                    onRecordNote(note)
                } label: {
                    Image(systemName: "play.circle.fill")
                        .font(.title2.weight(.bold))
                }
                .disabled(!hasContent)
                .accessibilityLabel("Read on camera")

                Button {
                    // The keyboard goes first when it is up, so Done reads the
                    // note before it closes it — the way Notes behaves.
                    if focused != nil {
                        focused = nil
                        return
                    }
                    let wasNew = ideas.draft?.isNew ?? true
                    guard ideas.saveDraft() != nil else {
                        ideas.closeEditor()
                        return
                    }
                    app.show(toast: wasNew ? "Note saved" : "Note updated")
                } label: {
                    Image(systemName: "checkmark")
                        .font(.title3.weight(.bold))
                }
                .accessibilityLabel("Done")
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)

            TextField("Untitled", text: titleBinding)
                .font(.system(size: 32, weight: .bold))
                .padding(.horizontal, 22)
                .padding(.top, 12)
                .focused($focused, equals: .title)
                .submitLabel(.next)
                .onSubmit { focused = .body }

            TextEditor(text: bodyBinding)
                .font(.system(size: 20, weight: .medium))
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .padding(.horizontal, 18)
                .focused($focused, equals: .body)
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
                    ideas.cycleDraftColor()
                } label: {
                    Circle()
                        .fill(color.accentColor)
                        .strokeBorder(Color.notePaperInk.opacity(0.75), lineWidth: 3)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Note color")
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .foregroundStyle(Color.notePaperInk)
        .tint(Color.notePaperInk)
        .background(color.backgroundColor, ignoresSafeAreaEdges: .all)
        .toolbar {
            // Opening a note is reading it as often as writing it, so the
            // keyboard comes and goes on the writer's word.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = nil }
                    .font(.body.weight(.bold))
            }
        }
        .task { if ideas.draft?.isNew == true { focused = .body } }
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
