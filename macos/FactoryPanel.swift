import AppKit
import SwiftUI

// The status panel: what the factory is doing, why, what needs you, what comes next, and a way to start a run.
struct FactoryPanel: View {
    @ObservedObject var model: FactoryModel
    var compact = true
    var body: some View {
        VStack(spacing: 0) {
            if compact { header; Divider() }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    automation
                    providers
                    if !model.waitingJobs.isEmpty { group("Needs you", count: model.waitingJobs.count) { ForEach(model.waitingJobs, id: \.jobId) { RunRow(model: model, job: $0) } } }
                    group("Running", count: model.activeJobs.count) {
                        if model.activeJobs.isEmpty { empty("Nothing is running.") } else { ForEach(model.activeJobs, id: \.jobId) { RunRow(model: model, job: $0) } }
                    }
                    ForEach(model.chains, id: \.planId) { ChainCard(model: model, plan: $0) }
                    upNext
                    composer
                }.padding(16)
            }
            if compact { Divider(); footer }
        }
        .frame(width: compact ? 400 : nil)
        .frame(height: compact ? 700 : nil)
        .alert(promptTitle, isPresented: Binding(get: { model.prompt != nil }, set: { if !$0 { model.prompt = nil } }), presenting: model.prompt, actions: promptActions, message: promptMessage)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: FactoryIcon.image)
            Text("Factory").font(.headline)
            Spacer()
            Text(model.lastCheck).font(.caption).foregroundStyle(.secondary)
            Button { model.openSettings() } label: { Image(systemName: "gearshape") }.buttonStyle(.plain).help("Settings")
        }.padding(.horizontal, 16).padding(.vertical, 12)
    }
    private var footer: some View {
        HStack {
            Button("Open T3") { model.openT3() }
            Spacer()
            if let busy = model.busy { ProgressView().controlSize(.small); Text(busy).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            Spacer()
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("Quit the menu app; the factory keeps running")
        }.buttonStyle(.borderless).padding(.horizontal, 16).padding(.vertical, 10)
    }

    // Automation switch, the last check in a sentence, and the review switch when reviews are configured.
    private var automation: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Toggle("", isOn: Binding(get: { model.enabled }, set: { value in Task { await model.setEnabled(value) } })).toggleStyle(.switch).labelsHidden().disabled(model.busy != nil)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.enabled ? "Automation on" : "Automation paused").font(.title3.weight(.semibold))
                    Text(model.decisionSentence).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if model.hasUpstream {
                Toggle("Upstream reviews", isOn: Binding(get: { model.upstreamEnabled }, set: { value in Task { await model.setEnabled(value, upstream: true) } })).toggleStyle(.switch).font(.callout).disabled(model.busy != nil)
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            else if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
    }

    // Each provider: slots in use, its reason, and its allowance windows with the held-back line.
    private var providers: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(["claudeAgent", "codex"], id: \.self) { driver in ProviderCard(model: model, driver: driver) }
        }
    }

    private var upNext: some View {
        group("Up next", count: model.queued.count) {
            if model.upNext == nil { empty("The queue has not been read yet.") }
            else if model.queued.isEmpty { empty("Nothing is ready to start.") }
            else {
                ForEach(Array(model.queued.prefix(5).enumerated()), id: \.offset) { index, ticket in
                    Button { model.openTicket(ticket["projectId"] as? String, taskId: ticket["id"] as? String) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 14, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) { Text(ticket["key"] as? String ?? "").font(.callout.weight(.semibold).monospaced()); Text(ticket["title"] as? String ?? "").font(.callout).lineLimit(1) }
                                HStack(spacing: 4) {
                                    if let after = ticket["after"] as? [String], !after.isEmpty { Text("after " + after.joined(separator: ", ")).foregroundStyle(.orange) }
                                    Text([model.projectName(ticket["projectId"] as? String), ticket["difficulty"] as? String ?? "unclassified", ticket["priority"] as? String ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                }.font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text(ticket["model"] as? String ?? "no automatic model fits").font(.caption).foregroundStyle(ticket["model"] == nil || ticket["model"] is NSNull ? .orange : .secondary)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if model.queued.count > 5 || !model.held.isEmpty {
                    Text("\(model.queued.count > 5 ? "\(model.queued.count - 5) more queued" : "")\(model.queued.count > 5 && !model.held.isEmpty ? ", " : "")\(model.held.isEmpty ? "" : "\(model.held.count) held back")").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private var composer: some View {
        group("Start a run", count: nil) {
            HStack(spacing: 8) {
                TextField("Ticket key, or blank for the next eligible", text: $model.ticket).textFieldStyle(.roundedBorder).font(.body.monospaced()).onSubmit { Task { await model.dispatch() } }
                Picker("Model", selection: $model.selectedModel) {
                    Text("Automatic").tag("auto")
                    ForEach(Array(model.configuredModels.enumerated()), id: \.offset) { _, preset in Text(preset["name"] as? String ?? "Model").tag(preset["id"] as? String ?? "") }
                }.labelsHidden().frame(width: 120)
            }
            HStack {
                if model.selectedModelUsesCodex { Text("Codex runs ignore idle time and reserves.").font(.caption).foregroundStyle(.secondary) }
                else { Toggle("Ignore idle time and reserves", isOn: $model.overrideLimits).font(.caption) }
                Spacer()
                Button { Task { await model.dispatch() } } label: { Label("Start run", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent).disabled(model.config.isEmpty || model.busy != nil)
            }
        }
    }

    // Blocked tickets and missing ready labels are questions, not failures.
    private var promptTitle: String {
        switch model.prompt {
        case .blocked(let ticket, let tree, _): return "\(ticket) waits on \((tree["tickets"] as? [[String: Any]])?.count ?? 0) tickets"
        case .readiness(let ticket, let label, _): return "Run \(ticket) without \(label)?"
        case nil: return ""
        }
    }
    @ViewBuilder private func promptActions(_ prompt: RunPrompt) -> some View {
        switch prompt {
        case .blocked(_, let tree, _):
            let tickets = tree["tickets"] as? [[String: Any]] ?? []
            let now = tickets.contains { ($0["blockedBy"] as? [String] ?? []).isEmpty && $0["runnable"] as? Bool == true }
            Button("Run the first blocker") { Task { await model.answer(prompt, with: ["--chain", "first"]) } }.disabled(!now)
            Button("Run the whole chain") { Task { await model.answer(prompt, with: ["--chain", "all"]) } }
            Button("Cancel", role: .cancel) { model.prompt = nil }
        case .readiness:
            Button("Run anyway") { Task { await model.answer(prompt, with: ["--allow-missing-ready-label"]) } }
            Button("Cancel", role: .cancel) { model.prompt = nil }
        }
    }
    private func promptMessage(_ prompt: RunPrompt) -> some View {
        switch prompt {
        case .blocked(let ticket, let tree, _):
            let tickets = tree["tickets"] as? [[String: Any]] ?? []
            let byId = Dictionary(uniqueKeysWithValues: tickets.compactMap { t in (t["id"] as? String).map { ($0, t["key"] as? String ?? "?") } })
            let lines = tickets.map { t -> String in
                let after = (t["blockedBy"] as? [String] ?? []).compactMap { byId[$0] }
                let state = after.isEmpty ? (t["runnable"] as? Bool == true ? "can start" : "project not included") : "after " + after.joined(separator: ", ")
                return "\(t["key"] as? String ?? "") \(t["title"] as? String ?? "") — \(state)\(t["readyLabel"] as? Bool == false ? ", no ready label" : "")"
            }
            return Text("The whole chain starts every ticket that can start now, within the run limits, continues as tickets finish, and runs \(ticket) last.\n\n" + lines.joined(separator: "\n"))
        case .readiness(_, let label, _):
            return Text("This ticket is not marked \(label). Running it skips only that label check; dependency, difficulty, quota, and duplicate checks still apply.")
        }
    }

    @ViewBuilder private func group<Content: View>(_ title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold))
                if let count, count > 0 { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            content()
        }.padding(12).background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.4)))
    }
    private func empty(_ text: String) -> some View { Text(text).font(.callout).foregroundStyle(.secondary) }
}

private extension Dictionary where Key == String, Value == Any {
    var jobId: String { self["id"] as? String ?? UUID().uuidString }
    var planId: String { self["id"] as? String ?? UUID().uuidString }
}

struct ProviderCard: View {
    @ObservedObject var model: FactoryModel
    let driver: String
    var body: some View {
        let name = driver == "codex" ? "Codex" : "Claude"
        let active = model.jobsForProvider(driver).filter { ["running", "dispatching"].contains($0["state"] as? String ?? "") }.count
        let limit = model.liveConcurrency[driver] ?? 1
        let quota = model.quota(driver)
        let windows = quota?["windows"] as? [[String: Any]] ?? []
        let fable = (quota?["factoryRouting"] as? [String: Any])?["fableRemainingPercent"] as? Double
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.subheadline.weight(.semibold))
                Spacer()
                Text(model.streamReason(driver)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(limit == 0 ? "\(active) running, automatic starts off" : "\(active) running of \(limit)").font(.caption).foregroundStyle(.secondary)
            if windows.isEmpty && fable == nil {
                Text((model.stream(driver)["quotaError"] as? String).map { "Allowance unavailable: \($0)" } ?? "No allowance reading yet.").font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                AllowanceBar(label: window["name"] as? String == "fiveHour" ? "Five-hour" : "Weekly", remaining: window["remaining"] as? Double ?? 0, reserved: window["reserved"] as? Double,
                             note: (window["resetsAt"] as? String).map { "resets " + Words.until($0, now: model.now) } ?? "")
            }
            if let fable { AllowanceBar(label: "Fable", remaining: fable, reserved: nil, note: "") }
            if let read = quota?["capturedAt"] as? String { Text("read " + Words.ago(read, now: model.now)).font(.caption2).foregroundStyle(.tertiary) }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.4)))
    }
}

