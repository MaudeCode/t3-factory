import AppKit
import SwiftUI
import Darwin

struct CommandResult { let text: String; let code: Int32 }
private func runCLI(_ arguments: [String], input: Data? = nil) throws -> CommandResult {
    let process = Process(), output = Pipe(), stdin = Pipe()
    process.executableURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/t3-factory")
    process.arguments = arguments
    process.environment = ProcessInfo.processInfo.environment.merging(["NODE_NO_WARNINGS": "1"]) { _, new in new }
    process.standardOutput = output; process.standardError = output; process.standardInput = stdin
    try process.run()
    let timeout = DispatchWorkItem {
        if process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 180, execute: timeout)
    if let input { try stdin.fileHandleForWriting.write(contentsOf: input) }
    try stdin.fileHandleForWriting.close()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit(); timeout.cancel()
    return CommandResult(text: String(decoding: data, as: UTF8.self), code: process.terminationStatus)
}

func jsonObject(_ text: String) -> [String: Any]? {
    if let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
    for line in text.split(separator: "\n").reversed() {
        if let data = String(line).data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
    }
    return nil
}
func prettyJSON(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
}
func valueAt(_ value: Any, _ path: [String]) -> Any? {
    guard let key = path.first else { return value }
    let next: Any?
    if let array = value as? [Any], let index = Int(key), array.indices.contains(index) { next = array[index] }
    else { next = (value as? [String: Any])?[key] }
    return next.flatMap { valueAt($0, Array(path.dropFirst())) }
}
private func replacing(_ value: Any, _ path: [String], _ new: Any?) -> Any {
    guard let key = path.first else { return new ?? NSNull() }
    if var array = value as? [Any], let index = Int(key), array.indices.contains(index) {
        array[index] = replacing(array[index], Array(path.dropFirst()), new); return array
    }
    var dict = value as? [String: Any] ?? [:]
    if path.count == 1 { dict[key] = new }
    else { dict[key] = replacing(dict[key] ?? [:], Array(path.dropFirst()), new) }
    return dict
}

// Words for durations and times, matching the web app: at most two units, minutes never carry seconds.
enum Words {
    static func date(_ text: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func span(_ seconds: Double) -> String {
        var left = max(0, seconds), parts: [String] = []
        for (name, size) in [("d", 86400.0), ("h", 3600.0), ("min", 60.0), ("s", 1.0)] {
            let n = Int(left / size)
            if n > 0 || (name == "s" && parts.isEmpty) { parts.append("\(n) \(name)") }
            left -= Double(n) * size
            if parts.count == 2 || (parts.count == 1 && name == "min") { break }
        }
        return parts.joined(separator: " ")
    }
    static func ago(_ text: String?, now: Date) -> String {
        guard let text, let date = Words.date(text) else { return "never" }
        return span(now.timeIntervalSince(date)) + " ago"
    }
    static func clock(_ text: String?) -> String {
        guard let text, let date = Words.date(text) else { return "" }
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short
        return f.string(from: date)
    }
    static func day(_ text: String?) -> String {
        guard let text, let date = Words.date(text) else { return "" }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        let f = DateFormatter(); f.dateFormat = "EEEE, MMM d"
        return f.string(from: date)
    }
    static func until(_ text: String?, now: Date) -> String {
        guard let text, let date = Words.date(text) else { return "" }
        let s = date.timeIntervalSince(now)
        return s > 0 ? "in " + span(s) : "now"
    }
}

// What the user must answer before a manual run can go ahead.
enum RunPrompt: Identifiable {
    case blocked(id: String, ticket: String, tree: [String: Any])
    case readiness(id: String, ticket: String, label: String)
    var id: String {
        switch self { case .blocked(let id, _, _), .readiness(let id, _, _): return id }
    }
}

// A prompt is only one possible result; retain the captured command and its lifecycle in the same row.
struct RunRequest: Identifiable {
    let id = UUID().uuidString
    let arguments: [String]
    var state = "queued"
    var message = "Queued"
    var prompt: RunPrompt?
    var ticket: String { arguments.firstIndex(of: "--ticket").map { arguments[$0 + 1] } ?? "Next eligible ticket" }
    var model: String { arguments.firstIndex(of: "--model").map { arguments[$0 + 1] } ?? "auto" }
}

@MainActor final class FactoryModel: ObservableObject {
    static let shared = FactoryModel()
    @Published var config: [String: Any] = [:]
    @Published var draft: [String: Any] = [:]
    @Published var status: [String: Any] = [:]
    @Published var now = Date()
    @Published var busy: String?
    @Published var error: String?
    @Published var notice: String?
    @Published var prompt: RunPrompt?
    @Published var requests: [RunRequest] = []
    private var drainingRequests = false
    @Published var ticketProject = ""
    @Published var ticketNumber = ""
    @Published var selectedModel = "auto"
    @Published var overrideLimits = true
    @Published var providers: [[String: Any]] = []
    @Published var catalogLoading = false
    @Published var catalogError: String?
    @Published var sources: [String: Any]?
    @Published var sourcesError: String?
    private var settingsWindow: NSWindowController?
    private var editingBase: [String: Any] = [:]
    private var clock: Timer?
    private var watcher: DispatchSourceFileSystemObject?
    private var watchedDir = ""
    private var pendingRefresh: DispatchWorkItem?
    private let command: (([String], Data?) async throws -> CommandResult)?
    let home = FileManager.default.homeDirectoryForCurrentUser

