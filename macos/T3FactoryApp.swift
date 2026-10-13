import AppKit
import SwiftUI
import Combine

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
    private var badge: AnyCancellable?
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
        popover.contentViewController = NSHostingController(rootView: FactoryPanel(model: FactoryModel.shared))
        // AppKit must position the full panel, not its default 320×320 content size.
        popover.contentSize = NSSize(width: 400, height: 700)
        // Runs that need you show as a count beside the icon.
        badge = FactoryModel.shared.$status.receive(on: DispatchQueue.main).sink { [weak self] _ in
            let waiting = FactoryModel.shared.waitingJobs.count
            self?.statusItem?.button?.title = waiting > 0 ? " \(waiting)" : ""
            self?.statusItem?.button?.imagePosition = .imageLeading
            self?.statusItem?.length = waiting > 0 ? NSStatusItem.variableLength : NSStatusItem.squareLength
        }
        // `--render DIR` draws the panel and every window page to PNG files and quits, for review without screen recording.
        if let at = ProcessInfo.processInfo.arguments.firstIndex(of: "--render"), ProcessInfo.processInfo.arguments.indices.contains(at + 1) {
            let dir = ProcessInfo.processInfo.arguments[at + 1]
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await FactoryModel.shared.refreshSources()
                FactoryRender.all(to: dir); NSApp.terminate(nil)
            }
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--panel"), let button = item.button {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
        } else if !UserDefaults.standard.bool(forKey: "openedSettings") || ProcessInfo.processInfo.arguments.contains("--settings") {
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



enum FactoryRender {
    @MainActor static func all(to dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        write(FactoryPanel(model: FactoryModel.shared), size: NSSize(width: 420, height: 720), to: "\(dir)/panel.png")
        for page in ["factory", "runs", "activity", "models", "capacity", "projects", "upstream"] {
            write(FactorySettingsView(model: FactoryModel.shared, page: page), size: NSSize(width: 1100, height: 820), to: "\(dir)/\(page).png")
        }
    }
    @MainActor static func write<V: View>(_ view: V, size: NSSize, to path: String) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.appearance = NSAppearance(named: .darkAqua)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        if let data = rep.representation(using: .png, properties: [:]) { try? data.write(to: URL(fileURLWithPath: path)) }
    }
}
