import AppKit
import SwiftUI

enum FactoryIcon {
    static let image: NSImage = {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let shape = NSBezierPath()
            shape.move(to: NSPoint(x: 1.5, y: 1.5))
            shape.line(to: NSPoint(x: 16.5, y: 1.5))
            shape.curve(to: NSPoint(x: 17, y: 2), controlPoint1: NSPoint(x: 16.8, y: 1.5), controlPoint2: NSPoint(x: 17, y: 1.7))
            shape.line(to: NSPoint(x: 16.8, y: 15.8))
            shape.curve(to: NSPoint(x: 16.3, y: 16.3), controlPoint1: NSPoint(x: 16.8, y: 16.1), controlPoint2: NSPoint(x: 16.6, y: 16.3))
            shape.line(to: NSPoint(x: 14.1, y: 16.3))
            shape.curve(to: NSPoint(x: 13.6, y: 15.8), controlPoint1: NSPoint(x: 13.8, y: 16.3), controlPoint2: NSPoint(x: 13.6, y: 16.1))
            shape.line(to: NSPoint(x: 13.4, y: 8.7))
            shape.line(to: NSPoint(x: 12.2, y: 8.7))
            shape.line(to: NSPoint(x: 12.2, y: 11.3))
            shape.curve(to: NSPoint(x: 11.6, y: 11.8), controlPoint1: NSPoint(x: 12.2, y: 11.8), controlPoint2: NSPoint(x: 11.9, y: 12))
            shape.line(to: NSPoint(x: 6.5, y: 8.7))
            shape.line(to: NSPoint(x: 6.5, y: 11.3))
            shape.curve(to: NSPoint(x: 5.9, y: 11.8), controlPoint1: NSPoint(x: 6.5, y: 11.8), controlPoint2: NSPoint(x: 6.2, y: 12))
            shape.line(to: NSPoint(x: 1.3, y: 8.9))
            shape.curve(to: NSPoint(x: 1, y: 8.4), controlPoint1: NSPoint(x: 1.1, y: 8.8), controlPoint2: NSPoint(x: 1, y: 8.6))
            shape.line(to: NSPoint(x: 1, y: 2))
            shape.curve(to: NSPoint(x: 1.5, y: 1.5), controlPoint1: NSPoint(x: 1, y: 1.7), controlPoint2: NSPoint(x: 1.2, y: 1.5))
            shape.close()
            for x in [3.1, 7.8, 12.5] {
                shape.append(NSBezierPath(roundedRect: NSRect(x: x, y: 4, width: 2.4, height: 2.4), xRadius: 0.25, yRadius: 0.25))
            }
            shape.windingRule = .evenOdd
            NSColor.black.setFill()
            shape.fill()
            return true
        }
        image.isTemplate = true
        return image
    }()
}

@MainActor final class FactoryAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit T3 Factory", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; menu.addItem(appItem)
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: ""); editItem.submenu = editMenu; menu.addItem(editItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: ""); windowItem.submenu = windowMenu; menu.addItem(windowItem)
        NSApp.mainMenu = menu
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = FactoryIcon.image
        item.button?.setAccessibilityLabel("T3 Factory")
        item.button?.toolTip = "T3 Factory · Right-click for Settings"
        item.button?.target = self
        item.button?.action = #selector(openFromStatusBar(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: FactoryMenuView(model: FactoryModel.shared).frame(height: 600))
        // AppKit must position the full panel, not its default 320×320 content size.
        popover.contentSize = NSSize(width: 370, height: 600)
        if !UserDefaults.standard.bool(forKey: "openedSettings") || ProcessInfo.processInfo.arguments.contains("--settings") {
            FactoryModel.shared.openSettings()
            UserDefaults.standard.set(true, forKey: "openedSettings")
        }
    }
    @objc private func openFromStatusBar(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp || NSApp.currentEvent?.modifierFlags.contains(.control) == true {
            FactoryModel.shared.openSettings()
        } else if popover.isShown {
            closePopover()
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        }
    }
    func closePopover() { popover.performClose(nil) }
    @objc private func showSettings() { FactoryModel.shared.openSettings() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        FactoryModel.shared.openSettings(); return true
    }
}
@main enum T3FactoryMenuApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = FactoryAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

