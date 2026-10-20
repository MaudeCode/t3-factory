import AppKit
import SwiftUI

// The status panel: what the factory is doing, why, what needs you, what comes next, and a way to start a run.
struct FactoryPanel: View {
    @ObservedObject var model: FactoryModel
    var compact = true
    var body: some View {
        VStack(spacing: 0) {
            if compact { header; Rectangle().fill(Theme.line).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    automation
                    composer
                    HStack(alignment: .top, spacing: 12) { ProviderCard(model: model, driver: "claudeAgent"); ProviderCard(model: model, driver: "codex") }
                    if !model.waitingJobs.isEmpty { section("Needs you", count: model.waitingJobs.count) { ForEach(model.waitingJobs, id: \.rowId) { RunRow(model: model, job: $0) } } }
                    section("Running", count: model.activeJobs.count) {
                        if model.activeJobs.isEmpty { empty("Nothing is running.") } else { ForEach(model.activeJobs, id: \.rowId) { RunRow(model: model, job: $0) } }
                    }
                    ForEach(model.chains, id: \.rowId) { ChainCard(model: model, plan: $0) }
                    UpNextCard(model: model, limit: 5)
                    if !model.recentJobs.isEmpty { section("Finished recently", count: nil) { ForEach(model.recentJobs.prefix(4), id: \.rowId) { RunRow(model: model, job: $0) } } }
                    if !model.journal.isEmpty { section("Activity", count: nil) { ForEach(model.journal.prefix(6), id: \.rowId) { JournalRow(model: model, event: $0) } } }
                }.padding(14)
            }
            if compact { Rectangle().fill(Theme.line).frame(height: 1); footer }
        }
        .background(Theme.bg)
        .frame(width: compact ? 420 : nil)
        .frame(maxHeight: .infinity)
        .themed()
        .alert(promptTitle, isPresented: Binding(get: { model.prompt != nil }, set: { if !$0 { model.prompt = nil } }), presenting: model.prompt, actions: promptActions, message: promptMessage)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: FactoryIcon.image)
            Text("FACTORY").font(.system(size: 13, weight: .bold)).kerning(1.2)
            Spacer()
            Text(model.lastCheck).font(.system(size: 11)).foregroundStyle(Theme.muted)
            Button { model.openSettings() } label: { Image(systemName: "slider.horizontal.3").foregroundStyle(Theme.muted) }.buttonStyle(.plain).help("Open the factory window")
        }.padding(.horizontal, 14).padding(.vertical, 11)
    }
    private var footer: some View {
        HStack {
            Button("Open T3") { model.openT3() }.buttonStyle(QuietButton())
            if let busy = model.busy { ProgressView().controlSize(.small); Text(busy).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
            Spacer()
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power").foregroundStyle(Theme.muted) }.buttonStyle(.plain).help("Quit the menu app; the factory keeps running")
        }.padding(.horizontal, 14).padding(.vertical, 9)
    }

    private var automation: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Toggle("", isOn: Binding(get: { model.enabled }, set: { value in Task { await model.setEnabled(value) } })).toggleStyle(.switch).labelsHidden().disabled(model.busy != nil)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.enabled ? "Automation on" : "Automation paused").font(.system(size: 17, weight: .semibold))
                    if !model.decisionSentence.isEmpty { Text(model.decisionSentence).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                }
            }
            if model.hasUpstream {
                HStack { Text("Upstream reviews").font(.system(size: 12)).foregroundStyle(Theme.muted); Toggle("", isOn: Binding(get: { model.upstreamEnabled }, set: { value in Task { await model.setEnabled(value, upstream: true) } })).toggleStyle(.switch).labelsHidden().controlSize(.small).disabled(model.busy != nil) }
            }
            if let error = model.error { Text(error).font(.system(size: 11)).foregroundStyle(Theme.danger).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            else if let notice = model.notice { Text(notice).font(.system(size: 11)).foregroundStyle(Theme.ok).fixedSize(horizontal: false, vertical: true) }
        }.card()
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Project key, dash, number; an empty number starts the next eligible ticket.
            HStack(spacing: 6) {
                Picker("", selection: $model.ticketProject) {
                    ForEach(model.projectKeys, id: \.self) { Text($0).tag($0) }
                }.labelsHidden().frame(width: 90).help("Ticket project")
                Text("-").foregroundStyle(Theme.muted)
                DarkTextField(placeholder: "next", text: $model.ticketNumber, mono: true).frame(width: 72).onSubmit { Task { await model.dispatch() } }
                    .help("Ticket number; leave empty to start the next eligible ticket")
                Picker("", selection: $model.selectedModel) {
                    Text("Auto").tag("auto")
                    ForEach(Array(model.configuredModels.enumerated()), id: \.offset) { _, preset in Text(preset["name"] as? String ?? "Model").tag(preset["id"] as? String ?? "") }
                }.labelsHidden().frame(width: 110)
                Button { model.overrideLimits.toggle() } label: { Image(systemName: "bolt.fill").foregroundStyle(model.overrideLimits ? Theme.accent : Theme.muted) }
                    .buttonStyle(.plain).disabled(model.selectedModelUsesCodex)
                    .help(model.selectedModelUsesCodex ? "Codex runs ignore idle time and reserves." : model.overrideLimits ? "Override limits: on. Skips idle and reserve thresholds; readiness, difficulty, duplicate and merge checks still apply." : "Override limits: off. Waits for idle time and reserve.")
                Button { Task { await model.dispatch() } } label: { Image(systemName: "play.fill") }.buttonStyle(PrimaryButton()).disabled(model.config.isEmpty)
                    .help(model.ticketNumber.isEmpty ? "Start the next eligible ticket" : "Start \(model.ticketProject)-\(model.ticketNumber)")
            }
            ForEach(model.requests) { request in
                HStack(alignment: .top, spacing: 8) {
                    if request.state == "running" { ProgressView().controlSize(.small) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(request.ticket) · \(request.model) · \(request.arguments.contains("--override-limits") ? "Override limits" : "Respect limits")").font(.system(size: 11, weight: .medium))
                        Text(request.message).font(.system(size: 11)).foregroundStyle(request.state == "error" ? Theme.danger : Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if let prompt = request.prompt { Button("Review") { model.prompt = prompt }.buttonStyle(QuietButton()).accessibilityLabel("Review \(request.ticket)") }
                    if !["queued", "running"].contains(request.state) {
                        Button { model.dismissRequest(request.id) } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss \(request.ticket)")
                    }
                }.padding(.vertical, 4)
            }
        }.card()
    }

    private var promptTitle: String {
        switch model.prompt {
        case .blocked(_, let ticket, let tree): return "\(ticket) waits on \((tree["tickets"] as? [[String: Any]])?.count ?? 0) tickets"
        case .readiness(_, let ticket, let label): return "Run \(ticket) without \(label)?"
        case nil: return ""
        }
    }
    @ViewBuilder private func promptActions(_ prompt: RunPrompt) -> some View {
        switch prompt {
        case .blocked(_, _, let tree):
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
        case .blocked(_, let ticket, let tree):
            let tickets = tree["tickets"] as? [[String: Any]] ?? []
            let byId = Dictionary(uniqueKeysWithValues: tickets.compactMap { t in (t["id"] as? String).map { ($0, t["key"] as? String ?? "?") } })
            let lines = tickets.map { t -> String in
                let after = (t["blockedBy"] as? [String] ?? []).compactMap { byId[$0] }
                let state = after.isEmpty ? (t["runnable"] as? Bool == true ? "can start" : "project not included") : "after " + after.joined(separator: ", ")
                return "\(t["key"] as? String ?? "") \(t["title"] as? String ?? "") — \(state)\(t["readyLabel"] as? Bool == false ? ", no ready label" : "")"
            }
            return Text("The whole chain starts every ticket that can start now, within the run limits, continues as tickets finish, and runs \(ticket) last. Tickets without the ready label run anyway.\n\n" + lines.joined(separator: "\n"))
        case .readiness(_, _, let label):
            return Text("This ticket is not marked \(label). Running it skips only that label check; dependency, difficulty, quota, and duplicate checks still apply.")
        }
    }

    @ViewBuilder private func section<Content: View>(_ title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) { SectionTitle(title, count: count); content() }.card()
    }
    private func empty(_ text: String) -> some View { Text(text).font(.system(size: 12)).foregroundStyle(Theme.muted) }
}

