import SwiftUI

struct FilterForm: Decodable {
    struct Field: Decodable, Identifiable {
        struct Option: Decodable, Identifiable {
            let id: String
            let title: String
        }
        let key: String
        let label: String
        let multiple: Bool
        let options: [Option]
        let selected: [String]
        let reset: [String]
        var id: String { key }
    }

    let text: String
    let searchLabel: String
    let fields: [Field]
    var values: [String: [String]] { Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.selected) }) }
}

struct FilterSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var form: FilterForm
    @State private var text: String
    @State private var busy = false
    @State private var failed = false
    private let update: ([String: [String]], String, Bool) async throws -> FilterForm

    init(form: FilterForm, update: @escaping ([String: [String]], String, Bool) async throws -> FilterForm) {
        _form = State(initialValue: form)
        _text = State(initialValue: form.text)
        self.update = update
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(form.searchLabel, text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                }
                Section {
                    ForEach(form.fields) { field in
                        NavigationLink(value: field.key) {
                            LabeledContent(field.label, value: summary(field))
                        }
                    }
                }
                Button("Clear filters", systemImage: "xmark.circle") {
                    text = ""
                    submit(Dictionary(uniqueKeysWithValues: form.fields.map { ($0.key, $0.reset) }))
                }
                .disabled(busy || (text.isEmpty && !form.fields.contains { $0.selected != $0.reset }))
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply filters", systemImage: "checkmark") { submit(form.values, apply: true) }
                        .disabled(busy)
                }
            }
            .navigationDestination(for: String.self) { key in
                if let field = form.fields.first(where: { $0.key == key }) {
                    List(field.options) { option in
                        let selected = field.selected.contains(option.id)
                        Button {
                            var values = form.values
                            if field.multiple {
                                values[key] = selected ? field.selected.filter { $0 != option.id } : field.selected + [option.id]
                            } else {
                                values[key] = [option.id]
                            }
                            submit(values)
                        } label: {
                            HStack {
                                Text(option.title)
                                Spacer()
                                if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
                            }
                            .contentShape(Rectangle())
                        }
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                    .disabled(busy)
                    .navigationTitle(field.label)
                    .navigationBarTitleDisplayMode(.inline)
                    .overlay {
                        if field.options.isEmpty { ContentUnavailableView("No choices available", systemImage: "line.3.horizontal.decrease") }
                    }
                }
            }
            .alert("Couldn’t update filters", isPresented: $failed) {
                Button("OK") {}
            } message: {
                Text("Return to the list and open Filters again.")
            }
        }
    }

    private func summary(_ field: FilterForm.Field) -> String {
        if field.selected.count == 1, let id = field.selected.first {
            return field.options.first { $0.id == id }?.title ?? id
        }
        return field.selected.isEmpty ? "Any" : "\(field.selected.count) selected"
    }

    private func submit(_ values: [String: [String]], apply: Bool = false) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                form = try await update(values, text, apply)
                if apply { dismiss() }
            } catch {
                failed = true
            }
        }
    }
}