struct FactoryMenuView: View {
    @ObservedObject var model: FactoryModel
    var compact = true
    @State private var chooseTicket = false
    var body: some View {
        ScrollView {
            if compact {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Label { Text("T3 Factory") } icon: { Image(nsImage: FactoryIcon.image) }.font(.headline)
                        Spacer()
                        refreshButton
                    }
                    status
                    Divider()
                    runControls
                    Divider()
                    HStack {
                        Button("Settings…") { model.openSettings() }
                        Spacer()
                        Button("Open T3") { model.openT3() }
                        Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("Quit menu app; the factory service keeps running").accessibilityLabel("Quit menu app")
                    }.buttonStyle(.borderless)
                }.padding(18)
            } else {
                HStack(alignment: .top, spacing: 24) {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack { Text("Live status").font(.headline); Spacer(); refreshButton }
                        status
                        Button("Open T3") { model.openT3() }
                    }.frame(width: 210)
                    Divider().frame(minHeight: 320)
                    runControls.frame(maxWidth: .infinity, alignment: .leading)
                }.padding(24)
            }
        }.frame(width: compact ? 370 : nil).disabled(model.busy != nil)
            .onAppear { chooseTicket = !model.ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    private var refreshButton: some View {
        Button { model.refreshStatus() } label: { Image(systemName: "arrow.clockwise") }.help("Refresh status").accessibilityLabel("Refresh status").buttonStyle(.plain)
    }
    private var status: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle("Automatic factory", isOn: Binding(get: { model.enabled }, set: { value in Task { await model.setEnabled(value) } })).toggleStyle(.switch)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.statusTitle).font(.subheadline.weight(.medium))
                Text(model.lastCheck).font(.caption).foregroundStyle(.secondary)
                HStack { Text("\(model.activeJobs.count) executing"); Text("·"); Text("\(model.waitingJobs) awaiting input") }.font(.caption).foregroundStyle(.secondary)
            }
            ForEach(["claudeAgent", "codex"], id: \.self) { driver in
                let jobs = model.jobsForProvider(driver)
                let active = jobs.filter { ["running", "dispatching"].contains($0["state"] as? String ?? "") }
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(driver == "codex" ? "Codex" : "Claude").font(.subheadline.weight(.medium))
                        Spacer()
                        Text("\(active.count) running · \(jobs.filter { $0["state"] as? String == "waiting" }.count) waiting").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(model.streamReason(driver)).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(active.enumerated()), id: \.offset) { _, job in Text(job["label"] as? String ?? job["ticketKey"] as? String ?? "Discovery").font(.caption.monospaced()) }
                    let directQuota = model.decision["quota"] as? [String: Any] ?? [:]
                    let providerName = driver == "codex" ? "Codex" : "Claude"
                    let quota = directQuota["provider"] as? String == providerName ? directQuota : model.streams.first { $0["driver"] as? String == driver }?["quota"] as? [String: Any] ?? [:]
                    if let routing = quota["factoryRouting"] as? [String: Any], let remaining = routing["fableRemainingPercent"] as? Double {
                        quotaRow("Fable weekly", remaining: remaining)
                    }
                    ForEach(Array((quota["windows"] as? [[String: Any]] ?? []).enumerated()), id: \.offset) { _, window in
                        quotaRow(window["name"] as? String == "fiveHour" ? "Five-hour allowance" : "Weekly allowance", remaining: window["remaining"] as? Double ?? 0)
                    }
                }
            }
        }
    }
    private var runControls: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Start a run").font(.headline)
            Picker("Ticket", selection: $chooseTicket) {
                Text("Next eligible ticket").tag(false)
                Text("Choose a ticket…").tag(true)
            }.onChange(of: chooseTicket) { _, specific in if !specific { model.ticket = "" } }
            if chooseTicket {
                TextField("e.g. APP-123", text: $model.ticket).textFieldStyle(.roundedBorder).accessibilityLabel("Ticket key")
            }
            Picker("Model", selection: $model.selectedModel) {
                Text("Automatic selection").tag("auto")
                ForEach(Array(model.configuredModels.enumerated()), id: \.offset) { _, preset in
                    Text(preset["name"] as? String ?? "Manual model").tag(preset["id"] as? String ?? "")
                }
            }
            if model.selectedModelUsesCodex {
                Text("This manual run uses Codex quota. Idle time and reserved allowance do not apply.").font(.caption).foregroundStyle(.secondary)
            } else {
                Toggle("Start without waiting for idle or reserves", isOn: $model.overrideLimits).font(.caption)
                Text("For this run only. Ticket readiness, merge rules, and Claude’s limits still apply.").font(.caption).foregroundStyle(.secondary)
            }
            Button { Task { await model.dispatch() } } label: {
                Label(chooseTicket ? "Run ticket now" : "Run next ticket now", systemImage: "play.fill").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.config.isEmpty || (chooseTicket && model.ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            if !model.activeJobs.isEmpty { Text("Manual runs can start alongside existing work. Each ticket gets its own thread and worktree.").font(.caption).foregroundStyle(.secondary) }
            feedback
        }
    }
    private func quotaRow(_ title: String, remaining: Double) -> some View {
        VStack(spacing: 4) {
            HStack { Text(title); Spacer(); Text("\(Int(remaining))% remaining").monospacedDigit() }.font(.caption)
            ProgressView(value: max(0, min(100, remaining)), total: 100).tint(remaining < 15 ? .orange : .accentColor)
        }
    }
    @ViewBuilder private var feedback: some View {
        if let busy = model.busy { HStack { ProgressView().controlSize(.small); Text(busy).font(.caption) } }
        if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        else if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
    }
}