extension Dictionary where Key == String, Value == Any {
    var rowId: String { (self["id"] as? NSNumber).map { "\($0)" } ?? self["id"] as? String ?? UUID().uuidString }
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
                Text(name).font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(model.streamReason(driver)).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            HStack(spacing: 3) {
                ForEach(0..<max(limit, active, 1), id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2).fill(i < active ? Theme.accent : .clear).frame(width: 14, height: 8)
                        .overlay(RoundedRectangle(cornerRadius: 2).stroke(i < limit ? Theme.accent : Theme.line, style: StrokeStyle(lineWidth: 1, dash: i < limit ? [] : [2])))
                }
                Text(limit == 0 ? "\(active) running, automatic starts off" : "\(active) of \(limit)").font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.leading, 4)
            }
            if windows.isEmpty && fable == nil {
                Text((model.stream(driver)["quotaError"] as? String).map { "Allowance unavailable: \($0)" } ?? "No allowance reading yet.").font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                AllowanceBar(label: window["name"] as? String == "fiveHour" ? "Five-hour" : "Weekly", remaining: window["remaining"] as? Double ?? 0, reserved: window["reserved"] as? Double,
                             note: (window["resetsAt"] as? String).flatMap { $0.isEmpty ? nil : "resets " + Words.until($0, now: model.now) } ?? "")
            }
            if let fable { AllowanceBar(label: "Fable", remaining: fable, reserved: nil) }
            if let read = quota?["capturedAt"] as? String { Text("read " + Words.ago(read, now: model.now)).font(.system(size: 10)).foregroundStyle(Theme.muted) }
        }.card()
    }
}

