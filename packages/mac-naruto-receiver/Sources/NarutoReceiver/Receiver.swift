import AppKit
import SwiftUI
import ApplicationServices
import NarutoTransfer

@MainActor
final class Receiver: ObservableObject {
    @Published var isReceiving = false
    @Published var progress = 0.0
    @Published var progressTitle = "等待导出"
    @Published var progressDetail = "⌘⇧E 开始接收"
    @Published var result: ExportedFiles?
    @Published var error: String?
    @Published var notice: String?
    @Published var isArchiving = false
    var showWindow: () -> Void = {}
    private var receiveTask: Task<Void, Never>?
    private var progressPanel: NSPanel?

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
        guard AXIsProcessTrusted() else {
            requestAccessibility()
            return
        }
        guard let point = CGEvent(source: nil)?.location else { return }
        let panelPoint = NSEvent.mouseLocation
        error = nil
        notice = nil
        progress = 0
        progressTitle = "准备接收"
        progressDetail = "松开快捷键后点击 · ⌘⇧E 取消"
        isReceiving = true
        showProgress(near: panelPoint)
        receiveTask = Task {
            defer {
                progressPanel?.orderOut(nil)
                receiveTask = nil
                isReceiving = false
            }
            do {
                // The hotkey may fire while Command/Shift are still physically held.
                let deadline = Date().addingTimeInterval(5)
                while !CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskShift, .maskControl, .maskAlternate]).isEmpty {
                    guard Date() < deadline else { throw TransferError("请松开快捷键后重试") }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                progressTitle = "等待起始元信息"
                progressDetail = "正在点击导出按钮 · ⌘⇧E 取消"
                let metadata = try ExportMetadata.parse(await clickAndRead(at: point, timeout: 30))
                var collector = ExportCollector(metadata: metadata)
                updateProgress(collector)
                while !collector.isComplete {
                    try collector.append(await clickAndRead(at: point, timeout: 10))
                    updateProgress(collector)
                }
                progressTitle = "校验并解压"
                progressDetail = "正在还原文件到临时目录"
                let completed = collector
                let files = try await Task.detached(priority: .userInitiated) {
                    try ExportedFiles.extract(WorkspacePacket.decode(completed.verifiedText()))
                }.value
                try Task.checkCancellation()
                result = files
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

    func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            error = "请在系统设置 → 隐私与安全性 → 辅助功能中允许 Naruto Receiver 模拟点击，然后重新按 ⌘⇧E。"
            showWindow()
        } else {
            notice = "辅助功能权限已就绪。将鼠标放到 VS Code 的 Naruto 导出按钮上，按 ⌘⇧E。"
        }
    }

    private func updateProgress(_ collector: ExportCollector) {
        progress = Double(collector.receivedCount) / Double(collector.metadata.chunkCount)
        progressTitle = "接收中 · \(collector.receivedCount) / \(collector.metadata.chunkCount)"
        progressDetail = "固定点击起始位置 · ⌘⇧E 取消"
    }

    private func clickAndRead(at point: CGPoint, timeout: TimeInterval) async throws -> String {
        // Space clicks apart and mark each as a single click, never a double click.
        try await Task.sleep(nanoseconds: 150_000_000)
        guard AXIsProcessTrusted() else { throw TransferError("辅助功能权限已关闭，接收停止") }
        let pasteboard = NSPasteboard.general
        let previousChange = pasteboard.changeCount
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw TransferError("无法创建鼠标点击事件")
        }
        for event in [down, up] {
            event.flags = []
            event.setIntegerValueField(.mouseEventClickState, value: 1)
        }
        down.post(tap: .cghidEventTap)
        // Always release the button, including when cancelled between down and up.
        try? await Task.sleep(nanoseconds: 25_000_000)
        up.post(tap: .cghidEventTap)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            try Task.checkCancellation()
            if pasteboard.changeCount != previousChange, let text = pasteboard.string(forType: .string) {
                return text
            }
            try await Task.sleep(nanoseconds: 80_000_000)
        }
        throw TransferError("点击后未等到剪贴板文本，已停止接收。请确认鼠标位于导出按钮上；若导出已经开始，请先在 VS Code 中取消后重试。")
    }

    private func showProgress(near point: NSPoint) {
        if progressPanel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 310, height: 108),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
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
