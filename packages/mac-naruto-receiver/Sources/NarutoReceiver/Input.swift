import AppKit
import ApplicationServices
import Carbon
import NarutoTransfer

enum ClickMode: String, CaseIterable, Identifiable {
    case session, hid, process, manual, paste
    var id: String { rawValue }
    var isAutomatic: Bool { self == .hid || self == .session || self == .process }

    var title: String {
        switch self {
        case .hid: return "自动 · 系统级 HID"
        case .session: return "自动 · 登录会话"
        case .process: return "自动 · 指定进程"
        case .manual: return "手动点击 · 仅监听剪贴板"
        case .paste: return "手动粘贴 · 逐块接收"
        }
    }

    var detail: String {
        switch self {
        case .hid: return "通过系统事件入口发送鼠标移动和单击。"
        case .session: return "通过当前登录会话发送鼠标移动和单击。"
        case .process: return "直接向启动接收时的前台应用发送鼠标事件。"
        case .manual: return "自动读取剪贴板；每次收到数据后，再手动点击导出。"
        case .paste: return "逐块粘贴并提交导出文本，不自动读取剪贴板。"
        }
    }
}

enum ClickPace: String, CaseIterable, Identifiable {
    // Keep stored values so renamed presets retain the user's existing timing.
    case faster = "normal", normal = "vdi", slow
    var id: String { rawValue }

    var title: String {
        switch self {
        case .faster: return "更快"
        case .normal: return "常规"
        case .slow: return "慢速"
        }
    }

    var interval: TimeInterval {
        switch self {
        case .faster: return 0.15
        case .normal: return 0.5
        case .slow: return 1
        }
    }

    var holdDuration: TimeInterval {
        switch self {
        case .faster: return 0.025
        case .normal: return 0.12
        case .slow: return 0.2
        }
    }

    var clipboardTimeout: TimeInterval {
        switch self {
        case .faster: return 10
        case .normal: return 30
        case .slow: return 60
        }
    }

    var detail: String {
        "点击前间隔 \(Int(interval * 1000)) ms · 按住 \(Int(holdDuration * 1000)) ms · 等待剪贴板 \(Int(clipboardTimeout)) 秒"
    }
}

enum FocusSwitchMode: String, CaseIterable, Identifiable {
    case commandTab, application
    var id: String { rawValue }

    var title: String {
        self == .commandTab ? "系统快捷键 · ⌘Tab" : "应用激活"
    }

    var detail: String {
        self == .commandTab
            ? "切到上一个应用，收到数据后返回。请保留另一个应用，接收期间不要手动切换。"
            : "激活接收器浮窗，收到数据后返回目标应用。若无法激活，请改用系统快捷键。"
    }
}

/// The system app switcher only needs to leave the VDI, not activate this menu-bar app.
@MainActor
struct CommandTabFocusSwitch {
    let targetPID: pid_t
    var frontmostPID: () -> pid_t? = { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    var sendShortcut: () async throws -> Void = postCommandTab
    var timeout: TimeInterval = 3

    func leaveTarget() async throws { try await switchFocus(returning: false) }
    func returnToTarget() async throws { try await switchFocus(returning: true) }

    private func switchFocus(returning: Bool) async throws {
        func hasFocus() -> Bool {
            guard let current = frontmostPID() else { return false }
            return returning ? current == targetPID : current != targetPID
        }
        try Task.checkCancellation()
        if hasFocus() { return }
        // One shortcut per transition. Never cycle blindly through unrelated apps.
        try await sendShortcut()
        let deadline = Date().addingTimeInterval(timeout)
        while !hasFocus() {
            try Task.checkCancellation()
            guard Date() < deadline else {
                throw TransferError(returning
                    ? "⌘Tab 未能返回目标应用，已停止点击。接收期间请勿手动切换应用。"
                    : "⌘Tab 未能切出目标应用，已停止点击。请保留另一个本地应用，并确认目标应用没有拦截 macOS 的 ⌘Tab；也可改用手动监听，点完后手动切换窗口。")
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}

@MainActor
private func postCommandTab() async throws {
    try Task.checkCancellation()
    guard AXIsProcessTrusted() else { throw TransferError("发送 ⌘Tab 需要辅助功能权限，已停止接收。") }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let commandDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: true),
          let tabDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Tab), keyDown: true),
          let tabUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Tab), keyDown: false),
          let commandUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: false) else {
        throw TransferError("无法创建系统应用切换按键。")
    }
    source.localEventsSuppressionInterval = 0
    commandDown.type = .flagsChanged
    commandUp.type = .flagsChanged
    for event in [commandDown, tabDown, tabUp] { event.flags = .maskCommand }
    commandUp.flags = []
    func post(_ event: CGEvent) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        event.post(tap: .cghidEventTap)
    }
    post(commandDown)
    // Release both keys even when cancellation arrives during the gesture.
    defer { post(tabUp); post(commandUp) }
    try await Task.sleep(nanoseconds: 50_000_000)
    post(tabDown)
    try await Task.sleep(nanoseconds: 80_000_000)
}

