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

    public static func extract(_ packet: WorkspacePacket, temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws -> Self {
        let fm = FileManager.default
        let root = temporaryDirectory.appendingPathComponent("naruto-\(UUID().uuidString)", isDirectory: true)
        let directory = root.appendingPathComponent("resources", isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            for op in packet.operations {
                let workspace = directory.appendingPathComponent(op.workspace, isDirectory: true)
                let target = op.path == "." ? workspace : workspace.appendingPathComponent(op.path)
                if op.action == "mkdir" {
                    try fm.createDirectory(at: target, withIntermediateDirectories: true)
                } else {
                    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    let bytes = op.encoding == "base64" ? Data(base64Encoded: op.content!)! : Data(op.content!.utf8)
                    try bytes.write(to: target)
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
