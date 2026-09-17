import AppKit
import SwiftUI
import Darwin

private struct CommandResult { let text: String; let code: Int32 }
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

@MainActor final class FactoryModel: ObservableObject {
    static let shared = FactoryModel()
    @Published var config: [String: Any] = [:]
    @Published var draft: [String: Any] = [:]
    @Published var status: [String: Any] = [:]
    @Published var busy: String?
    @Published var error: String?
    @Published var notice: String?
    @Published var ticket = ""
    @Published var selectedModel = "auto"
    @Published var overrideLimits = true
    @Published var providers: [[String: Any]] = []
    @Published var catalogLoading = false
    @Published var catalogError: String?
    private var settingsWindow: NSWindowController?
    private var editingBase: [String: Any] = [:]
    private var timer: Timer?
    let home = FileManager.default.homeDirectoryForCurrentUser

    init() {
        Task { await reload(); await refreshModels() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
    }
    var enabled: Bool { config["enabled"] as? Bool ?? false }
    var configuredModels: [[String: Any]] { config["models"] as? [[String: Any]] ?? [] }
    var selectedPreset: [String: Any]? { configuredModels.first { $0["id"] as? String == selectedModel } }
    var selectedModelUsesCodex: Bool {
        guard let selection = selectedPreset?["model"] as? [String: Any] else { return false }
        let provider = providers.first { $0["instanceId"] as? String == selection["instanceId"] as? String }
        return provider?["driver"] as? String == "codex" || selection["instanceId"] as? String == "codex"
    }
    var jobs: [[String: Any]] { status["jobs"] as? [[String: Any]] ?? [] }
    var activeJobs: [[String: Any]] { jobs.filter { ["running", "dispatching"].contains($0["state"] as? String ?? "") } }
    var waitingJobs: Int { jobs.filter { $0["state"] as? String == "waiting" }.count }
    var decision: [String: Any] { status["decision"] as? [String: Any] ?? [:] }
    var streams: [[String: Any]] { status["streams"] as? [[String: Any]] ?? [] }
    func jobsForProvider(_ driver: String) -> [[String: Any]] {
        jobs.filter { job in
            let instance = (job["modelSelection"] as? [String: Any])?["instanceId"] as? String ?? "claudeAgent"
            return (job["providerDriver"] as? String ?? providers.first { $0["instanceId"] as? String == instance }?["driver"] as? String ?? instance) == driver
        }
    }
    func streamReason(_ driver: String) -> String {
        guard enabled else { return "Automatic starts paused" }
        let reason = streams.first { $0["driver"] as? String == driver }?["reason"] as? String ?? "Watching the queue"
        switch reason {
        case "provider-disabled": return "Automatic starts off"
        case "provider-running": return "Run limit reached"
        case "dispatched": return "Work dispatched"
        case "waiting-for-idle": return "Waiting for idle time"
        case "quota-budget": return "Waiting for available budget"
        case "no-eligible-model": return "No automatic model available"
        case "no-eligible-ticket", "watching-streams": return "No eligible classified ticket"
        case "difficulty-limit": return "No tickets within difficulty limits"
        case "needs-classification": return "Tickets need difficulty labels"
        case "would-dispatch": return "Ready to start"
        default: return reason
        }
    }
    var statusTitle: String {
        if !enabled { return "Automatic factory paused" }
        switch decision["reason"] as? String {
        case "dispatched", "autonomous-job-running": return "Factory is running"
        case "personal-Claude-running", "personal-provider-running": return "Waiting for the provider to become idle"
        case "personal-Claude-recently-active", "personal-provider-recently-active": return "Waiting for idle time"
        case "quota-reserve", "discovery-quota-reserve": return "Waiting for available quota"
        case "codex-quota-exhausted": return "Codex quota is exhausted"
        case "error": return "Factory needs attention"
        case "no-eligible-work", "no-eligible-ticket": return "No eligible tickets"
        case "waiting-cap": return "Waiting limit reached"
        default: return "Factory is watching the queue"
        }
    }
    var lastCheck: String {
        guard let at = decision["at"] as? String, let date = Self.date(at) else { return "No scheduler check yet" }
        let seconds = Int(Date().timeIntervalSince(date))
        return seconds < 120 ? "Checked \(max(0, seconds))s ago" : "Last check \(seconds / 60)m ago"
    }
    static func date(_ text: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    func refreshStatus() {
        let dir = config["stateDir"] as? String ?? home.appendingPathComponent(".local/share/t3-factory").path
        if let data = try? Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("status.json")), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { status = object }
    }
    private func execute(_ arguments: [String], input: Data? = nil) async throws -> CommandResult {
        try await Task.detached(priority: .userInitiated) { try runCLI(arguments, input: input) }.value
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
    func setEnabled(_ enabled: Bool) async {
        guard busy == nil else { return }; busy = enabled ? "Enabling factory" : "Pausing factory"; defer { busy = nil }
        do {
            let result = try await execute([enabled ? "resume" : "pause"])
            guard result.code == 0 else { throw failure(result) }
            let loaded = try await execute(["config-get"])
            if let object = jsonObject(loaded.text) { config = object; draft["enabled"] = enabled; editingBase["enabled"] = enabled }
            error = nil; notice = enabled ? "Automatic dispatch enabled" : "Paused. Existing runs continue."; refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    func dispatch() async {
        guard busy == nil else { return }; busy = "Checking and starting factory"; error = nil; notice = nil; defer { busy = nil }
        var args = ["dispatch", "--model", selectedModel]
        let key = ticket.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if !key.isEmpty { args += ["--ticket", key] }
        if overrideLimits { args.append("--override-limits") }
        do {
            let result = try await execute(args), object = jsonObject(result.text)
            guard result.code == 0, object?["reason"] as? String == "dispatched" else { throw failure(result) }
            notice = "Started \(object?["ticket"] as? String ?? "factory") with \(object?["model"] as? String ?? selectedModel)."; refreshStatus()
        } catch { self.error = error.localizedDescription; refreshStatus() }
    }
    private func failure(_ result: CommandResult) -> NSError {
        let object = jsonObject(result.text)
        let reason = object?["reason"] as? String ?? ""
        let friendly: String
        switch reason {
        case "codex-quota-exhausted": friendly = "Codex has reached its usage limit. Wait for its quota to reset or choose a Claude model."
        case "autonomous-job-running", "job-resumed-before-dispatch": friendly = "A factory run is already executing. Wait for it to finish or pause for input."
        case "personal-Claude-running", "personal-Claude-recently-active", "personal-provider-running", "personal-provider-recently-active": friendly = "The selected provider is active or has not been idle long enough. Enable the one-run override to start now."
        case "quota-reserve", "gate-changed-before-dispatch": friendly = "The current quota or activity policy blocks this run. Enable the one-run override to bypass those thresholds."
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
            config = saved; draft = saved; editingBase = saved; error = nil; notice = "Settings saved. They apply to the next dispatch."; validateModelSelection(); refreshStatus()
        } catch { self.error = error.localizedDescription }
    }
    func update(_ path: [String], _ value: Any?) { draft = replacing(draft, path, value) as? [String: Any] ?? draft; notice = nil }
    private func validateModelSelection() {
        if selectedModel != "auto" && selectedPreset == nil { selectedModel = "auto" }
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
    func openFile(_ path: String) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
}
