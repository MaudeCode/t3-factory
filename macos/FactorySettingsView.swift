import AppKit
import SwiftUI

// The factory window: live pages first, then every setting the web app has, in the same dark look.
struct FactorySettingsView: View {
    @ObservedObject var model: FactoryModel
    @State var page = "factory"
    @State private var selectedProject = 0
    @State private var selectedModelId = ""
    @State private var runFilter = "next"
    @State private var rawJSON = ""
    @State private var preserveAdvancedText = false
    @State private var adding = false
    @State private var editingUpstream: UpstreamDraft?
    private let pages: [(id: String, title: String, icon: String, help: String)] = [
        ("factory", "Factory", "bolt.horizontal", "What the factory is doing, what needs you, and what comes next."),
        ("runs", "Runs", "list.bullet.rectangle", "Every run and the whole queue, with held-back tickets and why."),
        ("activity", "Activity", "clock", "What the factory decided and what each run did. A check is recorded when its outcome changes."),
        ("models", "Models", "cpu", "Drag to set priority. The first model that is automatic, within its difficulty ceiling, and inside its allowance takes the next ticket."),
        ("capacity", "Capacity", "gauge.with.dots.needle.33percent", "How many runs each provider may have open, how much allowance it must keep, and when it may start. Running work always finishes."),
        ("projects", "Projects", "folder", "Repositories the factory may work in. A project pairs a T3 project with a Kaneo project."),
        ("upstream", "Upstream", "arrow.down.to.line", "Each new release of a watched repository gets a review run that files tickets for anything worth adopting."),
        ("advanced", "Advanced", "curlybraces", "Edit the complete configuration or open the factory log."),
    ]

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                let current = pages.first { $0.id == page } ?? pages[0]
                HStack(spacing: 8) {
                    Text(current.title).font(.system(size: 20, weight: .bold))
                    HelpMark(text: current.help)
                    Spacer()
                    if page == "models" { Button("Refresh catalog") { Task { await model.refreshModels() } }.buttonStyle(QuietButton()).disabled(model.catalogLoading); Button("Add model") { addPreset() }.buttonStyle(PrimaryButton()).disabled(model.providers.isEmpty) }
                    if page == "projects" { Button("Add project") { adding = true }.buttonStyle(PrimaryButton()) }
                    if page == "upstream", model.hasUpstream { Button("Watch a repository") { editingUpstream = UpstreamDraft(project: firstEnabledProject, index: nil) }.buttonStyle(QuietButton()) }
                }.padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 14)
                Group {
                    switch page {
                    case "factory": FactoryPanel(model: model, compact: false)
                    case "runs": runs
                    case "activity": activity
                    case "models": models
                    case "capacity": capacity
                    case "projects": projects
                    case "upstream": upstream
                    default: advanced
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                if hasChanges || model.busy != nil || model.error != nil { Rectangle().fill(Theme.line).frame(height: 1); saveBar }
            }.background(Theme.bg)
        }
        .background(Theme.bg)
        .frame(minWidth: 980, minHeight: 700)
        .themed()
        .onAppear {
            if selectedModelId.isEmpty { selectedModelId = (model.draft["models"] as? [[String: Any]])?.first?["id"] as? String ?? "" }
            Task { await model.refreshSources() }
        }
        .onChange(of: page) { old, new in
            if old == "advanced" {
                guard let data = rawJSON.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    model.error = "Fix the JSON or revert your changes before leaving Advanced."; preserveAdvancedText = true; page = "advanced"; return
                }
                model.draft = parsed
            }
            if new == "advanced" { if preserveAdvancedText { preserveAdvancedText = false } else { rawJSON = prettyJSON(model.draft) } }
            if new == "projects" || new == "upstream" { Task { await model.refreshSources(force: true) } }
            if new == "models" || new == "factory" { Task { await model.refreshModels() } }
        }
        .sheet(isPresented: $adding) { AddProjectSheet(model: model) { index in selectedProject = index; adding = false } onCancel: { adding = false } }
        .sheet(item: $editingUpstream) { draft in UpstreamSheet(model: model, draft: draft) { editingUpstream = nil } }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) { Image(nsImage: FactoryIcon.image); Text("FACTORY").font(.system(size: 13, weight: .bold)).kerning(1.2) }.padding(.horizontal, 14).padding(.vertical, 18)
            ForEach(pages, id: \.id) { entry in
                if entry.id == "models" { Text("Settings").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted).padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 4) }
                Button { page = entry.id } label: {
                    HStack(spacing: 9) {
                        Image(systemName: entry.icon).frame(width: 16)
                        Text(entry.title).font(.system(size: 13, weight: page == entry.id ? .semibold : .regular))
                        Spacer()
                        if entry.id == "runs", !model.waitingJobs.isEmpty { Text("\(model.waitingJobs.count)").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.accentInk).padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(Theme.attention)) }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(page == entry.id ? Theme.surface2 : .clear))
                    .foregroundStyle(page == entry.id ? Theme.ink : Theme.muted)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).padding(.horizontal, 8)
            }
            Spacer()
            Button("Open T3") { model.openT3() }.buttonStyle(QuietButton()).padding(14)
        }.frame(width: 190).background(Theme.surface)
    }

    private var hasChanges: Bool { page == "advanced" ? rawJSON != prettyJSON(model.config) : prettyJSON(model.draft) != prettyJSON(model.config) }
    private var saveBar: some View {
        HStack(spacing: 12) {
            if let busy = model.busy { ProgressView().controlSize(.small); Text(busy).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else if let error = model.error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).lineLimit(3).textSelection(.enabled) }
            else { Text("Unsaved changes").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            Spacer()
            Button(model.error == nil ? "Discard" : "Reload") { Task { await model.reload(); rawJSON = prettyJSON(model.draft) } }.buttonStyle(QuietButton()).disabled(!hasChanges && model.error == nil)
            Button("Save changes") {
                if page == "advanced" {
                    guard let data = rawJSON.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { model.error = "Configuration must be a valid JSON object."; return }
                    model.draft = parsed
                }
                Task { await model.save() }
            }.buttonStyle(PrimaryButton()).keyboardShortcut("s", modifiers: .command).disabled(!hasChanges)
        }.padding(.horizontal, 24).padding(.vertical, 12)
    }
    private var firstEnabledProject: Int { (model.draft["projects"] as? [[String: Any]] ?? []).firstIndex { $0["enabled"] as? Bool == true } ?? 0 }

    // Runs -------------------------------------------------------------------------------------------
    private var runs: some View {
        let open = model.activeJobs + model.waitingJobs
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Segments(options: [("next", "Up next \(model.queued.count)"), ("open", "Open \(open.count)"), ("waiting", "Needs you \(model.waitingJobs.count)"), ("finished", "Finished \(model.recentJobs.count)")], value: $runFilter)
                switch runFilter {
                case "next":
                    ForEach(model.chains, id: \.rowId) { ChainCard(model: model, plan: $0) }
                    UpNextCard(model: model, limit: 500)
                    if !model.held.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SectionTitle("Held back", count: model.held.count, help: "Ready tickets the scheduler will not start, and why.")
                            ForEach(Array(model.held.enumerated()), id: \.offset) { _, h in
                                HStack(alignment: .top, spacing: 8) { Text(h["key"] as? String ?? "").font(Theme.mono()); Text(h["reason"] as? String ?? "").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                            }
                        }.card()
                    }
                case "open": list(open, empty: "Nothing is open.")
                case "waiting": list(model.waitingJobs, empty: "Nothing needs you.")
                default: list(model.recentJobs, empty: "Nothing has finished yet.")
                }
            }.padding(.horizontal, 24).padding(.bottom, 24)
        }
    }
    private func list(_ jobs: [[String: Any]], empty: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if jobs.isEmpty { Text(empty).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            ForEach(jobs, id: \.rowId) { RunRow(model: model, job: $0) }
        }.card()
    }

    // Activity ---------------------------------------------------------------------------------------
    private var activity: some View {
        let groups = Dictionary(grouping: model.journal) { Words.day($0["time"] as? String) }
        let order = model.journal.map { Words.day($0["time"] as? String) }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if model.journal.isEmpty { Text("Nothing recorded yet.").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                ForEach(order, id: \.self) { day in
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(day, count: nil)
                        ForEach(groups[day] ?? [], id: \.rowId) { JournalRow(model: model, event: $0) }
                    }.card()
                }
            }.padding(.horizontal, 24).padding(.bottom, 24)
        }
    }

    // Models -----------------------------------------------------------------------------------------
    private var models: some View {
        let presets = model.draft["models"] as? [[String: Any]] ?? []
        return HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 0) {
                List(selection: $selectedModelId) {
                    ForEach(presets.compactMap { $0["id"] as? String }, id: \.self) { id in
                        let index = presets.firstIndex { $0["id"] as? String == id } ?? 0
                        let preset = presets[index]
                        HStack(spacing: 10) {
                            Image(systemName: "line.3.horizontal").font(.system(size: 10)).foregroundStyle(Theme.muted)
                            Text("\(index + 1)").font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 14)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(preset["name"] as? String ?? "Model").font(.system(size: 13, weight: .semibold))
                                Text("\((preset["model"] as? [String: Any])?["model"] as? String ?? ""), up to \(preset["maxDifficulty"] as? String == "med" ? "medium" : preset["maxDifficulty"] as? String ?? "high")").font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                                let live = model.liveModelState(id)
                                if !live.isEmpty { Text(live).font(.system(size: 11)).foregroundStyle(live == "next automatic run" ? Theme.ok : Theme.muted) }
                            }
                            Spacer()
                            Tag(text: preset["automatic"] as? Bool == true ? "automatic" : "manual", color: preset["automatic"] as? Bool == true ? Theme.accent : Theme.muted)
                        }.padding(.vertical, 4).tag(id).listRowBackground(Color.clear)
                    }.onMove { offsets, destination in model.moveModels(from: offsets, to: destination) }
                }.listStyle(.plain).scrollContentBackground(.hidden).background(Theme.surface).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
                if let error = model.catalogError { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).lineLimit(2).padding(.top, 4) }
            }.frame(width: 300).padding(.leading, 24).padding(.bottom, 24)
            ScrollView {
                if let index = presets.firstIndex(where: { $0["id"] as? String == selectedModelId }) { modelEditor(index, presets: presets) }
                else { Text("Select a model.").foregroundStyle(Theme.muted) }
            }.padding(.trailing, 24).padding(.bottom, 24)
        }
    }
    private func modelEditor(_ index: Int, presets: [[String: Any]]) -> some View {
        let p = ["models", String(index)], preset = presets[index]
        let inUse = model.jobs.contains { !["complete", "dismissed"].contains($0["state"] as? String ?? "") && ($0["modelSelection"] as? [String: Any])?["model"] as? String == (preset["model"] as? [String: Any])?["model"] as? String }
        return VStack(alignment: .leading, spacing: 14) {
            HStack { Text(preset["name"] as? String ?? "").font(.system(size: 17, weight: .semibold)); Spacer(); Button("Remove") { var next = presets; next.remove(at: index); model.update(["models"], next); selectedModelId = next.first?["id"] as? String ?? "" }.buttonStyle(QuietButton(color: Theme.danger)).disabled(inUse || presets.count <= 1) }
            Switch(label: "Takes tickets automatically", help: "On: the scheduler may pick this model when it is next in priority and inside its allowance. Off: only used when you start a run and choose it.", on: model.bool(p + ["automatic"]))
            Field(label: "Name") { DarkTextField(placeholder: "Name", text: model.string(p + ["name"])) }
            Field(label: "Hardest ticket it may take", help: "Tickets carry a difficulty label. Applies to automatic and manual runs.") { Segments(options: [("low", "Low"), ("med", "Medium"), ("high", "High")], value: model.string(p + ["maxDifficulty"])) }
            modelPickers(p + ["model"])
            if let window = preset["quotaWindowId"] as? String { Text("Budgeted against the \(window.replacingOccurrences(of: "_", with: " ")) window.").font(.system(size: 11)).foregroundStyle(Theme.muted) }
        }.card()
    }
    private func modelPickers(_ path: [String]) -> some View {
        let instance = valueAt(model.draft, path + ["instanceId"]) as? String ?? ""
        let slug = valueAt(model.draft, path + ["model"]) as? String ?? ""
        let available = model.availableModels(instance)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Field(label: "Provider") {
                    Picker("", selection: Binding(get: { instance }, set: { model.selectProvider($0, path: path) })) {
                        if !model.providers.contains(where: { $0["instanceId"] as? String == instance }) { Text(instance.isEmpty ? "Choose" : instance).tag(instance) }
                        ForEach(Array(model.providers.enumerated()), id: \.offset) { _, provider in
                            let id = provider["instanceId"] as? String ?? "", name = provider["driver"] as? String == "codex" ? "Codex" : "Claude"
                            Text(id == provider["driver"] as? String ? name : name + ", " + id).tag(id)
                        }
                    }.labelsHidden().disabled(model.catalogLoading || model.providers.isEmpty)
                }
                Field(label: "Model") {
                    Picker("", selection: Binding(get: { slug }, set: { model.selectModel($0, path: path) })) {
                        if !available.contains(where: { $0["slug"] as? String == slug }) { Text(slug.isEmpty ? "Choose" : slug).tag(slug) }
                        ForEach(Array(available.enumerated()), id: \.offset) { _, entry in Text(entry["name"] as? String ?? entry["slug"] as? String ?? "Model").tag(entry["slug"] as? String ?? "") }
                    }.labelsHidden().disabled(model.catalogLoading || available.isEmpty)
                }
            }
            ForEach(Array(model.modelOptions(path).enumerated()), id: \.offset) { _, descriptor in
                if let id = descriptor["id"] as? String, let choices = descriptor["options"] as? [[String: Any]], descriptor["type"] as? String == "select" {
                    let fallback = descriptor["currentValue"] as? String ?? choices.first(where: { $0["isDefault"] as? Bool == true })?["id"] as? String ?? ""
                    Field(label: descriptor["label"] as? String ?? id) {
                        Picker("", selection: model.option(path, id: id, fallback: fallback)) {
                            ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in Text(choice["label"] as? String ?? choice["id"] as? String ?? "").tag(choice["id"] as? String ?? "") }
                        }.labelsHidden().frame(maxWidth: 220)
                    }
                }
            }
            if available.isEmpty && !model.catalogLoading { Text("No models loaded for this provider. Check its connection in T3, then refresh the catalog.").font(.system(size: 11)).foregroundStyle(Theme.attention) }
        }
    }
    private func addPreset() {
        let provider = model.providers.first { $0["driver"] as? String == "codex" } ?? model.providers.first
        guard let instance = provider?["instanceId"] as? String else { return }
        var presets = model.draft["models"] as? [[String: Any]] ?? []
        let id = "model-" + UUID().uuidString.prefix(8).lowercased()
        presets.append(["id": id, "name": "New model", "automatic": false, "maxDifficulty": "high", "model": ["instanceId": instance, "model": "", "options": []] as [String: Any]])
        model.update(["models"], presets)
        model.selectProvider(instance, path: ["models", String(presets.count - 1), "model"])
        selectedModelId = id
    }

    // Capacity ---------------------------------------------------------------------------------------
    private var capacity: some View {
        let minutes = { (v: Double) in Words.span(v * 60) }, seconds = { (v: Double) in Words.span(v) }
        let waiting = model.waitingJobs.count
        return ScrollView {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionTitle("Runs at once", help: "Filled slots are running now. Runs waiting for you free their slot. A run you start by hand may exceed the limit.")
                        ForEach([("claudeAgent", "claude", "Claude"), ("codex", "codex", "Codex")], id: \.0) { driver, key, name in
                            let running = model.jobsForProvider(driver).filter { ["running", "dispatching"].contains($0["state"] as? String ?? "") }.count
                            Field(label: "\(name): \(running) running") { slots(path: ["concurrency", key], running: running) }
                        }
                    }.card()
                    VStack(alignment: .leading, spacing: 12) {
                        SectionTitle("Timing")
                        SliderField(label: "Wait for the provider to be idle", help: "Automatic ticket work starts only after you have not used the provider for this long. Reviews skip the wait.", value: model.number(["idleMinutes"], fallback: 30), range: 1...180, step: 1, format: minutes)
                        SliderField(label: "Check at least every", help: "Passes start as soon as a T3 thread, the config, or a ready ticket changes; this is the fallback interval.", value: model.number(["pollSeconds"], fallback: 60), range: 15...900, step: 15, format: seconds)
                    }.card()
                    VStack(alignment: .leading, spacing: 12) {
                        SectionTitle("Waiting and recovery")
                        Field(label: "Runs that may wait for you: \(waiting) waiting now", help: "Past the limit, automatic starts pause until you answer one.") { waitingStepper }
                        SliderField(label: "Park a stalled monitor after", help: "A run whose background monitor makes no progress for this long is parked and marked as needing you.", value: model.number(["monitoringTimeoutMinutes"], fallback: 30), range: 5...240, step: 5, format: minutes)
                        SliderField(label: "Trust an allowance reading for", help: "Older readings are refreshed from T3 before a start, and the scheduler re-reads allowances on this cadence.", value: model.number(["quota", "maxAgeSeconds"], fallback: 300), range: 30...1800, step: 30, format: seconds)
                    }.card()
                }
                VStack(alignment: .leading, spacing: 12) {
                    allowance("Claude allowance", driver: "claudeAgent", provider: "claude", windows: [("fiveHour", "Five-hour"), ("weekly", "Weekly"), ("fable", "Fable")])
                    allowance("Codex allowance", driver: "codex", provider: "codex", windows: [("weekly", "Weekly")])
                }
            }.padding(.horizontal, 24).padding(.bottom, 24)
        }
    }
    private func slots(path: [String], running: Int) -> some View {
        let limit = (valueAt(model.draft, path) as? NSNumber)?.intValue ?? 1
        return HStack(spacing: 4) {
            ForEach(0...max(6, limit), id: \.self) { n in
                Button { model.update(path, n) } label: {
                    Text(n == 0 ? "Off" : "\(n)").font(.system(size: 12, weight: .semibold)).frame(minWidth: 30, minHeight: 28).padding(.horizontal, 2)
                        .background(RoundedRectangle(cornerRadius: 6).fill(n > 0 && n <= running ? Theme.accent : n == 0 && limit == 0 ? Theme.surface2 : .clear))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(n == limit ? Theme.accent : (n > 0 && n <= limit) ? Theme.accent.opacity(0.6) : Theme.line, style: StrokeStyle(lineWidth: n == limit ? 2 : 1, dash: n > limit ? [3] : [])))
                        .foregroundStyle(n > 0 && n <= running ? Theme.accentInk : n <= limit ? Theme.ink : Theme.muted)
                }.buttonStyle(.plain)
            }
        }
    }
    private var waitingStepper: some View {
        let value = model.draft["maxWaitingPRs"] as? NSNumber
        return HStack(spacing: 6) {
            Button("−") { model.update(["maxWaitingPRs"], value == nil ? 20 : max(1, value!.intValue - 1)) }.buttonStyle(QuietButton()).disabled(value != nil && value!.intValue <= 1)
            Text(value.map { "\($0)" } ?? "No limit").font(.system(size: 13, weight: .semibold)).frame(width: 70)
            Button("+") { model.update(["maxWaitingPRs"], value == nil ? NSNull() : (value!.intValue >= 20 ? NSNull() : value!.intValue + 1)) }.buttonStyle(QuietButton()).disabled(value == nil)
        }
    }
    private func allowance(_ title: String, driver: String, provider: String, windows: [(String, String)]) -> some View {
        let quota = model.quota(driver)
        let live = Dictionary((quota?["windows"] as? [[String: Any]] ?? []).compactMap { w in (w["name"] as? String).map { ($0, w) } }, uniquingKeysWith: { a, _ in a })
        let fable = (quota?["factoryRouting"] as? [String: Any])?["fableRemainingPercent"] as? Double
        return VStack(alignment: .leading, spacing: 14) {
            SectionTitle(title, help: "The dashed line is what is held back right now; the reserve relaxes as the window nears its reset, the floor never does.") {
                Text(quota?["capturedAt"] != nil ? "read " + Words.ago(quota?["capturedAt"] as? String, now: model.now) : "no reading yet").font(.system(size: 11)).foregroundStyle(Theme.muted)
            }
            ForEach(windows, id: \.0) { key, label in
                let w = live[key], remaining = key == "fable" ? fable : w?["remaining"] as? Double
                VStack(alignment: .leading, spacing: 6) {
                    AllowanceBar(label: label, remaining: remaining ?? 0, reserved: w?["reserved"] as? Double, note: (w?["resetsAt"] as? String).flatMap { $0.isEmpty ? nil : "resets " + Words.until($0, now: model.now) } ?? (remaining == nil ? "no reading" : ""))
                    HStack(spacing: 14) {
                        SliderField(label: "Reserve at window start", value: model.number(["quota", provider, key, "reservePercent"]), range: 0...100, step: 1) { "\(Int($0))%" }
                        SliderField(label: "Floor", value: model.number(["quota", provider, key, "minRemainingPercent"]), range: 0...100, step: 1) { "\(Int($0))%" }
                    }
                }
            }
        }.card()
    }

    // Projects ---------------------------------------------------------------------------------------
    private var projects: some View {
        let entries = model.draft["projects"] as? [[String: Any]] ?? []
        let i = min(selectedProject, max(0, entries.count - 1))
        return HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 6) {
                ForEach(entries.indices, id: \.self) { j in
                    let x = entries[j]
                    let active = model.jobs.filter { $0["projectId"] as? String == x["kaneoId"] as? String && ["running", "dispatching"].contains($0["state"] as? String ?? "") }.count
                    Button { selectedProject = j } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(x["name"] as? String ?? "Project").font(.system(size: 13, weight: .semibold))
                                Text(x["githubRepo"] as? String ?? x["repoPath"] as? String ?? "not set").font(Theme.mono(11, weight: .regular)).foregroundStyle(Theme.muted)
                                Text("\(active) running\((x["upstreams"] as? [[String: Any]])?.isEmpty == false ? ", \((x["upstreams"] as? [[String: Any]])!.count) watched" : "")").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Tag(text: x["enabled"] as? Bool == true ? "included" : "off", color: x["enabled"] as? Bool == true ? Theme.accent : Theme.muted)
                        }.padding(10).background(RoundedRectangle(cornerRadius: 8).fill(j == i ? Theme.surface2 : Theme.surface)).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if let error = model.sourcesError { Text("Catalogs unavailable: \(error)").font(.system(size: 11)).foregroundStyle(Theme.attention).padding(.top, 6) }
                else if model.sources == nil { HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Reading the T3 and Kaneo catalogs").font(.system(size: 11)).foregroundStyle(Theme.muted) }.padding(.top, 6) }
            }.frame(width: 280).padding(.leading, 24).padding(.bottom, 24)
            ScrollView { if entries.indices.contains(i) { projectEditor(i, entries: entries) } }.padding(.trailing, 24).padding(.bottom, 24)
        }
    }
    private func projectEditor(_ i: Int, entries: [[String: Any]]) -> some View {
        let p = ["projects", String(i)], current = entries[i], kaneoId = current["kaneoId"] as? String ?? ""
        let inUse = model.jobs.contains { $0["projectId"] as? String == kaneoId && !["complete", "dismissed"].contains($0["state"] as? String ?? "") }
        let t3 = model.t3Projects.first { $0["id"] as? String == current["t3Id"] as? String }
        let mismatch = (t3?["workspaceRoot"] as? String).map { $0 != current["repoPath"] as? String } ?? false
        let cols = model.columns(kaneoId).map { ($0["slug"] as? String ?? "", $0["name"] as? String ?? "") }
        return VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(current["name"] as? String ?? "").font(.system(size: 17, weight: .semibold))
                    HStack(spacing: 12) {
                        if let repo = current["githubRepo"] as? String, !repo.isEmpty { Button("GitHub") { model.openURL("https://github.com/\(repo)") }.buttonStyle(.link) }
                        if !kaneoId.isEmpty { Button("Kaneo") { model.openTicket(kaneoId, taskId: nil) }.buttonStyle(.link) }
                    }
                }
                Spacer()
                Button("Remove") { var items = entries; items.remove(at: i); model.update(["projects"], items); selectedProject = max(0, i - 1) }.buttonStyle(QuietButton(color: Theme.danger)).disabled(inUse || entries.count <= 1)
            }
            Switch(label: "Included in automatic work", help: "On: its ready tickets, discovery, and watched releases are all eligible. Off: nothing starts here; open runs still finish.", on: model.bool(p + ["enabled"]))
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Repository")
                HStack(spacing: 12) {
                    Field(label: "Name") { DarkTextField(placeholder: "Name", text: model.string(p + ["name"])) }
                    Field(label: "GitHub owner/repo") { DarkTextField(placeholder: "owner/repo", text: model.string(p + ["githubRepo"]), mono: true) }
                }
                HStack(spacing: 12) {
                    Field(label: "T3 project", help: "T3 creates each run's worktree from this project.") { catalogPicker(current: current["t3Id"] as? String ?? "", options: model.t3Projects.map { ($0["id"] as? String ?? "", $0["title"] as? String ?? "") }) { model.linkT3(i, id: $0) } }
                    Field(label: "Base branch") { DarkTextField(placeholder: "main", text: model.string(p + ["baseBranch"]), mono: true) }
                }
                Field(label: "Repository path on your Mac", help: "Must match the T3 project's workspace root, or T3 cannot create worktrees for its runs.") { DarkTextField(placeholder: "/path", text: model.string(p + ["repoPath"]), mono: true) }
                if mismatch, let root = t3?["workspaceRoot"] as? String {
                    HStack { Text("T3 works in \(root). Dispatch fails until these match.").font(.system(size: 11)).foregroundStyle(Theme.attention); Button("Use T3's path") { model.update(p + ["repoPath"], root) }.buttonStyle(QuietButton()) }
                }
            }.card()
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Tickets")
                HStack(spacing: 12) {
                    Field(label: "Kaneo project") { catalogPicker(current: kaneoId, options: model.kaneoProjects.map { ($0["id"] as? String ?? "", "\($0["name"] as? String ?? "") (\($0["slug"] as? String ?? ""))") }) { model.linkKaneo(i, id: $0) } }
                    Field(label: "Ticket prefix") { DarkTextField(placeholder: "APP", text: model.string(p + ["key"]), mono: true) }
                }
                Field(label: "Ready when in", help: "Tickets in these columns may be picked up.") { chips(path: p + ["readyStatuses"], options: cols) }
                Field(label: "Done when in", help: "A ticket moved here is finished; its run is settled.") { chips(path: p + ["doneStatuses"], options: cols) }
                Field(label: "Priority labels", help: "Pick in order of importance. Tickets with a higher label go first; among equals, urgency decides.") { chips(path: p + ["priorityLabels"], options: model.workspaceLabels.map { ($0, $0) }, ordered: true) }
            }.card()
            VStack(alignment: .leading, spacing: 8) {
                SectionTitle("Watched releases", help: "Each new release of these repositories gets a review run.") { Button("Manage") { page = "upstream" }.buttonStyle(.link) }
                let watched = current["upstreams"] as? [[String: Any]] ?? []
                if watched.isEmpty { Text("None yet.").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                ForEach(Array(watched.enumerated()), id: \.offset) { _, u in HStack { Text(u["name"] as? String ?? "").font(.system(size: 13, weight: .semibold)); Text(u["repo"] as? String ?? "").font(Theme.mono(11, weight: .regular)).foregroundStyle(Theme.muted); Spacer() } }
            }.card()
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Discovery", help: "When no tickets are eligible, a free provider investigates one included project for new work and files tickets.")
                Field(label: "Prompt file on your Mac") { HStack { DarkTextField(placeholder: "/path/to/discovery.md", text: model.string(["discovery", "promptFile"]), mono: true); Button("Choose") { model.choosePath(["discovery", "promptFile"], directory: false) }.buttonStyle(QuietButton()) } }
                SliderField(label: "After finding nothing, leave a project alone for", value: model.number(["discovery", "emptyCooldownHours"], fallback: 24), range: 1...168, step: 1) { Words.span($0 * 3600) }
            }.card()
        }
    }
    private func catalogPicker(current: String, options: [(String, String)], onChange: @escaping (String) -> Void) -> some View {
        Picker("", selection: Binding(get: { current }, set: { if $0 != current { onChange($0) } })) {
            if !options.contains(where: { $0.0 == current }) { Text(current.isEmpty ? "Choose" : current).tag(current) }
            ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
        }.labelsHidden()
    }
    private func chips(path: [String], options: [(String, String)], ordered: Bool = false) -> some View {
        let binding = model.stringList(path), current = binding.wrappedValue
        let names = Dictionary(options, uniquingKeysWith: { a, _ in a })
        let all = ordered ? current + options.map { $0.0 }.filter { !current.contains($0) } : options.map { $0.0 } + current.filter { names[$0] == nil }
        return VStack(alignment: .leading, spacing: 6) {
            Wrap {
                ForEach(all, id: \.self) { v in
                    let i = current.firstIndex(of: v)
                    Chip(text: names[v] ?? v, on: i != nil, rank: ordered ? i.map { $0 + 1 } : nil) { binding.wrappedValue = i == nil ? current + [v] : current.filter { $0 != v } }
                }
            }
            if options.isEmpty { CustomChip { binding.wrappedValue = current.contains($0) ? current : current + [$0] } }
        }
    }

    // Upstream ---------------------------------------------------------------------------------------
    private var upstream: some View {
        let c = model.draft
        let projects = c["projects"] as? [[String: Any]] ?? []
        let rows = model.status["upstreams"] as? [[String: Any]] ?? []
        let interval = (valueAt(c, ["upstream", "checkMinutes"]) as? NSNumber)?.doubleValue ?? 360
        return ScrollView {
            if !model.hasUpstream { Text("No watched repositories. Add upstream with a prompt file to the config file to turn reviews on.").font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.horizontal, 24) }
            else {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text(model.upstreamEnabled ? "Reviews on" : "Reviews paused").font(.system(size: 13, weight: .semibold)); Spacer(); Toggle("", isOn: Binding(get: { model.upstreamEnabled }, set: { v in Task { await model.setEnabled(v, upstream: true) } })).toggleStyle(.switch).labelsHidden().disabled(model.busy != nil) }.card()
                        VStack(alignment: .leading, spacing: 10) {
                            SectionTitle("Watched releases")
                            let watched = projects.enumerated().flatMap { pi, p in (p["upstreams"] as? [[String: Any]] ?? []).enumerated().map { ui, u in (pi, ui, u, p["name"] as? String ?? "") } }
                            if watched.isEmpty { Text("No watched repositories yet.").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                            ForEach(Array(watched.enumerated()), id: \.offset) { _, entry in
                                let (pi, ui, u, projectName) = entry
                                let r = rows.first { $0["repo"] as? String == u["repo"] as? String }
                                Button { editingUpstream = UpstreamDraft(project: pi, index: ui, entry: u) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 1) { Text(u["name"] as? String ?? "").font(.system(size: 13, weight: .semibold)); Text("\(u["repo"] as? String ?? "")\(u["prereleases"] as? Bool == true ? ", pre-releases" : ""), \(projectName)").font(.system(size: 11)).foregroundStyle(Theme.muted) }
                                            Spacer()
                                            if r?["reviewing"] as? Bool == true { Tag(text: "reviewing", color: Theme.accent) } else if r?["pending"] as? Bool == true { Tag(text: "review due", color: Theme.attention) } else if r?["latest"] is String { Tag(text: "up to date", color: Theme.ok) } else { Tag(text: "new") }
                                        }
                                        HStack(spacing: 16) {
                                            Text("reviewed ").foregroundStyle(Theme.muted) + Text(r?["reviewed"] as? String ?? u["firstBase"] as? String ?? "").font(Theme.mono(11))
                                            Text("latest ").foregroundStyle(Theme.muted) + Text(r?["latest"] as? String ?? "not checked").font(Theme.mono(11))
                                            if let checked = r?["checkedAt"] as? String { Text("checked \(Words.ago(checked, now: model.now))").foregroundStyle(Theme.muted) }
                                        }.font(.system(size: 11))
                                        if let error = r?["checkError"] as? String, !error.isEmpty { Text(error).font(.system(size: 11)).foregroundStyle(Theme.attention) }
                                    }.padding(.vertical, 4).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }.card()
                        let reviews = model.jobs.filter { $0["kind"] as? String == "upstream" }
                        if !reviews.isEmpty { VStack(alignment: .leading, spacing: 8) { SectionTitle("Reviews", count: reviews.count); ForEach(reviews, id: \.rowId) { RunRow(model: model, job: $0) } }.card() }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        SectionTitle("Settings")
                        Field(label: "Prompt file on your Mac", help: "Read for each review run.") { HStack { DarkTextField(placeholder: "/path/to/review.md", text: model.string(["upstream", "promptFile"]), mono: true); Button("Choose") { model.choosePath(["upstream", "promptFile"], directory: false) }.buttonStyle(QuietButton()) } }
                        SliderField(label: "Check for releases every", help: "A repository can set its own interval.", value: model.number(["upstream", "checkMinutes"], fallback: interval), range: 15...1440, step: 15) { Words.span($0 * 60) }
                    }.card().frame(width: 340)
                }.padding(.horizontal, 24).padding(.bottom, 24)
            }
        }
    }

    // Advanced ---------------------------------------------------------------------------------------
    private var advanced: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button("Open configuration file") { model.openFile(model.home.appendingPathComponent(".config/t3-factory/config.jsonc").path) }.buttonStyle(QuietButton())
                Button("Open log") { model.openFile(model.home.appendingPathComponent("Library/Logs/t3-factory.log").path) }.buttonStyle(QuietButton())
                HelpMark(text: "Saving validates the entire configuration. Changes here are shared with the other pages.")
            }
            TextEditor(text: $rawJSON).font(Theme.mono(12, weight: .regular)).scrollContentBackground(.hidden).padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
        }.padding(.horizontal, 24).padding(.bottom, 24)
    }
}

