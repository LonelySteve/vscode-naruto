import AppKit
import SwiftUI
import Carbon
import NarutoTransfer

@main
enum NarutoReceiverApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let receiver = Receiver()
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private var hotKey: GlobalHotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        receiver.showWindow = { [weak self] in self?.showResults() }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: "Naruto Receiver")
        let menu = NSMenu()
        menu.addItem(withTitle: "Naruto Receiver · ⌘⇧E 接收 / 取消", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        let showItem = menu.addItem(withTitle: "显示文件与使用说明", action: #selector(showResults), keyEquivalent: "")
        showItem.target = self
        let permissionItem = menu.addItem(withTitle: "检查辅助功能权限…", action: #selector(requestAccessibility), keyEquivalent: "")
        permissionItem.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Naruto Receiver", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
        do {
            hotKey = try GlobalHotKey { [weak self] in self?.receiver.toggle() }
        } catch { receiver.error = error.localizedDescription }
        showResults()
    }

    @objc private func requestAccessibility() { receiver.requestAccessibility() }

    @objc private func showResults() {
        if window == nil {
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 620),
                                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            created.title = "Naruto Receiver"
            created.isReleasedWhenClosed = false
            created.contentView = NSHostingView(rootView: ReceiverView(receiver: receiver))
            created.center()
            window = created
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showResults()
        return true
    }
}

private final class GlobalHotKey {
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    let action: () -> Void

    init(action: @escaping () -> Void) throws {
        self.action = action
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return OSStatus(eventNotHandledErr) }
            Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue().action()
            return noErr
        }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard status == noErr else { throw TransferError("无法安装全局快捷键处理器（\(status)）") }
        let registration = RegisterEventHotKey(UInt32(kVK_ANSI_E), UInt32(cmdKey | shiftKey),
                                               EventHotKeyID(signature: 0x4E52544F, id: 1), GetApplicationEventTarget(), 0, &reference)
        if registration != noErr {
            RemoveEventHandler(handler)
            handler = nil
            throw TransferError("⌘⇧E 快捷键注册失败（\(registration)），可能已被其他程序占用。请释放该快捷键后重启。")
        }
    }

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
        if let handler { RemoveEventHandler(handler) }
    }
}