/// Keeps one cursor for the entire transfer so manual writes between reads are not skipped.
@MainActor
struct ClipboardReader {
    private let pasteboard: NSPasteboard
    private var lastChange: Int
    private var lastText: String?

    init(pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
        self.lastText = Self.readText(pasteboard)
        self.lastChange = pasteboard.changeCount
    }

    private static func readText(_ pasteboard: NSPasteboard) -> String? {
        (pasteboard.readObjects(forClasses: [NSString.self], options: nil) as? [String])?.first
    }

    mutating func nextText(timeout: TimeInterval?, onStatus: (String) -> Void = { _ in }) async throws -> String {
        let deadline = timeout.map { Date().addingTimeInterval($0) }
        while true {
            try Task.checkCancellation()
            if #available(macOS 15.4, *), pasteboard.accessBehavior == .alwaysDeny {
                throw TransferError("macOS 已禁止此应用读取剪贴板。请在系统设置中允许 Naruto Receiver 的剪贴板访问，或选择“手动粘贴 · 逐块接收”。")
            }
            // changeCount tracks ownership, not every content update. Reading also
            // requests promised data from providers such as remote desktop clients.
            let text = Self.readText(pasteboard)
            let revision = pasteboard.changeCount
            let types = (pasteboard.types ?? []).map(\.rawValue).joined(separator: ", ")
            let reading = text.map { "读到 \($0.utf8.count) 字节文本" } ?? "暂未读到文本"
            onStatus("所有者计数：\(revision)\n可用类型：\(types.isEmpty ? "无" : types)\n读取结果：\(reading)")
            if let text, revision != lastChange || text != lastText {
                lastChange = revision
                lastText = text
                return text
            }
            if let deadline, Date() >= deadline {
                throw TransferError("未等到新的剪贴板文本，已停止。若远端已复制且 Mac 能正常粘贴，请改用“手动粘贴 · 逐块接收”，并查看剪贴板诊断。重试前先取消 VS Code 中未完成的导出。")
            }
            try await Task.sleep(nanoseconds: 80_000_000)
        }
    }
}

/// Activation requests are asynchronous. Wait for actual focus before a fixed-position click.
@MainActor
func activateForTransfer(_ application: NSRunningApplication) async throws {
    try Task.checkCancellation()
    guard !application.isTerminated else { throw TransferError("导出目标应用已退出，接收停止。") }
    if application.isActive { return }
    if #available(macOS 14.0, *) {
        if application == NSRunningApplication.current {
            NSApp.activate()
        } else if NSApp.isActive {
            NSApp.yieldActivation(to: application)
            guard application.activate(from: .current, options: []) else {
                throw TransferError("无法切回导出目标应用，已停止点击。请改用手动接收。")
            }
        } else {
            guard application.activate(options: []) else {
                throw TransferError("无法激活导出目标应用，已停止点击。")
            }
        }
    } else {
        guard application.activate(options: [.activateIgnoringOtherApps]) else {
            throw TransferError("无法切换应用焦点，已停止点击。")
        }
    }
    let deadline = Date().addingTimeInterval(3)
    while !application.isActive {
        try Task.checkCancellation()
        guard Date() < deadline else {
            throw TransferError("未能切换到 \(application.localizedName ?? "目标应用")，已停止点击。请将“切换方式”改为“系统快捷键 · ⌘Tab”，或手动点击后按 ⌘Tab 切换应用。")
        }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
}

@MainActor
struct MouseClicker {
    let mode: ClickMode
    let pace: ClickPace
    let point: CGPoint
    let target: NSRunningApplication?

    func click() async throws {
        // Manual reception never requests accessibility or creates mouse events.
        guard mode.isAutomatic else { return }
        try await Task.sleep(nanoseconds: UInt64(pace.interval * 1_000_000_000))
        guard AXIsProcessTrusted() else { throw TransferError("辅助功能权限已关闭。可授权后重试，或改用手动点击模式。") }
        if mode == .process {
            guard let target, !target.isTerminated else { throw TransferError("目标应用已退出，请重新选择点击目标") }
        }
        guard let source = CGEventSource(stateID: mode == .hid ? .hidSystemState : .combinedSessionState) else {
            throw TransferError("无法创建鼠标事件源")
        }
        source.localEventsSuppressionInterval = 0
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw TransferError("无法创建鼠标事件")
        }
        for event in [move, down, up] { event.flags = [] }
        for event in [down, up] { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        // Some remote clients need a move event before the down/up sequence.
        post(move)
        try await Task.sleep(nanoseconds: 50_000_000)
        post(down)
        // A cancelled gesture must still release the mouse button.
        try? await Task.sleep(nanoseconds: UInt64(pace.holdDuration * 1_000_000_000))
        post(up)
        try Task.checkCancellation()
    }

    private func post(_ event: CGEvent) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        switch mode {
        case .hid: event.post(tap: .cghidEventTap)
        case .session: event.post(tap: .cgSessionEventTap)
        case .process: event.postToPid(target!.processIdentifier)
        case .manual, .paste: break
        }
    }
}
