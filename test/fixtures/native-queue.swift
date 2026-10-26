import AppKit
import SwiftUI

@main enum NativeQueueFixture {
    @MainActor static func main() async {
        let dir = CommandLine.arguments[1]
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        var calls: [[String]] = []
        var held: CheckedContinuation<Void, Never>?
        let model = FactoryModel(start: false) { args, _ in
            calls.append(args)
            if calls.count == 1 { await withCheckedContinuation { held = $0 } }
            let ticket = args[args.firstIndex(of: "--ticket")! + 1]
            if ticket == "APP-4" {
                let id = args[args.firstIndex(of: "--request-id")! + 1]
                let operation = ["state": "running", "progress": ["phase": "launching", "stage": "t3.launch"]] as [String: Any]
                try! JSONSerialization.data(withJSONObject: operation).write(to: URL(fileURLWithPath: dir).appendingPathComponent("web-requests/\(id).json"), options: .atomic)
                throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "CLI response lost after acceptance"])
            }
            let reason: String
            if args.contains("--chain") { reason = "plan-started" }
            else if args.contains("--allow-missing-ready-label") { reason = "dispatched" }
            else if ticket == "APP-1" { reason = "ready-label-confirmation-required" }
            else if ticket == "APP-2" { throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fixture refusal"]) }
            else { reason = "blocked-ticket-plan-required" }
            let object: [String: Any] = ["reason": reason, "ticket": ticket, "model": "sol", "requiredLabel": "sf", "tree": ["tickets": []]]
            let id = args[args.firstIndex(of: "--request-id")! + 1]
            try! JSONSerialization.data(withJSONObject: ["state": "done", "result": ["code": 0, "data": object]]).write(to: URL(fileURLWithPath: dir).appendingPathComponent("web-requests/\(id).json"), options: .atomic)
            return CommandResult(text: String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self), code: 0)
        }
        model.config = ["stateDir": dir, "models": ["auto", "sol", "opus", "changed"].map { ["id": $0, "name": $0 == "changed" ? "Sol" : $0.capitalized] }]
        model.ticketProject = "APP"; model.ticketNumber = "1"; model.selectedModel = "sol"; model.overrides = []
        let first = Task { await model.dispatch() }
        while held == nil { await Task.yield() }
        model.ticketProject = "APP"; model.ticketNumber = "2"; model.selectedModel = "opus"; model.overrides = Set(FactoryModel.overrideLimits.map(\.0))
        await model.dispatch()
        model.ticketProject = "APP"; model.ticketNumber = "3"; model.selectedModel = "auto"; model.overrides = ["labels"]
        await model.dispatch()
        model.ticketProject = "APP"; model.ticketNumber = "99"; model.selectedModel = "changed"
        precondition(calls.count == 1, "Only one command may be in flight")
        precondition(model.requests.map { $0.ticket } == ["APP-1", "APP-2", "APP-3"], "Every accepted request has a row")
        precondition(model.requests.map { $0.state } == ["running", "queued", "queued"], "Rows show queue state")
        if let artifacts = ProcessInfo.processInfo.environment["T3_FACTORY_TEST_ARTIFACTS"] {
            FactoryRender.write(FactoryPanel(model: model, compact: false), size: NSSize(width: 780, height: 940), to: "\(artifacts)/native-queue.png")
        }
        let operations = URL(fileURLWithPath: dir).appendingPathComponent("web-requests")
        try! FileManager.default.createDirectory(at: operations, withIntermediateDirectories: true)
        let operation = operations.appendingPathComponent("\(model.requests[0].id).json")
        func progress(_ phase: String, _ stage: String) {
            let data = try! JSONSerialization.data(withJSONObject: ["state": "running", "progress": ["phase": phase, "stage": stage]])
            try! data.write(to: operation, options: .atomic); model.refreshStatus()
        }
        progress("queued", "queued")
        precondition(model.requests[0].message == "Queued at scheduler", "Native row must distinguish accepted queue wait")
        progress("checking", "kanvil.get_task")
        precondition(model.requests[0].message == "Checking · kanvil.get_task", "Native row names its current integration")
        if let artifacts = ProcessInfo.processInfo.environment["T3_FACTORY_TEST_ARTIFACTS"] {
            FactoryRender.write(FactoryPanel(model: model, compact: false), size: NSSize(width: 780, height: 940), to: "\(artifacts)/native-progress.png")
        }
        let restored = FactoryModel(start: false) { _, _ in preconditionFailure("Restoration must never resend an accepted request") }
        restored.config = model.config; restored.restoreRequests()
        precondition(restored.requests.map { $0.id } == model.requests.map { $0.id }, "Restoration retains stable request IDs")
        precondition(restored.requests[1].state == "queued", "Unsent local queue entries remain queued")
        held?.resume(); await first.value
        for _ in 0..<1000 where calls.count < 3 { await Task.yield() }
        let tickets = calls.map { args in args[args.firstIndex(of: "--ticket")! + 1] }
        precondition(tickets == ["APP-1", "APP-2", "APP-3"], "Later native submissions must be accepted while A is checking: \(tickets)")
        precondition(calls[1].contains("opus") && calls[1].contains("--override-limits"), "Queued choices are captured")
        precondition(Array(calls[2].dropLast(2).suffix(2)) == ["--override", "labels"] && model.requests[2].limits == "Override label limits", "A partial override names each limit")
        precondition(model.ticketNumber == "99", "Completion must preserve a newer draft")
        precondition(model.requests.map { $0.state } == ["done", "error", "done"], "A refusal does not strand later requests")
        let readiness = model.requests[0].prompt!, chain = model.requests[2].prompt!
        model.prompt = readiness; model.prompt = nil // Cancel keeps the originating row available.
        precondition(calls.count == 3, "Cancel cannot dispatch")
        await model.answer(readiness, with: ["--allow-missing-ready-label"])
        await model.answer(readiness, with: ["--allow-missing-ready-label"])
        await model.answer(chain, with: ["--chain", "all"])
        precondition(calls.count == 5, "Each answer is accepted at most once")
        precondition(calls[3].contains("APP-1") && calls[3].contains("sol") && !calls[3].contains("--override-limits"), "Readiness keeps A's choices")
        precondition(calls[4].contains("APP-3") && calls[4].contains("auto") && calls[4].contains("all"), "Chain choice keeps C's choices")
        precondition(model.ticketNumber == "99", "Answers must preserve a newer draft")
        if let artifacts = ProcessInfo.processInfo.environment["T3_FACTORY_TEST_ARTIFACTS"] {
            FactoryRender.write(FactoryPanel(model: model, compact: false), size: NSSize(width: 780, height: 1100), to: "\(artifacts)/native-results.png")
        }
        precondition(model.requests.count == 1, "Confirmed runs and chains must leave the visible queue")
        precondition(model.requests.allSatisfy { $0.prompt == nil }, "Answered choices remain retired")
        model.dismissRequest(chain.id)
        await model.answer(chain, with: ["--chain", "first"])
        precondition(calls.count == 5, "A stale prompt cannot dispatch")
        model.ticketProject = "APP"; model.ticketNumber = "4"
        await model.dispatch()
        let lost = model.requests.last!
        if let artifacts = ProcessInfo.processInfo.environment["T3_FACTORY_TEST_ARTIFACTS"] {
            FactoryRender.write(FactoryPanel(model: model, compact: false), size: NSSize(width: 780, height: 940), to: "\(artifacts)/native-lost-response.png")
        }
        precondition(lost.state == "running" && lost.message == "Starting T3 run", "A lost CLI response must keep reconciling accepted scheduler progress")
        precondition(restored.requests[0].state == "running" && restored.requests[0].message == "Checking · kanvil.get_task", "Accepted work takes its state from the scheduler without replay")
        model.refreshRequestProgress()
        precondition(calls.count == 6 && model.requests.last!.id == lost.id, "Accepted requests are never resent after local CLI failure")
        model.config["projects"] = [["key": "APP", "enabled": true], ["key": "T3F", "enabled": true], ["key": "OFF", "enabled": false]]
        for (text, expected) in [("T3F-48", "T3F-48"), ("app-7", "APP-7"), ("XYZ-12", "APP-12"), ("OFF-3", "APP-3"), (" 42 ", "APP-42"), ("12T3F-48", "T3F-48")] {
            model.ticketProject = "APP"; model.takeTicketInput(text)
            precondition("\(model.ticketProject)-\(model.ticketNumber)" == expected, "Pasting \(text) must name \(expected)")
        }
        print("Native queue passed")
    }
}