// Remaining allowance with the line the scheduler holds back right now.
struct AllowanceBar: View {
    let label: String; let remaining: Double; let reserved: Double?; let note: String
    var body: some View {
        let value = max(0, min(100, remaining)), low = value <= (reserved ?? 15)
        VStack(alignment: .leading, spacing: 3) {
            HStack { Text(label).font(.caption); Spacer(); Text("\(Int(value))%").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(low ? .orange : .primary) }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(low ? Color.orange : Color.accentColor).frame(width: geo.size.width * value / 100)
                    if let reserved, reserved > 0 { Rectangle().fill(.secondary).frame(width: 1.5, height: 10).offset(x: geo.size.width * min(100, reserved) / 100 - 0.75) }
                }
            }.frame(height: 6)
            if !note.isEmpty { Text(note).font(.caption2).foregroundStyle(.tertiary) }
        }
    }
}

// One run: ticket, project and model, state, timing, and what it waits for. Clicking opens its T3 thread.
struct RunRow: View {
    @ObservedObject var model: FactoryModel
    let job: [String: Any]
    private static let pending = ["approval": "waiting for an approval", "question": "asked a question", "input": "waiting for input"]
    var body: some View {
        let state = job["state"] as? String ?? ""
        let waiting = state == "waiting"
        let thread = job["thread"] as? [String: Any]
        let note = waiting ? ((thread?["pending"] as? String).flatMap { Self.pending[$0] } ?? job["reason"] as? String ?? "") : ""
        let timing = waiting ? "since " + Words.ago(job["lastExecutionAt"] as? String ?? job["createdAt"] as? String, now: model.now)
            : Words.span(model.now.timeIntervalSince(FactoryModel.date(job["createdAt"] as? String ?? "") ?? model.now)) + " in, active " + Words.ago(job["lastExecutionAt"] as? String ?? job["createdAt"] as? String, now: model.now)
        Button { model.openThread(job) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(job["label"] as? String ?? job["ticketKey"] as? String ?? "Discovery").font(.callout.weight(.semibold).monospaced())
                    Text([model.projectName(job["projectId"] as? String), model.modelName(job), (job["difficulty"] as? String).map { $0 == "med" ? "medium" : $0 } ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Tag(text: waiting ? "Needs you" : state == "dispatching" ? "Starting" : "Running", color: waiting ? .orange : .accentColor)
                }
                HStack(spacing: 6) {
                    Text(timing).font(.caption).foregroundStyle(.secondary)
                    if !note.isEmpty { Text("· " + note).font(.caption).foregroundStyle(.orange).lineLimit(1) }
                }
            }.contentShape(Rectangle())
        }.buttonStyle(.plain)
        .contextMenu {
            Button("Open in T3") { model.openThread(job) }
            if (job["prUrls"] as? [String])?.isEmpty == false { Button("Open pull request") { model.openPullRequest(job) } }
            if job["taskId"] is String { Button("Open ticket in Kaneo") { model.openTicket(job["projectId"] as? String, taskId: job["taskId"] as? String) } }
            Divider()
            Button("Stop run", role: .destructive) { Task { await model.stop(job) } }
        }
    }
}

