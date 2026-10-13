import AppKit
import SwiftUI
import Combine

enum FactoryIcon {
    // The app icon's silhouette (sawtooth roof, chimney with its cap, three windows) as an 18-point template image.
    static let image: NSImage = {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let s = 0.38, x = { (v: Double) in 1 + (v - 10) * s }, y = { (v: Double) in 2 + (48 - v) * s }
            let shape = NSBezierPath()
            let outline: [(Double, Double)] = [(10, 48), (10, 25.5), (22.5, 32.5), (22.5, 25.5), (35, 32.5), (35, 25.5), (44, 30.54), (44, 15), (43, 15), (43, 12), (52, 12), (52, 15), (51, 15), (51, 32.5), (52, 32.5), (52, 48)]
            shape.move(to: NSPoint(x: x(outline[0].0), y: y(outline[0].1)))
            for (px, py) in outline.dropFirst() { shape.line(to: NSPoint(x: x(px), y: y(py))) }
            shape.close()
            for wx in [14.5, 27.0, 39.5] {
                shape.append(NSBezierPath(roundedRect: NSRect(x: x(wx), y: y(43.5), width: 7 * s, height: 5.5 * s), xRadius: 0.4, yRadius: 0.4))
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
        popover.contentSize = panelSize()
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.popover.contentSize = self.panelSize(); self.popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
        } else if !UserDefaults.standard.bool(forKey: "openedSettings") || ProcessInfo.processInfo.arguments.contains("--settings") {
            FactoryModel.shared.openSettings()
            UserDefaults.standard.set(true, forKey: "openedSettings")
        }
    }
    // The panel is as tall as the screen under the menu bar allows, up to 720 points, so it never has to overlap the bar.
    private func panelSize() -> NSSize {
        let screen = statusItem?.button?.window?.screen ?? NSScreen.main
        let available = (screen?.visibleFrame.height ?? 800) - 24
        return NSSize(width: 420, height: min(720, max(420, available)))
    }
    @objc private func openFromStatusBar(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp || NSApp.currentEvent?.modifierFlags.contains(.control) == true {
            FactoryModel.shared.openSettings()
        } else if popover.isShown {
            closePopover()
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.contentSize = panelSize()
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
        // The menu bar glyph, enlarged, for review.
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 144, pixelsHigh: 144, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 144, height: 144).fill()
        FactoryIcon.image.draw(in: NSRect(x: 0, y: 0, width: 144, height: 144), from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(dir)/glyph.png"))
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