// A box to add a value the catalog does not offer.
struct CustomChip: View {
    let add: (String) -> Void
    @State private var text = ""
    var body: some View {
        TextField("Add a status", text: $text, onCommit: { let v = text.trimmingCharacters(in: .whitespaces); if !v.isEmpty { add(v) }; text = "" })
            .textFieldStyle(.plain).font(.system(size: 12)).padding(.horizontal, 10).padding(.vertical, 4).frame(width: 140)
            .overlay(Capsule().stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [3])))
    }
}

// New projects start from the T3 and Kaneo catalogs so nothing has to be typed.
struct AddProjectSheet: View {
    @ObservedObject var model: FactoryModel
    let onAdd: (Int) -> Void
    let onCancel: () -> Void
    @State private var t3 = ""
    @State private var kaneo = ""
    var body: some View {
        let taken = Set((model.draft["projects"] as? [[String: Any]] ?? []).flatMap { [$0["t3Id"] as? String ?? "", $0["kaneoId"] as? String ?? ""] })
        let t3Project = model.t3Projects.first { $0["id"] as? String == t3 }, kaneoProject = model.kaneoProjects.first { $0["id"] as? String == kaneo }
        VStack(alignment: .leading, spacing: 14) {
            Text("Add a project").font(.system(size: 17, weight: .semibold))
            if model.sources == nil && model.sourcesError == nil { HStack { ProgressView().controlSize(.small); Text("Loading the T3 and Kaneo catalogs").font(.system(size: 12)).foregroundStyle(Theme.muted) } }
            if let error = model.sourcesError { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            Field(label: "T3 project", help: "Sets the repository path T3 works in.") {
                Picker("", selection: $t3) { Text("Choose").tag(""); ForEach(model.t3Projects.filter { !taken.contains($0["id"] as? String ?? "") }, id: \.rowId) { Text($0["title"] as? String ?? "").tag($0["id"] as? String ?? "") } }.labelsHidden()
            }
            Field(label: "Kaneo project", help: "Sets the ticket prefix and which columns mean ready and done.") {
                Picker("", selection: $kaneo) { Text("Choose").tag(""); ForEach(model.kaneoProjects.filter { !taken.contains($0["id"] as? String ?? "") }, id: \.rowId) { Text("\($0["name"] as? String ?? "") (\($0["slug"] as? String ?? ""))").tag($0["id"] as? String ?? "") } }.labelsHidden()
            }
            if let t3Project { Text("Path: \(t3Project["workspaceRoot"] as? String ?? "")").font(Theme.mono(11, weight: .regular)).foregroundStyle(Theme.muted) }
            if let kaneoProject { Text("Tickets: \(kaneoProject["slug"] as? String ?? "")-…").font(.system(size: 11)).foregroundStyle(Theme.muted) }
            HStack { Spacer(); Button("Cancel", action: onCancel).buttonStyle(QuietButton()); Button("Add project") { onAdd(model.addProject(t3: t3Project, kaneo: kaneoProject)) }.buttonStyle(PrimaryButton()).disabled(t3Project == nil && kaneoProject == nil) }
        }.padding(22).frame(width: 440).background(Theme.bg).themed().task { await model.refreshSources() }
    }
}

struct UpstreamDraft: Identifiable {
    var project: Int
    var index: Int?
    var entry: [String: Any] = ["name": "", "repo": "", "firstBase": "", "prereleases": false]
    var id: String { "\(project)-\(index.map(String.init) ?? "new")" }
}

// One watched repository, new or existing. Edits land in the draft on Apply.
struct UpstreamSheet: View {
    @ObservedObject var model: FactoryModel
    @State var draft: UpstreamDraft
    let onClose: () -> Void
    var body: some View {
        let projects = model.draft["projects"] as? [[String: Any]] ?? []
        let name = draft.entry["name"] as? String ?? "", repo = draft.entry["repo"] as? String ?? "", base = draft.entry["firstBase"] as? String ?? ""
        let valid = !name.trimmingCharacters(in: .whitespaces).isEmpty && repo.range(of: #"^[\w.-]+/[\w.-]+$"#, options: .regularExpression) != nil && !base.trimmingCharacters(in: .whitespaces).isEmpty
        VStack(alignment: .leading, spacing: 14) {
            Text(draft.index == nil ? "Watch a repository" : "Watching \(name)").font(.system(size: 17, weight: .semibold))
            Field(label: "Reviewed for", help: "Reviews file tickets in this project.") { Picker("", selection: $draft.project) { ForEach(projects.indices, id: \.self) { Text(projects[$0]["name"] as? String ?? "").tag($0) } }.labelsHidden() }
            HStack(spacing: 12) {
                Field(label: "GitHub owner/repo") { DarkTextField(placeholder: "owner/repo", text: field("repo"), mono: true) }
                Field(label: "Name") { DarkTextField(placeholder: "Name", text: field("name")) }
            }
            Field(label: "Already reviewed up to", help: "The release tag the project is current with. Anything newer gets a review.") { DarkTextField(placeholder: "v1.2.0", text: field("firstBase"), mono: true) }
            Switch(label: "Include pre-releases", on: Binding(get: { draft.entry["prereleases"] as? Bool ?? false }, set: { draft.entry["prereleases"] = $0 }))
            Switch(label: "Own check interval", help: "For a repository that publishes too often to review every release.", on: Binding(get: { draft.entry["checkMinutes"] != nil }, set: { draft.entry["checkMinutes"] = $0 ? ((valueAt(model.draft, ["upstream", "checkMinutes"]) as? NSNumber) ?? 360) : nil }))
            if draft.entry["checkMinutes"] != nil { SliderField(label: "Check every", value: Binding(get: { (draft.entry["checkMinutes"] as? NSNumber)?.doubleValue ?? 360 }, set: { draft.entry["checkMinutes"] = $0 }), range: 15...2880, step: 15) { Words.span($0 * 60) } }
            HStack {
                if let index = draft.index { Button("Stop watching") { remove(index); onClose() }.buttonStyle(QuietButton(color: Theme.danger)) }
                Spacer()
                Button("Cancel", action: onClose).buttonStyle(QuietButton())
                Button(draft.index == nil ? "Watch" : "Apply") { apply(); onClose() }.buttonStyle(PrimaryButton()).disabled(!valid)
            }
        }.padding(22).frame(width: 480).background(Theme.bg).themed()
    }
    private func field(_ key: String) -> Binding<String> { Binding(get: { draft.entry[key] as? String ?? "" }, set: { draft.entry[key] = $0 }) }
    private let origin: Int
    init(model: FactoryModel, draft: UpstreamDraft, onClose: @escaping () -> Void) {
        self.model = model; self._draft = State(initialValue: draft); self.onClose = onClose; self.origin = draft.project
    }
    private func apply() {
        var entry = draft.entry
        entry["name"] = (entry["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        entry["repo"] = (entry["repo"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        entry["firstBase"] = (entry["firstBase"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if let index = draft.index, draft.project == origin {
            var list = valueAt(model.draft, ["projects", String(origin), "upstreams"]) as? [[String: Any]] ?? []
            if list.indices.contains(index) { list[index] = entry } else { list.append(entry) }
            model.update(["projects", String(origin), "upstreams"], list)
        } else {
            // Edited under another project: it leaves the original list and joins the new one.
            if let index = draft.index { remove(index) }
            var list = valueAt(model.draft, ["projects", String(draft.project), "upstreams"]) as? [[String: Any]] ?? []
            list.append(entry)
            model.update(["projects", String(draft.project), "upstreams"], list)
        }
    }
    private func remove(_ index: Int) {
        var list = valueAt(model.draft, ["projects", String(origin), "upstreams"]) as? [[String: Any]] ?? []
        if list.indices.contains(index) { list.remove(at: index) }
        model.update(["projects", String(origin), "upstreams"], list)
    }
}
