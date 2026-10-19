import AppKit
import SwiftUI
import ApplicationServices
import NarutoTransfer

@MainActor
final class Receiver: ObservableObject {
    @Published var clickMode: ClickMode = ClickMode(rawValue: UserDefaults.standard.string(forKey: "clickMode") ?? "") ?? .session {
        didSet { UserDefaults.standard.set(clickMode.rawValue, forKey: "clickMode") }
    }
    @Published var clickPace: ClickPace = ClickPace(rawValue: UserDefaults.standard.string(forKey: "clickPace") ?? "") ?? .normal {
        didSet { UserDefaults.standard.set(clickPace.rawValue, forKey: "clickPace") }
    }
    @Published var syncOnFocusLoss = UserDefaults.standard.bool(forKey: "syncOnFocusLoss") {
        didSet { UserDefaults.standard.set(syncOnFocusLoss, forKey: "syncOnFocusLoss") }
    }
    @Published var focusSwitchMode: FocusSwitchMode = FocusSwitchMode(rawValue: UserDefaults.standard.string(forKey: "focusSwitchMode") ?? "") ?? .commandTab {
        didSet { UserDefaults.standard.set(focusSwitchMode.rawValue, forKey: "focusSwitchMode") }
    }
    @Published var isReceiving = false
    @Published var progress = 0.0
    @Published var progressTitle = "等待导出"
    @Published var progressDetail = "⌘⇧E 开始接收"
    @Published var result: ExportedFiles?
    @Published var error: String?
    @Published var notice: String?
    @Published var isArchiving = false
    @Published var clipboardStatus = ""
    @Published var pastedText = ""
    @Published var isWaitingForPaste = false
    var showWindow: () -> Void = {}
    var hideWindow: () -> Void = {}
    private var receiveTask: Task<Void, Never>?
    private var progressPanel: NSPanel?
    private var pasteInput: AsyncStream<String>.Continuation?