// A chain the user started: each ticket's state and what the next one waits for.
struct ChainCard: View {
    @ObservedObject var model: FactoryModel
    let plan: [String: Any]
    var body: some View {
        let target = plan["target"] as? [String: Any] ?? [:]
        let tickets = (plan["tickets"] as? [[String: Any]] ?? []) + [target]
        let byId = Dictionary(uniqueKeysWithValues: tickets.compactMap { t in (t["id"] as? String).map { ($0, t) } })
        let done = tickets.filter { $0["done"] as? Bool == true }.count
        let openByTask = Dictionary(model.jobs.filter { !["complete", "dismissed"].contains($0["state"] as? String ?? "") }.compactMap { j in (j["taskId"] as? String).map { ($0, j) } }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Chain to \(target["key"] as? String ?? "")").font(.subheadline.weight(.semibold))
                Text("\(done) of \(tickets.count) done").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { Task { await model.cancelChain(plan) } }.buttonStyle(.borderless).font(.caption).disabled(model.busy != nil)
            }
            ForEach(Array(tickets.enumerated()), id: \.offset) { _, t in
                let id = t["id"] as? String ?? ""
                let job = openByTask[id]
                let ahead = (t["blockedBy"] as? [String] ?? []).compactMap { byId[$0] }.filter { $0["done"] as? Bool != true }.compactMap { $0["key"] as? String }
                let isTarget = id == target["id"] as? String
                let state: (String, Color, String) = t["done"] as? Bool == true ? ("Done", .green, "")
                    : job != nil ? ((job?["state"] as? String == "waiting" ? "Needs you" : "Running"), job?["state"] as? String == "waiting" ? .orange : .accentColor, model.modelName(job!))
                    : isTarget && tickets.dropLast().contains(where: { $0["done"] as? Bool != true }) ? ("Last", .secondary, "after every ticket above")
                    : !ahead.isEmpty ? ("Waits", .secondary, "after " + ahead.joined(separator: ", "))
                    : ("Next", .orange, t["note"] as? String ?? "starts when a slot is free")
                HStack(spacing: 8) {
                    Tag(text: state.0, color: state.1).frame(width: 70)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) { Text(t["key"] as? String ?? "").font(.callout.weight(.semibold).monospaced()); Text(t["title"] as? String ?? "").font(.callout).lineLimit(1) }
                        if !state.2.isEmpty { Text(state.2).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    Spacer()
                }
            }
        }.padding(12).background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.4)))
    }
}

struct Tag: View {
    let text: String; let color: Color
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(color.opacity(0.8), lineWidth: 1)).foregroundStyle(color)
    }
}
