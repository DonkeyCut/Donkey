#if os(iOS)
import SwiftUI
import DonkeyKitModels

struct NoteEditorView: View {
    @Bindable var app: AppModel
    @Bindable var ideas: IdeasModel
    let onRecordNote: (Note) -> Void

    private enum Field { case title, body }

    @FocusState private var focused: Field?
    @State private var showingLabels = false

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

            // The labels the note wears. A tap on a chip takes it off; the
            // tag button opens the picker that adds, makes, renames and
            // deletes them.
            if let draft = ideas.draft, !draft.labelIds.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(ideas.labels.filter { draft.labelIds.contains($0.id) }) { label in
                            Button {
                                ideas.toggleDraftLabel(label.id)
                            } label: {
                                HStack(spacing: 4) {
                                    Text(label.name)
                                    Image(systemName: "xmark")
                                        .font(.system(size: 9, weight: .bold))
                                        .opacity(0.5)
                                }
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Color.black.opacity(0.1), in: Capsule())
                            }
                            .accessibilityLabel("Remove label \(label.name)")
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .padding(.top, 8)
            }

            HStack(spacing: 18) {
                Button {
                    ideas.cycleDraftColor()
                } label: {
                    Circle()
                        .fill(color.accentColor)
                        .strokeBorder(Color.notePaperInk.opacity(0.75), lineWidth: 3)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Note color")
                Button {
                    showingLabels = true
                } label: {
                    Image(systemName: "tag")
                        .font(.title3.weight(.semibold))
                }
                .accessibilityLabel("Labels")
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .sheet(isPresented: $showingLabels) {
            NoteLabelSheet(ideas: ideas)
                .presentationDetents([.medium, .large])
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

/// The label picker: every label on the account, the open note's checked. A
/// tap puts one on the note or takes it off; the field at the top makes a new
/// one and puts it on; a swipe renames or deletes one everywhere.
private struct NoteLabelSheet: View {
    @Bindable var ideas: IdeasModel
    @Environment(\.dismiss) private var dismiss

    @State private var newName = ""
    @State private var renaming: NoteLabel?
    @State private var renameText = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("New label", text: $newName)
                        .submitLabel(.done)
                        .onSubmit(create)
                }
                if !ideas.labels.isEmpty {
                    Section {
                        ForEach(ideas.labels) { label in
                            let worn = ideas.draft?.labelIds.contains(label.id) == true
                            Button {
                                ideas.toggleDraftLabel(label.id)
                            } label: {
                                HStack {
                                    Text(label.name)
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if worn {
                                        Image(systemName: "checkmark")
                                            .font(.body.weight(.semibold))
                                    }
                                }
                            }
                            .disabled(!worn && !ideas.draftTakesLabels)
                            .swipeActions {
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    ideas.deleteLabel(id: label.id)
                                }
                                Button("Rename", systemImage: "pencil") {
                                    renameText = label.name
                                    renaming = label
                                }
                            }
                        }
                    } footer: {
                        Text(
                            ideas.draftTakesLabels
                                ? "Deleting a label takes it off every note."
                                : "A note holds \(IdeasModel.maxLabelsPerNote) labels. Take one off to add another."
                        )
                    }
                }
            }
            .navigationTitle("Labels")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Rename Label", isPresented: renamingShown, presenting: renaming) { label in
                TextField("Name", text: $renameText)
                Button("Save") { ideas.renameLabel(id: label.id, to: renameText) }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var renamingShown: Binding<Bool> {
        Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )
    }

    private func create() {
        guard ideas.draftTakesLabels, let label = ideas.addLabel(named: newName) else { return }
        ideas.toggleDraftLabel(label.id)
        newName = ""
    }
}
#endif