    func toggle() {
        if let receiveTask {
            receiveTask.cancel()
            return
        }
        guard !isArchiving else {
            notice = "正在生成 ZIP，请完成后再开始接收。"
            showWindow()
            return
        }
        let mode = clickMode
        let pace = clickPace
        let switchFocus = mode.isAutomatic && syncOnFocusLoss
        let focusMode = focusSwitchMode
        guard !mode.isAutomatic || AXIsProcessTrusted() else {
            requestAccessibility()
            return
        }
        let panelPoint = NSEvent.mouseLocation
        var clicker: MouseClicker?
        if mode.isAutomatic {
            guard let point = CGEvent(source: nil)?.location else { return }
            let target = NSWorkspace.shared.frontmostApplication
            if (mode == .process || switchFocus) && (target == nil || target?.processIdentifier == ProcessInfo.processInfo.processIdentifier) {
                error = "请先激活目标应用，将鼠标放到导出按钮，再按 ⌘⇧E。"
                showWindow()
                return
            }
            clicker = MouseClicker(mode: mode, pace: pace, point: point, target: target)
        }
        let shortcutFocus = switchFocus ? CommandTabFocusSwitch(targetPID: clicker!.target!.processIdentifier) : nil
        // Capture the clipboard baseline before returning to the UI, including manual starts.
        var clipboard = mode == .paste ? nil : ClipboardReader()
        var pastedBlocks: AsyncStream<String>.Iterator?
        if mode == .paste {
            let stream = AsyncStream<String> { pasteInput = $0 }
            pastedBlocks = stream.makeAsyncIterator()
        }
        error = nil
        notice = nil
        clipboardStatus = ""
        pastedText = ""
        progress = 0
        progressTitle = "准备接收"
        progressDetail = mode.isAutomatic ? "松开快捷键后点击 · ⌘⇧E 取消" : "请手动点击起始元信息 · ⌘⇧E 取消"
        isReceiving = true
        if switchFocus { hideWindow() }
        showProgress(near: panelPoint)
        if mode == .paste { showWindow() }
        receiveTask = Task {
            defer {
                progressPanel?.orderOut(nil)
                pasteInput?.finish()
                pasteInput = nil
                isWaitingForPaste = false
                receiveTask = nil
                isReceiving = false
            }
            @MainActor func nextText(timeout: TimeInterval) async throws -> String {
                if mode == .paste {
                    isWaitingForPaste = true
                    defer { isWaitingForPaste = false }
                    guard let text = await pastedBlocks!.next() else { throw CancellationError() }
                    try Task.checkCancellation()
                    return text
                }
                return try await clipboard!.nextText(timeout: mode.isAutomatic ? timeout : nil) { status in
                    if clipboardStatus != status { clipboardStatus = status }
                }
            }
            @MainActor func receiveBlock(timeout: TimeInterval) async throws -> String {
                if switchFocus {
                    progressDetail = "正在返回目标应用，准备点击 · ⌘⇧E 取消"
                    guard !clicker!.target!.isTerminated else { throw TransferError("导出目标应用已退出，接收停止。") }
                    if focusMode == .commandTab {
                        try await shortcutFocus!.returnToTarget()
                    } else {
                        try await activateForTransfer(clicker!.target!)
                    }
                }
                try await clicker?.click()
                if switchFocus {
                    // Allow the remote click/copy to finish before asking the VDI to sync.
                    progressDetail = "等待远端处理点击 · ⌘⇧E 取消"
                    try await Task.sleep(nanoseconds: UInt64(pace.interval * 1_000_000_000))
                    if focusMode == .commandTab {
                        try await shortcutFocus!.leaveTarget()
                    } else {
                        progressPanel?.makeKeyAndOrderFront(nil)
                        try await activateForTransfer(.current)
                    }
                    progressDetail = "已切换应用，等待剪贴板同步 · ⌘⇧E 取消"
                }
                return try await nextText(timeout: timeout)
            }
            do {
                // The hotkey may fire while Command/Shift are still physically held.
                if mode.isAutomatic {
                    let deadline = Date().addingTimeInterval(5)
                    while !CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskShift, .maskControl, .maskAlternate]).isEmpty {
                        guard Date() < deadline else { throw TransferError("请松开快捷键后重试") }
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                }
                progressTitle = "等待起始元信息"
                progressDetail = mode.isAutomatic ? "正在点击导出按钮 · ⌘⇧E 取消" : "现在手动点一次导出 · ⌘⇧E 取消"
                if mode == .paste { progressDetail = "请粘贴并提交起始元信息 · ⌘⇧E 取消" }
                let metadata = try ExportMetadata.parse(await receiveBlock(timeout: max(30, pace.clipboardTimeout)))
                try ExportedFiles.checkBaseline(metadata.snapshot)
                var collector = ExportCollector(metadata: metadata)
                updateProgress(collector, mode: mode)
                while !collector.isComplete {
                    try collector.append(await receiveBlock(timeout: pace.clipboardTimeout))
                    updateProgress(collector, mode: mode)
                }
                progressTitle = "校验并解压"
                progressDetail = "正在根据已有副本还原完整文件包"
                let completed = collector
                let files = try await Task.detached(priority: .userInitiated) {
                    try ExportedFiles.extract(WorkspacePacket.decode(completed.verifiedText()))
                }.value
                try Task.checkCancellation()
                result = files
                notice = metadata.snapshot?.base == nil
                    ? "接收成功，完整文件包已还原，副本已保存。"
                    : "接收成功，完整文件包已还原，副本已保存。请在 VS Code 中确认接收成功。"
                showWindow()
            } catch is CancellationError {
                notice = "接收已取消。再次接收前，请先取消 VS Code 中未完成的 Naruto 导出。"
                showWindow()
            } catch {
                self.error = error.localizedDescription
                showWindow()
            }
        }
    }

    func syncClipboardNow() {
        guard isReceiving, clickMode == .manual else { return }
        progressDetail = "正在切到接收器，等待剪贴板同步 · ⌘⇧E 取消"
        showWindow()
    }

    func submitPaste() {
        guard isWaitingForPaste, !pastedText.isEmpty else { return }
        pasteInput?.yield(pastedText)
        pastedText = ""
        isWaitingForPaste = false
    }

    func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            error = "自动点击需要在系统设置 → 隐私与安全性 → 辅助功能中允许 Naruto Receiver。也可改用无需此权限的手动点击模式。"
            showWindow()
        } else {
            notice = "辅助功能权限已就绪。将鼠标放到 VS Code 的 Naruto 导出按钮上，按 ⌘⇧E。"
        }
    }

    private func updateProgress(_ collector: ExportCollector, mode: ClickMode) {
        progress = Double(collector.receivedCount) / Double(collector.metadata.chunkCount)
        progressTitle = "接收中 · \(collector.receivedCount) / \(collector.metadata.chunkCount)"
        progressDetail = mode.isAutomatic ? "固定点击起始位置 · ⌘⇧E 取消" : "已收到，返回目标应用点下一块，再按 ⌘Tab 切出"
        if mode == .paste { progressDetail = "请粘贴并提交第 \(collector.receivedCount + 1) 块 · ⌘⇧E 取消" }
    }

    private func showProgress(near point: NSPoint) {
        if progressPanel == nil {
            let panel = TransferProgressPanel(contentRect: NSRect(x: 0, y: 0, width: 310, height: 108),
                                              styleMask: [.borderless], backing: .buffered, defer: false)
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.contentView = NSHostingView(rootView: ProgressViewContent(receiver: self))
            progressPanel = panel
        }
        guard let panel = progressPanel else { return }
        let screen = NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) } ?? NSScreen.main!
        let bounds = screen.visibleFrame.insetBy(dx: 10, dy: 10)
        let x = min(max(point.x + 20, bounds.minX), bounds.maxX - panel.frame.width)
        let proposedY = point.y - panel.frame.height - 20
        let y = min(max(proposedY < bounds.minY ? point.y + 24 : proposedY, bounds.minY), bounds.maxY - panel.frame.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.orderFrontRegardless()
    }

    func open(_ item: ExportedItem) {
        if !NSWorkspace.shared.open(item.url) { error = "无法使用默认应用打开 \(item.relativePath)" }
    }

    func reveal(_ url: URL) { NSWorkspace.shared.activateFileViewerSelecting([url]) }

    func copyContents(_ item: ExportedItem) {
        do {
            let data = try Data(contentsOf: item.url)
            let isText = !data.contains(0) && String(data: data, encoding: .utf8) != nil
            let text = isText ? String(decoding: data, as: UTF8.self) : data.base64EncodedString()
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(text, forType: .string) else { throw TransferError("无法写入剪贴板") }
            notice = isText ? "已复制文件内容" : "已复制二进制内容（Base64）"
        } catch { self.error = error.localizedDescription }
    }

    func copyArchive() {
        guard let result, !isArchiving else { return }
        isArchiving = true
        error = nil
        Task {
            defer { isArchiving = false }
            do {
                let archive = try await Task.detached(priority: .userInitiated) { try result.createArchive() }.value
                NSPasteboard.general.clearContents()
                guard NSPasteboard.general.writeObjects([archive as NSURL]) else { throw TransferError("无法将 ZIP 文件写入剪贴板") }
                notice = "ZIP 文件已复制，可在 Finder、聊天窗口或邮件中粘贴。"
            } catch { self.error = error.localizedDescription }
        }
    }
}

/// Normally only shown without activation; takes focus explicitly for VDI clipboard sync.
private final class TransferProgressPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
