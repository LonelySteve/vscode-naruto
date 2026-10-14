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
    private var syncHotKey: GlobalHotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        receiver.showWindow = { [weak self] in self?.showResults() }
        receiver.hideWindow = { [weak self] in self?.window?.orderOut(nil) }
        // Standard responder actions enable real user-initiated paste in TextEditor.
        let mainMenu = NSMenu()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "退出 Naruto Receiver", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let applicationItem = mainMenu.addItem(withTitle: "Naruto Receiver", action: nil, keyEquivalent: "")
        applicationItem.submenu = applicationMenu
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = mainMenu.addItem(withTitle: "编辑", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        NSApp.mainMenu = mainMenu
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: "Naruto Receiver")
        let menu = NSMenu()
        menu.addItem(withTitle: "Naruto Receiver · ⌘⇧E 接收 / 取消", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        let showItem = menu.addItem(withTitle: "显示文件与使用说明", action: #selector(showResults), keyEquivalent: "")
        showItem.target = self
        let syncItem = menu.addItem(withTitle: "请求显示接收器 · ⌘⇧R（手动监听）", action: #selector(syncClipboard), keyEquivalent: "")
        syncItem.target = self
        let permissionItem = menu.addItem(withTitle: "检查辅助功能权限…", action: #selector(requestAccessibility), keyEquivalent: "")
        permissionItem.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Naruto Receiver", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
        do {
            hotKey = try GlobalHotKey(keyCode: UInt32(kVK_ANSI_E), id: 1, label: "⌘⇧E") { [weak self] in self?.receiver.toggle() }
            syncHotKey = try GlobalHotKey(keyCode: UInt32(kVK_ANSI_R), id: 2, label: "⌘⇧R") { [weak self] in self?.receiver.syncClipboardNow() }
        } catch { receiver.error = error.localizedDescription }
        showResults()
    }

    @objc private func requestAccessibility() { receiver.requestAccessibility() }
    @objc private func syncClipboard() { receiver.syncClipboardNow() }

    @objc private func showResults() {
        if window == nil {
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 760),
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
    private let id: UInt32
    let action: () -> Void

    init(keyCode: UInt32, id: UInt32, label: String, action: @escaping () -> Void) throws {
        self.id = id
        self.action = action
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
            var identifier = EventHotKeyID(signature: 0, id: 0)
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                    MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                  identifier.signature == 0x4E52544F, identifier.id == hotKey.id else { return OSStatus(eventNotHandledErr) }
            hotKey.action()
            return noErr
        }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard status == noErr else { throw TransferError("无法安装全局快捷键处理器（\(status)）") }
        let registration = RegisterEventHotKey(keyCode, UInt32(cmdKey | shiftKey),
                                               EventHotKeyID(signature: 0x4E52544F, id: id), GetApplicationEventTarget(), 0, &reference)
        if registration != noErr {
            RemoveEventHandler(handler)
            handler = nil
            throw TransferError("\(label) 快捷键注册失败（\(registration)），可能已被其他程序占用。请释放该快捷键后重启。")
        }
    }

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
        if let handler { RemoveEventHandler(handler) }
    }
}