// What the factory would start next; `limit` keeps the panel short, the window shows everything.
struct UpNextCard: View {
    @ObservedObject var model: FactoryModel
    let limit: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Up next", count: model.queued.count, help: "The order the scheduler would take tickets in, and which automatic model takes each. A ticket shown after another waits for it to finish.")
            if model.upNext == nil { Text("The queue has not been read yet.").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else if model.queued.isEmpty { Text("Nothing is ready to start.").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            else {
                ForEach(Array(model.queued.prefix(limit).enumerated()), id: \.offset) { index, ticket in
                    Button { model.openTicket(ticket["projectId"] as? String, taskId: ticket["id"] as? String) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(index + 1)").font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 18, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) { Text(ticket["key"] as? String ?? "").font(Theme.mono()); Text(ticket["title"] as? String ?? "").font(.system(size: 12)).lineLimit(1) }
                                HStack(spacing: 4) {
                                    if let after = ticket["after"] as? [String], !after.isEmpty { Text("after " + after.joined(separator: ", ")).foregroundStyle(Theme.attention) }
                                    Text(ticket["difficulty"] is String ? model.facets(ticket) : model.facets(ticket) + " · no difficulty").foregroundStyle(ticket["difficulty"] is String ? Theme.muted : Theme.attention)
                                }.font(.system(size: 11)).lineLimit(1)
                            }
                            Spacer()
                            Text(ticket["model"] as? String ?? "no automatic model fits").font(.system(size: 11)).foregroundStyle(ticket["model"] is String ? Theme.muted : Theme.attention)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if model.queued.count > limit || !model.held.isEmpty {
                    Text([model.queued.count > limit ? "\(model.queued.count - limit) more queued" : "", model.held.isEmpty ? "" : "\(model.held.count) held back"].filter { !$0.isEmpty }.joined(separator: ", ")).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
            }
            if let at = model.upNext?["at"] as? String { Text("Queue read " + Words.ago(at, now: model.now)).font(.system(size: 10)).foregroundStyle(Theme.muted) }
        }.card()
    }
}

// One run: ticket, project and model, state, timing, and what it waits for. Clicking opens its T3 thread.
struct RunRow: View {
    @ObservedObject var model: FactoryModel
    let job: [String: Any]
    private static let pending = ["approval": "waiting for an approval", "question": "asked a question", "input": "waiting for input"]
    var body: some View {
        let state = job["state"] as? String ?? ""
        let waiting = state == "waiting", finished = ["complete", "dismissed"].contains(state)
        let thread = job["thread"] as? [String: Any]
        let note = waiting ? ((thread?["pending"] as? String).flatMap { Self.pending[$0] } ?? job["reason"] as? String ?? "") : ""
        let created = job["createdAt"] as? String
        let timing: String = waiting ? "since " + Words.ago(job["lastExecutionAt"] as? String ?? created, now: model.now)
            : finished ? Words.ago(job["completedAt"] as? String ?? job["dismissedAt"] as? String ?? created, now: model.now) + ", took " + Words.span((Words.date(job["completedAt"] as? String ?? job["dismissedAt"] as? String ?? "") ?? model.now).timeIntervalSince(Words.date(created ?? "") ?? model.now))
            : Words.span(model.now.timeIntervalSince(Words.date(created ?? "") ?? model.now)) + " in, active " + Words.ago(job["lastExecutionAt"] as? String ?? created, now: model.now)
        let label: (String, Color) = waiting ? ("Needs you", Theme.attention) : state == "dispatching" ? ("Starting", Theme.accent) : state == "complete" ? ("Done", Theme.ok) : state == "dismissed" ? ("Settled", Theme.muted) : ("Running", Theme.accent)
        Button { model.openThread(job) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(job["label"] as? String ?? job["ticketKey"] as? String ?? "Discovery").font(Theme.mono())
                    Text(model.facets(job, model: model.modelName(job))).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer()
                    Tag(text: label.0, color: label.1)
                }
                HStack(spacing: 6) {
                    Text(timing).font(.system(size: 11)).foregroundStyle(Theme.muted)
                    if !note.isEmpty { Text("· " + note).font(.system(size: 11)).foregroundStyle(Theme.attention).lineLimit(1) }
                }
            }.contentShape(Rectangle())
        }.buttonStyle(.plain)
        .contextMenu {
            Button("Open in T3") { model.openThread(job) }
            if (job["prUrls"] as? [String])?.isEmpty == false { Button("Open pull request") { model.openPullRequest(job) } }
            if job["taskId"] is String { Button("Open ticket in Kaneo") { model.openTicket(job["projectId"] as? String, taskId: job["taskId"] as? String) } }
            if !finished { Divider(); Button("Stop run", role: .destructive) { Task { await model.stop(job) } } }
        }
    }
}