    init(start: Bool = true, command: (([String], Data?) async throws -> CommandResult)? = nil) {
        self.command = command
        guard start else { return }
        Task { await reload(); await refreshModels() }
        refreshStatus()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.now = Date()
                // The watcher is the live path; a slow fallback keeps the panel honest if an event is missed.
                if Int(self.now.timeIntervalSince1970) % 30 == 0 { self.refreshStatus() }
            }
        }
    }
    var stateDir: String { config["stateDir"] as? String ?? home.appendingPathComponent(".local/share/t3-factory").path }
    var enabled: Bool { status["enabled"] as? Bool ?? config["enabled"] as? Bool ?? false }
    var hasUpstream: Bool { config["upstream"] is [String: Any] }
    var upstreamEnabled: Bool { status["upstreamEnabled"] as? Bool ?? (config["upstream"] as? [String: Any])?["enabled"] as? Bool ?? false }
    var configuredModels: [[String: Any]] { config["models"] as? [[String: Any]] ?? [] }
    var projects: [[String: Any]] { config["projects"] as? [[String: Any]] ?? [] }
    var selectedPreset: [String: Any]? { configuredModels.first { $0["id"] as? String == selectedModel } }
    var selectedModelUsesCodex: Bool {
        guard let selection = selectedPreset?["model"] as? [String: Any] else { return false }
        let provider = providers.first { $0["instanceId"] as? String == selection["instanceId"] as? String }
        return provider?["driver"] as? String == "codex" || selection["instanceId"] as? String == "codex"
    }
    var jobs: [[String: Any]] { status["jobs"] as? [[String: Any]] ?? [] }
    var activeJobs: [[String: Any]] { jobs.filter { ["running", "dispatching"].contains($0["state"] as? String ?? "") }.sorted(by: newest) }
    var waitingJobs: [[String: Any]] { jobs.filter { $0["state"] as? String == "waiting" }.sorted(by: newest) }
    var decision: [String: Any] { status["decision"] as? [String: Any] ?? [:] }
    var streams: [[String: Any]] { status["streams"] as? [[String: Any]] ?? [] }
    var upNext: [String: Any]? { status["upNext"] as? [String: Any] }
    var queued: [[String: Any]] { upNext?["tickets"] as? [[String: Any]] ?? [] }
    var held: [[String: Any]] { upNext?["held"] as? [[String: Any]] ?? [] }
    var chains: [[String: Any]] { (status["plans"] as? [[String: Any]] ?? []).filter { $0["state"] as? String == "active" } }
    var journal: [[String: Any]] { status["journal"] as? [[String: Any]] ?? [] }
    var recentJobs: [[String: Any]] { status["recent"] as? [[String: Any]] ?? [] }
    var t3Projects: [[String: Any]] { sources?["t3"] as? [[String: Any]] ?? [] }
    var kaneoProjects: [[String: Any]] { (sources?["kaneo"] as? [String: Any])?["projects"] as? [[String: Any]] ?? [] }
    var workspaceLabels: [String] { (sources?["kaneo"] as? [String: Any])?["labels"] as? [String] ?? [] }
    func columns(_ kaneoId: String) -> [[String: Any]] { ((sources?["kaneo"] as? [String: Any])?["columns"] as? [String: Any])?[kaneoId] as? [[String: Any]] ?? [] }
    // The scheduler's view of a configured model on its last pass.
    func liveModelState(_ id: String) -> String {
        for s in streams {
            if let entry = (s["models"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id }) {
                let reason = entry["reason"] as? String ?? ""
                if reason == "ready", ((s["quota"] as? [String: Any])?["factoryRouting"] as? [String: Any])?["modelId"] as? String == id { return "next automatic run" }
                return Self.streamReasons[reason] ?? reason
            }
        }
        return ""
    }
    var liveConcurrency: [String: Int] {
        let limits = status["concurrency"] as? [String: Any] ?? config["concurrency"] as? [String: Any] ?? [:]
        return ["claudeAgent": (limits["claude"] as? NSNumber)?.intValue ?? 1, "codex": (limits["codex"] as? NSNumber)?.intValue ?? 1]
    }
    private func newest(_ a: [String: Any], _ b: [String: Any]) -> Bool { (a["createdAt"] as? String ?? "") > (b["createdAt"] as? String ?? "") }
    func stream(_ driver: String) -> [String: Any] { streams.first { $0["driver"] as? String == driver } ?? [:] }
    func quota(_ driver: String) -> [String: Any]? {
        let direct = decision["quota"] as? [String: Any]
        if direct?["driver"] as? String == driver { return direct }
        return stream(driver)["quota"] as? [String: Any]
    }
    func jobsForProvider(_ driver: String) -> [[String: Any]] {
        jobs.filter { job in
            let instance = (job["modelSelection"] as? [String: Any])?["instanceId"] as? String ?? "claudeAgent"
            return (job["providerDriver"] as? String ?? providers.first { $0["instanceId"] as? String == instance }?["driver"] as? String ?? instance) == driver
        }
    }
    // Facets of a ticket or run as one line: project, "P high", "D med", and its tracker labels.
    func facets(_ row: [String: Any], model: String? = nil) -> String {
        var parts = [projectName(row["projectId"] as? String), model ?? ""]
        if let priority = row["priority"] as? String, priority != "no-priority", !priority.isEmpty { parts.append("P " + priority) }
        if let difficulty = row["difficulty"] as? String, !difficulty.isEmpty { parts.append("D " + difficulty) }
        parts += (row["labels"] as? [String] ?? [])
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var projectKeys: [String] { Array(NSOrderedSet(array: projects.compactMap { $0["key"] as? String }.filter { !$0.isEmpty })) as? [String] ?? [] }
    func projectName(_ kaneoId: String?) -> String { projects.first { $0["kaneoId"] as? String == kaneoId }?["name"] as? String ?? "" }
    func modelName(_ job: [String: Any]) -> String {
        let slug = (job["modelSelection"] as? [String: Any])?["model"] as? String ?? ""
        return configuredModels.first { ($0["model"] as? [String: Any])?["model"] as? String == slug }?["name"] as? String ?? (slug.isEmpty ? "Factory" : slug)
    }
    static let streamReasons = [
        "provider-running": "working", "provider-disabled": "automatic starts off", "dispatched": "working", "waiting-for-idle": "waiting for idle time",
        "quota-exhausted": "allowance exhausted", "quota-budget": "waiting for budget", "no-eligible-model": "no automatic model available",
        "no-eligible-ticket": "watching the queue", "watching-streams": "watching the queue", "difficulty-limit": "no tickets within difficulty limits",
        "needs-classification": "tickets need difficulty labels", "would-dispatch": "ready to start",
    ]
    func streamReason(_ driver: String) -> String {
        let active = jobsForProvider(driver).contains { ["running", "dispatching"].contains($0["state"] as? String ?? "") }
        if !enabled && !active { return "paused" }
        let reason = stream(driver)["reason"] as? String ?? "watching the queue"
        return Self.streamReasons[reason] ?? reason.replacingOccurrences(of: "-", with: " ")
    }
    // One sentence for the last check, in the web app's words.
    var decisionSentence: String {
        guard let reason = decision["reason"] as? String else { return "No check has run yet." }
        switch reason {
        case "disabled": return ""
        case "error": return "The last check failed: \(decision["message"] as? String ?? "unknown error")"
        case "dispatched": return "Started \(decision["ticket"] as? String ?? (decision["project"] as? String).map { "discovery for \($0)" } ?? "a run") on \(decision["model"] as? String ?? "the assigned model")."
        default:
            let eligible = (decision["eligible"] as? NSNumber)?.intValue ?? 0
            return eligible > 0 ? "\(eligible) ticket\(eligible == 1 ? "" : "s") eligible." : "Nothing eligible to start."
        }
    }
    var lastCheck: String { decision["at"] == nil ? "no check yet" : "checked " + Words.ago(decision["at"] as? String, now: now) }
    func refreshStatus() {
        let dir = stateDir
        if let data = try? Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("status.json")), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { status = object }
        if dir != watchedDir { watch(dir) }
    }
    // The scheduler replaces status.json atomically, so the directory reports the change.
    private func watch(_ dir: String) {
        watcher?.cancel(); watcher = nil
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return }
        watchedDir = dir
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .attrib], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.pendingRefresh?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.refreshStatus() }
            self.pendingRefresh = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        watcher = source
    }
    private func execute(_ arguments: [String], input: Data? = nil) async throws -> CommandResult {
        if let command { return try await command(arguments, input) }
        return try await Task.detached(priority: .userInitiated) { try runCLI(arguments, input: input) }.value
    }
    func refreshModels() async {
        guard !catalogLoading else { return }
        catalogLoading = true; defer { catalogLoading = false }
        do {
            let result = try await execute(["model-catalog"])
            guard result.code == 0, let list = jsonObject(result.text)?["providers"] as? [[String: Any]] else { throw failure(result) }
            providers = list; catalogError = nil
        } catch { catalogError = error.localizedDescription }
    }
    func refreshSources(force: Bool = false) async {
        guard force || sources == nil else { return }
        do {
            let result = try await execute(["sources"])
            guard result.code == 0, let object = jsonObject(result.text) else { throw failure(result) }
            sources = object; sourcesError = nil
        } catch { sourcesError = error.localizedDescription }
    }
    // A project starts from what T3 and Kaneo already know about it; everything stays editable.
    func addProject(t3: [String: Any]?, kaneo: [String: Any]?) -> Int {
        var items = draft["projects"] as? [[String: Any]] ?? []
        let kaneoId = kaneo?["id"] as? String ?? ""
        let root = t3?["workspaceRoot"] as? String ?? ""
        let parts = root.split(separator: "/")
        let guessed = parts.count >= 4 ? "\(parts[parts.count - 2])/\(parts[parts.count - 1])" : ""
        items.append(["name": t3?["title"] as? String ?? kaneo?["name"] as? String ?? "New project", "enabled": false, "key": kaneo?["slug"] as? String ?? "", "kaneoId": kaneoId, "t3Id": t3?["id"] as? String ?? "",
                      "repoPath": root, "githubRepo": kaneo?["githubRepo"] as? String ?? guessed, "baseBranch": "main", "priorityLabels": [], "upstreams": []].merging(statuses(for: kaneoId)) { _, b in b })
        update(["projects"], items)
        return items.count - 1
    }
    // Ready is the first column, done is every final column, when the Kaneo catalog knows the project.
    func statuses(for kaneoId: String) -> [String: Any] {
        let cols = columns(kaneoId)
        guard !cols.isEmpty else { return ["readyStatuses": ["to-do"], "doneStatuses": ["done"]] }
        let done = cols.filter { $0["isFinal"] as? Bool == true }.compactMap { $0["slug"] as? String }
        return ["readyStatuses": [cols.first { $0["isFinal"] as? Bool != true }?["slug"] as? String ?? cols[0]["slug"] as? String ?? "to-do"], "doneStatuses": done.isEmpty ? [cols.last?["slug"] as? String ?? "done"] : done]
    }
    func linkT3(_ index: Int, id: String) {
        let project = t3Projects.first { $0["id"] as? String == id }
        update(["projects", String(index), "t3Id"], id)
        if let root = project?["workspaceRoot"] as? String { update(["projects", String(index), "repoPath"], root) }
    }
    func linkKaneo(_ index: Int, id: String) {
        let project = kaneoProjects.first { $0["id"] as? String == id }
        update(["projects", String(index), "kaneoId"], id)
        if let slug = project?["slug"] as? String { update(["projects", String(index), "key"], slug) }
        for (key, value) in statuses(for: id) { update(["projects", String(index), key], value) }
    }
    func stringList(_ path: [String]) -> Binding<[String]> { Binding(get: { valueAt(self.draft, path) as? [String] ?? [] }, set: { self.update(path, $0) }) }
    func availableModels(_ instanceId: String) -> [[String: Any]] {
        providers.first { $0["instanceId"] as? String == instanceId }?["models"] as? [[String: Any]] ?? []
    }
    func modelOptions(_ path: [String]) -> [[String: Any]] {
        let instance = valueAt(draft, path + ["instanceId"]) as? String ?? ""
        let slug = valueAt(draft, path + ["model"]) as? String ?? ""
        let selected = availableModels(instance).first { $0["slug"] as? String == slug }
        return (selected?["capabilities"] as? [String: Any])?["optionDescriptors"] as? [[String: Any]] ?? []
    }
    func moveModels(from offsets: IndexSet, to destination: Int) {
        var models = draft["models"] as? [[String: Any]] ?? []
        models.move(fromOffsets: offsets, toOffset: destination)
        update(["models"], models)
    }
    func selectModel(_ slug: String, path: [String]) {
        guard valueAt(draft, path + ["model"]) as? String != slug else { return }
        update(path + ["model"], slug)
        if path.first == "models", path.count == 3 {
            update(Array(path.prefix(2)) + ["quotaWindowId"], slug.contains("fable") ? "seven_day_fable" : nil)
        }
        let options: [[String: Any]] = modelOptions(path).compactMap { descriptor in
            guard let id = descriptor["id"] as? String,
                  let choices = descriptor["options"] as? [[String: Any]],
                  let value = choices.first(where: { $0["isDefault"] as? Bool == true })?["id"] ?? descriptor["currentValue"] else { return nil }
            return ["id": id, "value": value]
        }
        update(path + ["options"], options)
    }
    func selectProvider(_ instance: String, path: [String]) {
        guard valueAt(draft, path + ["instanceId"]) as? String != instance || (valueAt(draft, path + ["model"]) as? String ?? "").isEmpty else { return }
        update(path + ["instanceId"], instance)
        let models = availableModels(instance)
        selectModel((models.first { $0["isDefault"] as? Bool == true } ?? models.first)?["slug"] as? String ?? "", path: path)
    }
    func option(_ path: [String], id: String, fallback: String) -> Binding<String> {
        Binding(get: { (valueAt(self.draft, path + ["options"]) as? [[String: Any]] ?? []).first { $0["id"] as? String == id }?["value"] as? String ?? fallback }, set: { value in
            var options = valueAt(self.draft, path + ["options"]) as? [[String: Any]] ?? []
            options.removeAll { $0["id"] as? String == id }; options.append(["id": id, "value": value]); self.update(path + ["options"], options)
        })
    }
    func reload() async {
        guard busy == nil else { return }; busy = "Loading settings"; defer { busy = nil }
        do {
            let result = try await execute(["config-get"])
            guard result.code == 0, let object = jsonObject(result.text) else { throw failure(result) }
            config = object; draft = object; editingBase = object; error = nil; validateModelSelection(); refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    // Both switches save immediately; the saved value is mirrored into the settings draft so it does not look edited.
    func setEnabled(_ enabled: Bool, upstream: Bool = false) async {
        guard busy == nil else { return }
        busy = upstream ? (enabled ? "Enabling upstream reviews" : "Pausing upstream reviews") : (enabled ? "Enabling factory" : "Pausing factory"); defer { busy = nil }
        do {
            let result = try await execute([(upstream ? "upstream-" : "") + (enabled ? "resume" : "pause")])
            guard result.code == 0 else { throw failure(result) }
            let loaded = try await execute(["config-get"])
            if let object = jsonObject(loaded.text) {
                config = object
                if !upstream { draft["enabled"] = enabled; editingBase["enabled"] = enabled }
                else {
                    if var section = draft["upstream"] as? [String: Any] { section["enabled"] = enabled; draft["upstream"] = section }
                    if var section = editingBase["upstream"] as? [String: Any] { section["enabled"] = enabled; editingBase["upstream"] = section }
                }
            }
            error = nil
            notice = upstream ? (enabled ? "Upstream reviews on" : "Upstream reviews paused. Running reviews continue.") : (enabled ? "Automation on" : "Paused. Running work continues.")
            refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    // Accept immediately, before awaiting the serialized command drain, and leave newer drafts alone.
    func dispatch() async {
        guard !config.isEmpty else { return }
        var args = ["dispatch", "--model", selectedModel]
        let number = ticketNumber.trimmingCharacters(in: .whitespaces)
        guard number.isEmpty || number.allSatisfy(\.isNumber) else { error = "Ticket number must be digits only."; return }
        if !number.isEmpty {
            guard !ticketProject.isEmpty else { error = "Choose a project key before naming a ticket."; return }
            args += ["--ticket", "\(ticketProject)-\(number)"]
        }
        if overrideLimits { args.append("--override-limits") }
        requests.append(RunRequest(arguments: args))
        ticketNumber = ""
        await drainRequests()
    }
    func answer(_ prompt: RunPrompt, with extra: [String]) async {
        guard let index = requests.firstIndex(where: { $0.id == prompt.id }), requests[index].prompt != nil else { return }
        let args = requests[index].arguments + extra
        requests.remove(at: index)
        if self.prompt?.id == prompt.id { self.prompt = nil }
        requests.append(RunRequest(arguments: args))
        await drainRequests()
    }
    func dismissRequest(_ id: String) {
        requests.removeAll { $0.id == id && !["queued", "running"].contains($0.state) }
        if prompt?.id == id { prompt = nil }
    }
    private func drainRequests() async {
        guard !drainingRequests else { return }
        drainingRequests = true
        defer { drainingRequests = false }
        while let index = requests.firstIndex(where: { $0.state == "queued" }) {
            requests[index].state = "running"
            requests[index].message = "Checking the ticket and starting its T3 run"
            await send(requests[index])
        }
    }
    private func send(_ request: RunRequest) async {
        let args = request.arguments
        var resultPrompt: RunPrompt?
        let message: String
        do {
            let result = try await execute(args), object = jsonObject(result.text) ?? [:]
            switch object["reason"] as? String {
            case "dispatched", "plan-started":
                requests.removeAll { $0.id == request.id }
                refreshStatus(); return
            case "blocked-ticket-plan-required":
                message = "Choose how to run this chain."
                resultPrompt = .blocked(id: request.id, ticket: object["ticket"] as? String ?? request.ticket, tree: object["tree"] as? [String: Any] ?? [:])
            case "ready-label-confirmation-required":
                message = "Readiness confirmation required."
                resultPrompt = .readiness(id: request.id, ticket: object["ticket"] as? String ?? request.ticket, label: object["requiredLabel"] as? String ?? "ready")
            default: throw failure(result)
            }
        } catch {
            if let index = requests.firstIndex(where: { $0.id == request.id }) {
                requests[index].state = "error"; requests[index].message = error.localizedDescription
            }
            refreshStatus(); return
        }
        if let index = requests.firstIndex(where: { $0.id == request.id }) {
            requests[index].state = "done"; requests[index].message = message; requests[index].prompt = resultPrompt
        }
        refreshStatus()
    }
    func stop(_ job: [String: Any]) async {
        guard busy == nil, let id = job["id"] as? String else { return }; busy = "Stopping"; defer { busy = nil }
        do {
            let result = try await execute(["job-stop", id])
            guard result.code == 0 else { throw failure(result) }
            notice = "Stop requested. T3 confirms on the next check."; error = nil; refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    func cancelChain(_ plan: [String: Any]) async {
        guard busy == nil, let id = plan["id"] as? String else { return }; busy = "Cancelling chain"; defer { busy = nil }
        do {
            let result = try await execute(["plan-cancel", id])
            guard result.code == 0 else { throw failure(result) }
            notice = "Chain cancelled. Tickets already running finish on their own."; error = nil; refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    private func failure(_ result: CommandResult) -> NSError {
        let object = jsonObject(result.text)
        let reason = object?["reason"] as? String ?? ""
        let friendly: String
        switch reason {
        case "quota-exhausted": friendly = "The selected model has no allowance left. Choose another model or wait for its quota to reset."
        case "codex-quota-exhausted": friendly = "Codex has reached its usage limit. Wait for its quota to reset or choose a Claude model."
        case "autonomous-job-running", "job-resumed-before-dispatch": friendly = "A factory run is already executing. Wait for it to finish or pause for input."
        case "personal-Claude-running", "personal-Claude-recently-active", "personal-provider-running", "personal-provider-recently-active": friendly = "The selected provider is active or has not been idle long enough. Turn on the override to start now."
        case "quota-reserve", "gate-changed-before-dispatch": friendly = "The current quota or activity policy blocks this run. Turn on the override to bypass those thresholds."
        case "chain-nothing-runnable": friendly = object?["message"] as? String ?? "Nothing in the chain can start right now."
        case "no-eligible-ticket":
            let skipped = object?["skipped"] as? [[String: Any]] ?? []
            friendly = skipped.first?["reason"] as? String ?? object?["message"] as? String ?? "No eligible ticket was found."
        default: friendly = object?["message"] as? String ?? (result.text.isEmpty ? "Factory command failed or timed out. Check status before retrying." : result.text)
        }
        return NSError(domain: "T3Factory", code: Int(result.code), userInfo: [NSLocalizedDescriptionKey: friendly])
    }
    func save() async {
        guard busy == nil else { return }; busy = "Saving settings"; defer { busy = nil }
        do {
            let input = try JSONSerialization.data(withJSONObject: ["base": editingBase, "config": draft])
            let result = try await execute(["config-save"], input: input)
            guard result.code == 0, let saved = jsonObject(result.text) else { throw failure(result) }
            config = saved; draft = saved; editingBase = saved; error = nil; notice = "Saved. New runs use these settings."; validateModelSelection(); refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    func update(_ path: [String], _ value: Any?) { draft = replacing(draft, path, value) as? [String: Any] ?? draft; notice = nil }
    private func validateModelSelection() {
        if selectedModel != "auto" && selectedPreset == nil { selectedModel = "auto" }
        if !projectKeys.contains(ticketProject) { ticketProject = projectKeys.first ?? "" }
    }
    func string(_ path: [String]) -> Binding<String> { Binding(get: { valueAt(self.draft, path) as? String ?? "" }, set: { self.update(path, $0) }) }
    func bool(_ path: [String]) -> Binding<Bool> { Binding(get: { valueAt(self.draft, path) as? Bool ?? false }, set: { self.update(path, $0) }) }
    func number(_ path: [String], fallback: Double = 0) -> Binding<Double> { Binding(get: { (valueAt(self.draft, path) as? NSNumber)?.doubleValue ?? fallback }, set: { self.update(path, $0) }) }
    func strings(_ path: [String]) -> Binding<String> { Binding(get: { (valueAt(self.draft, path) as? [String] ?? []).joined(separator: ", ") }, set: { self.update(path, $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }) }) }
    func openSettings() {
        (NSApp.delegate as? FactoryAppDelegate)?.closePopover()
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "T3 Factory Settings"; window.contentView = NSHostingView(rootView: FactorySettingsView(model: self)); window.center(); window.isReleasedWhenClosed = false
            settingsWindow = NSWindowController(window: window)
        }
        settingsWindow?.showWindow(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func choosePath(_ path: [String], directory: Bool) {
        guard let window = settingsWindow?.window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directory; panel.canChooseFiles = !directory; panel.allowsMultipleSelection = false
        if let current = valueAt(draft, path) as? String, !current.isEmpty { panel.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent() }
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK, let url = panel.url { self?.update(path, url.path) }
        }
    }
    func openT3() {
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.t3tools.t3code") { NSWorkspace.shared.open(app); return }
        if let url = URL(string: (config["t3"] as? [String: Any])?["url"] as? String ?? "http://127.0.0.1:3773") { NSWorkspace.shared.open(url) }
    }
    func openThread(_ job: [String: Any]) {
        guard let id = job["threadId"] as? String, let url = URL(string: "t3-thread://v1/\(id)") else { openT3(); return }
        NSWorkspace.shared.open(url)
    }
    // Without a task this opens the project.
    func openTicket(_ projectId: String?, taskId: String?) {
        guard let kaneo = config["kaneo"] as? [String: Any], let base = kaneo["url"] as? String, let workspace = kaneo["workspaceId"] as? String, let projectId,
              let url = URL(string: "\(base)/dashboard/workspace/\(workspace)/project/\(projectId)" + (taskId.map { "/task/\($0)" } ?? "")) else { return }
        NSWorkspace.shared.open(url)
    }
    func openPullRequest(_ job: [String: Any]) {
        guard let url = (job["prUrls"] as? [String])?.first.flatMap(URL.init) else { return }
        NSWorkspace.shared.open(url)
    }
    func openFile(_ path: String) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
    func openURL(_ text: String) { if let url = URL(string: text) { NSWorkspace.shared.open(url) } }
}
