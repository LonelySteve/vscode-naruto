import Foundation

public struct ExportedItem: Identifiable, Sendable {
    public let url: URL
    public let relativePath: String
    public let isDirectory: Bool
    public let byteCount: Int
    public var id: String { relativePath }
}

public struct ExportedFiles: Sendable {
    public let directory: URL
    public let items: [ExportedItem]
    public var fileCount: Int { items.filter { !$0.isDirectory }.count }

    public static let snapshotDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("NarutoReceiver/Snapshots", isDirectory: true)

    public static func checkBaseline(_ snapshot: WorkspacePacket.Snapshot?,
                                     snapshotDirectory: URL = Self.snapshotDirectory) throws {
        guard let snapshot, let base = snapshot.base else { return }
        let fm = FileManager.default
        guard fm.fileExists(atPath: snapshotDirectory.appendingPathComponent(base).path) ||
              fm.fileExists(atPath: snapshotDirectory.appendingPathComponent(snapshot.id).path) else {
            throw TransferError("接收端缺少本次增量对应的副本。请取消 VS Code 当前导出，右键项目切换为全量导出模式，再重新导出。")
        }
    }

    public static func extract(_ packet: WorkspacePacket,
                               temporaryDirectory: URL = FileManager.default.temporaryDirectory,
                               snapshotDirectory: URL = Self.snapshotDirectory) throws -> Self {
        try checkBaseline(packet.snapshot, snapshotDirectory: snapshotDirectory)
        let fm = FileManager.default
        let root = temporaryDirectory.appendingPathComponent("naruto-\(UUID().uuidString)", isDirectory: true)
        let directory = root.appendingPathComponent("resources", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        do {
            let cached = packet.snapshot.map { snapshotDirectory.appendingPathComponent($0.id, isDirectory: true) }
            if let cached, fm.fileExists(atPath: cached.path) {
                // A retransmission can reuse the already completed, immutable snapshot.
                try fm.copyItem(at: cached, to: directory)
            } else {
                if let base = packet.snapshot?.base {
                    let source = snapshotDirectory.appendingPathComponent(base, isDirectory: true)
                    try fm.copyItem(at: source, to: directory)
                } else {
                    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
                }
                for location in packet.replace ?? [] {
                    let workspace = directory.appendingPathComponent(location.workspace, isDirectory: true)
                    let target = location.path == "." ? workspace : workspace.appendingPathComponent(location.path)
                    if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
                }
                for op in packet.operations {
                    let workspace = directory.appendingPathComponent(op.workspace, isDirectory: true)
                    let target = op.path == "." ? workspace : workspace.appendingPathComponent(op.path)
                    switch op.action {
                    case "delete":
                        if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
                    case "mkdir":
                        try fm.createDirectory(at: target, withIntermediateDirectories: true)
                    default:
                        try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                        let bytes = op.encoding == "base64" ? Data(base64Encoded: op.content!)! : Data(op.content!.utf8)
                        try bytes.write(to: target)
                    }
                }
                if let cached {
                    try fm.createDirectory(at: snapshotDirectory, withIntermediateDirectories: true)
                    let staging = snapshotDirectory.appendingPathComponent("pending-\(UUID().uuidString)", isDirectory: true)
                    defer { try? fm.removeItem(at: staging) }
                    try fm.copyItem(at: directory, to: staging)
                    try fm.moveItem(at: staging, to: cached)
                }
            }
            var items: [ExportedItem] = []
            // Enumerate relative paths directly: /var and /private/var URL spellings can differ.
            let enumerator = fm.enumerator(atPath: directory.path)!
            for case let relativePath as String in enumerator {
                let url = directory.appendingPathComponent(relativePath)
                let attributes = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
                items.append(ExportedItem(url: url, relativePath: relativePath,
                                          isDirectory: attributes.isDirectory == true, byteCount: attributes.fileSize ?? 0))
            }
            return Self(directory: directory, items: items.sorted { $0.relativePath < $1.relativePath })
        } catch {
            try? fm.removeItem(at: root)
            throw error
        }
    }

    public func createArchive() throws -> URL {
        let archive = directory.deletingLastPathComponent().appendingPathComponent("Naruto Export.zip")
        // Rebuild from the current files so edits made from the result list are included.
        if FileManager.default.fileExists(atPath: archive.path) { try FileManager.default.removeItem(at: archive) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", directory.path, archive.path]
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        let message = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw TransferError("创建 ZIP 失败：\(String(decoding: message, as: UTF8.self))")
        }
        return archive
    }
}