struct JournalRow: View {
    @ObservedObject var model: FactoryModel
    let event: [String: Any]
    var body: some View {
        let kind = event["kind"] as? String ?? "", data = event["data"] as? [String: Any] ?? [:]
        let color: Color = kind == "job.pr" ? Theme.ok : kind == "job.stop" ? Theme.attention : kind == "job.state" ? ((data["state"] as? String == "waiting") ? Theme.attention : data["state"] as? String == "complete" ? Theme.ok : Theme.accent) : kind == "job.created" ? Theme.accent : kind == "decision" && data["reason"] as? String == "error" ? Theme.danger : Theme.line
        HStack(alignment: .top, spacing: 8) {
            Text(Words.clock(event["time"] as? String)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 56, alignment: .leading)
            Circle().fill(color).frame(width: 7, height: 7).padding(.top, 4)
            Text(event["text"] as? String ?? "").font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
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
        let byId = Dictionary(tickets.compactMap { t in (t["id"] as? String).map { ($0, t) } }, uniquingKeysWith: { a, _ in a })
        let done = tickets.filter { $0["done"] as? Bool == true }.count
        let openByTask = Dictionary(model.jobs.filter { !["complete", "dismissed"].contains($0["state"] as? String ?? "") }.compactMap { j in (j["taskId"] as? String).map { ($0, j) } }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Chain to \(target["key"] as? String ?? "")", count: nil) {
                Text("\(done) of \(tickets.count) done").font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.muted)
                Button("Cancel chain") { Task { await model.cancelChain(plan) } }.buttonStyle(QuietButton(color: Theme.danger)).disabled(model.busy != nil)
            }
            ForEach(Array(tickets.enumerated()), id: \.offset) { _, t in
                let id = t["id"] as? String ?? ""
                let job = openByTask[id]
                let ahead = (t["blockedBy"] as? [String] ?? []).compactMap { byId[$0] }.filter { $0["done"] as? Bool != true }.compactMap { $0["key"] as? String }
                let isTarget = id == target["id"] as? String
                let state: (String, Color, String) = t["done"] as? Bool == true ? ("Done", Theme.ok, "")
                    : job != nil ? ((job?["state"] as? String == "waiting" ? "Needs you" : "Running"), job?["state"] as? String == "waiting" ? Theme.attention : Theme.accent, model.modelName(job!))
                    : isTarget && tickets.dropLast().contains(where: { $0["done"] as? Bool != true }) ? ("Last", Theme.muted, "after every ticket above")
                    : !ahead.isEmpty ? ("Waits", Theme.muted, "after " + ahead.joined(separator: ", "))
                    : ("Next", Theme.attention, t["note"] as? String ?? "starts when a slot is free")
                HStack(spacing: 8) {
                    Tag(text: state.0, color: state.1).frame(width: 72)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) { Text(t["key"] as? String ?? "").font(Theme.mono()); Text(t["title"] as? String ?? "").font(.system(size: 12)).lineLimit(1) }
                        if !state.2.isEmpty { Text(state.2).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                    }
                    Spacer()
                }
            }
        }.card()
    }
}
