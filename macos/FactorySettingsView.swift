import AppKit
import SwiftUI

struct FactorySettingsView: View {
    @ObservedObject var model: FactoryModel
    @State private var page = "automation"
    @State private var selectedProject = 0
    @State private var modelTarget = "fable"
    @State private var rawJSON = ""
    @State private var preserveAdvancedText = false
    private let pages = [
        (id: "run", title: "Run now", icon: "play.circle", subtitle: "Start a ticket and see what the factory is doing."),
        (id: "automation", title: "Automation", icon: "clock.arrow.circlepath", subtitle: "Decide when the factory starts work and how it uses your allowance."),
        (id: "models", title: "Models", icon: "cpu", subtitle: "Rank your models, set difficulty limits, and choose which may run automatically."),
        (id: "projects", title: "Projects", icon: "folder", subtitle: "Choose the repositories and ticket queues the factory can use."),
        (id: "discovery", title: "Discovery", icon: "magnifyingglass", subtitle: "Define how the factory finds work when the ready queue is empty."),
        (id: "advanced", title: "Advanced", icon: "slider.horizontal.3", subtitle: "Edit the complete configuration or inspect the factory log."),
    ]

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Label { Text("T3 Factory").font(.headline) } icon: { Image(nsImage: FactoryIcon.image) }.padding(20)
                List(selection: $page) {
                    navigationRow(0)
                    Section("Settings") {
                        ForEach(1..<pages.count, id: \.self) { navigationRow($0) }
                    }
                }.listStyle(.sidebar)
            }.frame(width: 180).background(.regularMaterial)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                let current = pages.first { $0.id == page } ?? pages[1]
                VStack(alignment: .leading, spacing: 5) {
                    Text(current.title).font(.title2.weight(.semibold))
                    Text(current.subtitle).font(.callout).foregroundStyle(.secondary)
                }.padding(24)
                Group {
                    switch page {
                    case "run": FactoryMenuView(model: model, compact: false)
                    case "models": models
                    case "projects": projects
                    case "discovery": discovery
                    case "advanced": advanced
                    default: automation
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                if page != "run" || hasChanges {
                    Divider()
                    saveBar
                }
            }.background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(minWidth: 860, minHeight: 650)
        .textFieldStyle(.roundedBorder)
        .disabled(model.busy != nil)
        .onChange(of: page) { old, new in
            if old == "advanced" {
                guard let data = rawJSON.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    model.error = "Fix the JSON or revert your changes before leaving Advanced."
                    preserveAdvancedText = true; page = "advanced"; return
                }
                model.draft = parsed
            }
            if new == "advanced" {
                if preserveAdvancedText { preserveAdvancedText = false }
                else { rawJSON = prettyJSON(model.draft) }
            }
        }
    }

    private func navigationRow(_ index: Int) -> some View {
        Label(pages[index].title, systemImage: pages[index].icon).padding(.vertical, 5).tag(pages[index].id)
    }
    private var hasChanges: Bool {
        page == "advanced" ? rawJSON != prettyJSON(model.config) : prettyJSON(model.draft) != prettyJSON(model.config)
    }
    private var saveBar: some View {
        HStack(spacing: 12) {
            if let busy = model.busy { ProgressView().controlSize(.small); Text(busy).font(.caption) }
            else if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(3).textSelection(.enabled) }
            else { Text(hasChanges ? "Unsaved changes across settings" : "All changes saved").font(.caption).foregroundStyle(.secondary) }
            Spacer()
            Button(model.error == nil ? "Revert" : "Reload") {
                Task { await model.reload(); rawJSON = prettyJSON(model.draft) }
            }.disabled(!hasChanges && model.error == nil)
            Button("Save changes") {
                if page == "advanced" {
                    guard let data = rawJSON.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        model.error = "Configuration must be a valid JSON object."; return
                    }
                    model.draft = parsed
                }
                Task { await model.save() }
            }.buttonStyle(.borderedProminent).keyboardShortcut("s", modifiers: .command).disabled(!hasChanges)
        }.padding(.horizontal, 24).padding(.vertical, 16)
    }

    private var automation: some View {
        Form {
            Section("Work streams") {
                Text("Set independent limits for automatic starts. Waiting runs free a slot. Manual runs can exceed the limit and count toward it while active. Lowering a limit does not stop running work.").font(.callout).foregroundStyle(.secondary)
                numberField("Claude run limit", path: ["concurrency", "claude"], unit: "runs")
                numberField("Codex run limit", path: ["concurrency", "codex"], unit: "runs")
                Button("Set model priority and difficulty limits") { page = "models" }
            }
            Section("When to start") {
                numberField("Wait until the selected provider has been idle for", path: ["idleMinutes"], unit: "min")
                numberField("Check for ready tickets every", path: ["pollSeconds"], unit: "sec", range: 15...86400)
            }
            Section("Claude budgets") {
                budgetGrid([(name: "Five-hour", key: "fiveHour"), (name: "Weekly", key: "weekly"), (name: "Fable allowance", key: "fable")], provider: "claude")
                Text("The five-hour budget applies to all Claude models. General models also use the weekly budget; Fable uses its separate allowance.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Codex budget") {
                budgetGrid([(name: "Weekly", key: "weekly")], provider: "codex")
                Text("All Codex models share this budget. Switching between Astra and Sol does not create more allowance.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Text("Reserve at start shrinks to zero as reset approaches. Start above is a fixed minimum remaining to launch another job. Running jobs are allowed to finish.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Waiting & recovery") {
                Toggle("Unlimited runs awaiting your input", isOn: Binding(get: { model.draft["maxWaitingPRs"] is NSNull }, set: { model.update(["maxWaitingPRs"], $0 ? NSNull() : 5) }))
                if !(model.draft["maxWaitingPRs"] is NSNull) { numberField("Waiting run limit", path: ["maxWaitingPRs"], unit: "runs") }
                numberField("Park an inactive background monitor after", path: ["monitoringTimeoutMinutes"], unit: "min")
                Text("Waiting runs release their provider’s automatic slot. Active work is allowed to finish.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }

    private var models: some View {
        let presets = model.draft["models"] as? [[String: Any]] ?? []
        return VStack(spacing: 0) {
            HStack {
                if model.catalogLoading { ProgressView().controlSize(.small); Text("Loading models from T3…").font(.caption) }
                else if let error = model.catalogError { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
                else { Text("Drag to rank models · highest priority first").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Refresh models") { Task { await model.refreshModels() } }.disabled(model.catalogLoading)
            }.padding(.horizontal, 24).padding(.bottom, 12)
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    List(selection: $modelTarget) {
                        ForEach(presets.compactMap { $0["id"] as? String }, id: \.self) { id in
                            let index = presets.firstIndex { $0["id"] as? String == id } ?? 0
                            HStack(spacing: 8) {
                                Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 18)
                                Text(presets[index]["name"] as? String ?? "Model")
                                Spacer()
                                Image(systemName: "line.3.horizontal").font(.caption).foregroundStyle(.tertiary)
                            }.tag(id)
                        }.onMove { offsets, destination in model.moveModels(from: offsets, to: destination) }
                    }.listStyle(.inset)
                    HStack {
                        Button { moveSelectedModel(-1) } label: { Image(systemName: "arrow.up") }.help("Raise priority").accessibilityLabel("Raise model priority").disabled(presets.first?["id"] as? String == modelTarget)
                        Button { moveSelectedModel(1) } label: { Image(systemName: "arrow.down") }.help("Lower priority").accessibilityLabel("Lower model priority").disabled(presets.last?["id"] as? String == modelTarget)
                    }.padding(.top, 8)
                    Button { addPreset() } label: { Label("Add model", systemImage: "plus") }
                        .disabled(model.providers.isEmpty).padding(12)
                }.frame(width: 165)
                Divider()
                if let index = presets.firstIndex(where: { $0["id"] as? String == modelTarget }) {
                    Form {
                        Section("Model configuration") {
                            settingField("Name", path: ["models", String(index), "name"])
                            modelEditor(["models", String(index), "model"])
                            Toggle("Use for automatic runs", isOn: model.bool(["models", String(index), "automatic"]))
                            Picker("Maximum ticket difficulty", selection: model.string(["models", String(index), "maxDifficulty"])) {
                                Text("Low").tag("low"); Text("Medium").tag("med"); Text("High").tag("high")
                            }
                            Text("Unclassified tickets are skipped. This limit applies to manual runs too. Turning automatic runs off keeps the model available in Run now.").font(.caption).foregroundStyle(.secondary)
                            Button("Remove model", role: .destructive) {
                                var next = presets; next.remove(at: index); model.update(["models"], next)
                                modelTarget = next.first?["id"] as? String ?? ""
                            }.disabled(presets.count <= 1)
                        }
                    }.formStyle(.grouped)
                } else {
                    Text("Select a model to edit its provider, model and options.").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }
    private func moveSelectedModel(_ direction: Int) {
        let presets = model.draft["models"] as? [[String: Any]] ?? []
        guard let index = presets.firstIndex(where: { $0["id"] as? String == modelTarget }), presets.indices.contains(index + direction) else { return }
        model.moveModels(from: IndexSet(integer: index), to: direction < 0 ? index - 1 : index + 2)
    }
    private func budgetGrid(_ windows: [(name: String, key: String)], provider: String) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
            GridRow {
                Text("Allowance"); Text("Reserve at start"); Text("Start above")
            }.font(.caption).foregroundStyle(.secondary)
            ForEach(windows, id: \.key) { window in
                GridRow {
                    Text(window.name).frame(maxWidth: .infinity, alignment: .leading)
                    budgetField("\(provider) \(window.name) reserve", path: ["quota", provider, window.key, "reservePercent"])
                    budgetField("\(provider) \(window.name) minimum", path: ["quota", provider, window.key, "minRemainingPercent"])
                }
            }
        }.padding(.vertical, 4)
    }
    private func budgetField(_ title: String, path: [String]) -> some View {
        HStack(spacing: 5) {
            TextField(title, value: model.number(path), format: .number).labelsHidden().multilineTextAlignment(.trailing).frame(width: 50).accessibilityLabel(title)
            Text("%").foregroundStyle(.secondary)
            Stepper(title, value: model.number(path), in: 0...100).labelsHidden().fixedSize().accessibilityLabel(title)
        }
    }
    private func addPreset() {
        let provider = model.providers.first { $0["driver"] as? String == "codex" } ?? model.providers.first
        guard let instance = provider?["instanceId"] as? String else { return }
        var presets = model.draft["models"] as? [[String: Any]] ?? []
        let id = "preset-" + UUID().uuidString.prefix(8).lowercased()
        presets.append(["id": id, "name": "New model", "automatic": false, "maxDifficulty": "high", "model": ["instanceId": instance, "model": "", "options": []] as [String: Any]])
        model.update(["models"], presets)
        model.selectProvider(instance, path: ["models", String(presets.count - 1), "model"])
        modelTarget = id
    }
    private func modelEditor(_ path: [String]) -> some View {
        let instance = valueAt(model.draft, path + ["instanceId"]) as? String ?? ""
        let slug = valueAt(model.draft, path + ["model"]) as? String ?? ""
        let providers = model.providers
        let available = model.availableModels(instance)
        return Group {
            Picker("Provider", selection: Binding(get: { instance }, set: { model.selectProvider($0, path: path) })) {
                if !providers.contains(where: { $0["instanceId"] as? String == instance }) { Text(instance.isEmpty ? "Select provider" : instance).tag(instance) }
                ForEach(Array(providers.enumerated()), id: \.offset) { _, provider in
                    let id = provider["instanceId"] as? String ?? ""
                    let name = provider["driver"] as? String == "codex" ? "Codex" : "Claude"
                    Text(id == provider["driver"] as? String ? name : name + " · " + id).tag(id)
                }
            }.disabled(model.catalogLoading || providers.isEmpty)
            Picker("Model", selection: Binding(get: { slug }, set: { model.selectModel($0, path: path) })) {
                if !available.contains(where: { $0["slug"] as? String == slug }) { Text(slug.isEmpty ? "Select model" : slug + " (unavailable)").tag(slug) }
                ForEach(Array(available.enumerated()), id: \.offset) { _, entry in
                    Text(entry["name"] as? String ?? entry["slug"] as? String ?? "Model").tag(entry["slug"] as? String ?? "")
                }
            }.disabled(model.catalogLoading || available.isEmpty)
            ForEach(Array(model.modelOptions(path).enumerated()), id: \.offset) { _, descriptor in
                if let id = descriptor["id"] as? String, let choices = descriptor["options"] as? [[String: Any]], descriptor["type"] as? String == "select" {
                    let fallback = descriptor["currentValue"] as? String ?? choices.first(where: { $0["isDefault"] as? Bool == true })?["id"] as? String ?? ""
                    Picker(descriptor["label"] as? String ?? id, selection: model.option(path, id: id, fallback: fallback)) {
                        ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                            Text(choice["label"] as? String ?? choice["id"] as? String ?? "").tag(choice["id"] as? String ?? "")
                        }
                    }
                }
            }
            if available.isEmpty { Text("No models loaded for this provider. Check its connection in T3, then refresh.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func settingField(_ title: String, path: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: model.string(path)).labelsHidden().accessibilityLabel(title)
        }.padding(.vertical, 3)
    }
    private func pathField(_ title: String, path: [String], directory: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField(title, text: model.string(path)).labelsHidden().accessibilityLabel(title)
                Button("Choose…") { model.choosePath(path, directory: directory) }.accessibilityLabel("Choose \(title.lowercased())")
            }
        }.padding(.vertical, 3)
    }
    private func numberField(_ title: String, path: [String], unit: String, range: ClosedRange<Double> = 1...100000) -> some View {
        HStack {
            Text(title); Spacer()
            TextField(title, value: model.number(path), format: .number).labelsHidden().multilineTextAlignment(.trailing).frame(width: 60).accessibilityLabel(title)
            Text(unit).foregroundStyle(.secondary).font(.caption).frame(minWidth: 28, alignment: .leading)
            Stepper(title, value: model.number(path), in: range).labelsHidden().fixedSize().accessibilityLabel(title)
        }
    }

    private var projects: some View {
        let entries = model.draft["projects"] as? [[String: Any]] ?? []
        return HStack(spacing: 0) {
            VStack(spacing: 0) {
                List(selection: $selectedProject) {
                    ForEach(entries.indices, id: \.self) { Text(entries[$0]["name"] as? String ?? "New project").tag($0) }
                }.listStyle(.inset)
                Button {
                    var items = entries
                    items.append(["name": "New project", "enabled": false, "key": "", "kaneoId": "", "t3Id": "", "repoPath": "", "githubRepo": "", "baseBranch": "main", "readyStatuses": ["to-do"], "doneStatuses": ["done"]])
                    model.update(["projects"], items); selectedProject = items.count - 1
                } label: { Label("Add project", systemImage: "plus") }.padding(12)
            }.frame(width: 165)
            Divider()
            if entries.indices.contains(selectedProject) {
                let prefix = ["projects", String(selectedProject)]
                Form {
                    Section("Repository") {
                        Toggle("Include this project", isOn: model.bool(prefix + ["enabled"]))
                        settingField("Name", path: prefix + ["name"])
                        pathField("Repository folder", path: prefix + ["repoPath"], directory: true)
                        settingField("GitHub owner/repository", path: prefix + ["githubRepo"])
                        settingField("Release branch", path: prefix + ["baseBranch"])
                    }
                    Section("Ticket queue") {
                        settingField("Ticket prefix", path: prefix + ["key"])
                        DisclosureGroup("Tracker & T3 connection") {
                            settingField("Kaneo project ID", path: prefix + ["kaneoId"])
                            settingField("T3 project ID", path: prefix + ["t3Id"])
                            TextField("Ready statuses", text: model.strings(prefix + ["readyStatuses"]))
                            TextField("Done statuses", text: model.strings(prefix + ["doneStatuses"]))
                        }
                        Text("Register the repository in T3 before enabling it here.").font(.caption).foregroundStyle(.secondary)
                        Button("Remove project", role: .destructive) {
                            var items = entries
                            items.remove(at: selectedProject); model.update(["projects"], items); selectedProject = max(0, selectedProject - 1)
                        }.disabled(entries.count <= 1 || model.jobs.contains { $0["projectId"] as? String == entries[selectedProject]["kaneoId"] as? String && $0["state"] as? String != "complete" }).help("Projects with unfinished runs cannot be removed")
                    }
                }.formStyle(.grouped)
            }
        }
    }
    private var discovery: some View {
        Form {
            Section("Instructions") {
                Text("Discovery runs only when no enabled project has a ready ticket. It creates validated tickets in a separate thread and worktree; it does not implement them.").font(.callout).foregroundStyle(.secondary)
                pathField("Discovery prompt", path: ["discovery", "promptFile"], directory: false)
                Button("Edit prompt") { if let path = valueAt(model.draft, ["discovery", "promptFile"]) as? String { model.openFile(path) } }
            }
            Section("When no work is found") {
                numberField("Wait before trying the same project again", path: ["discovery", "emptyCooldownHours"], unit: "hours")
            }
        }.formStyle(.grouped)
    }
    private var advanced: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button("Open configuration file") { model.openFile(model.home.appendingPathComponent(".config/t3-factory/config.jsonc").path) }
                Button("Open log") { model.openFile(model.home.appendingPathComponent("Library/Logs/t3-factory.log").path) }
            }
            Text("Saving validates the entire configuration. Changes here are shared with the other settings pages.").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $rawJSON).font(.system(.body, design: .monospaced)).padding(8).background(Color(nsColor: .textBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Configuration JSON")
        }.padding(.horizontal, 24).padding(.bottom, 20)
    }
}
