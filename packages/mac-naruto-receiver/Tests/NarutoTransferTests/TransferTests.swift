import XCTest
import CryptoKit
@testable import NarutoTransfer

final class TransferTests: XCTestCase {
    private struct Fixture: Decodable {
        let blocks: [String]
    }

    private func fixture() throws -> Fixture {
        let url = Bundle.module.url(forResource: "export", withExtension: "json", subdirectory: "Fixtures")!
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func metadata(for chunks: [String], size: Int? = nil) throws -> ExportMetadata {
        let data = Data(chunks.joined().utf8)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let json: [String: Any] = ["format": "naruto-virtual-workspace-export", "version": 1,
                                  "chunkCount": chunks.count, "chunkSize": size ?? chunks[0].utf8.count,
                                  "byteLength": data.count, "checksum": ["algorithm": "sha256", "value": hash]]
        return try ExportMetadata.parse(String(decoding: JSONSerialization.data(withJSONObject: json), as: UTF8.self))
    }

    func testActualVSCodeExportDecodesAndExtractsMultipleWorkspaces() throws {
        let sample = try fixture()
        var collector = ExportCollector(metadata: try ExportMetadata.parse(sample.blocks[0]))
        for chunk in sample.blocks.dropFirst() { try collector.append(chunk) }
        XCTAssertTrue(collector.isComplete)
        let packet = try WorkspacePacket.decode(collector.verifiedText())
        XCTAssertEqual(packet.operations.count, 6)
        XCTAssertEqual(packet.operations[2].content, "export const hello = \"你好 🍥\";\n:base64: stays text\n")
        XCTAssertEqual(packet.operations[5].content, String(repeating: "Naruto 跨语言传输验证\n", count: 6000))
        let result = try ExportedFiles.extract(packet)
        defer { try? FileManager.default.removeItem(at: result.directory.deletingLastPathComponent()) }
        XCTAssertEqual(result.fileCount, 4)
        XCTAssertEqual(result.items.map(\.relativePath), [
            "other-workspace", "other-workspace/empty.txt", "other-workspace/large.txt",
            "示例 project", "示例 project/binary.bin", "示例 project/empty folder",
            "示例 project/src", "示例 project/src/你好.ts"
        ])
        for op in packet.operations {
            let workspace = result.directory.appendingPathComponent(op.workspace)
            let target = op.path == "." ? workspace : workspace.appendingPathComponent(op.path)
            if op.action == "mkdir" {
                XCTAssertTrue(try target.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)
            } else {
                XCTAssertEqual(try Data(contentsOf: target), op.encoding == "base64" ? Data(base64Encoded: op.content!) : Data(op.content!.utf8))
            }
        }
    }

    func testIdenticalConsecutiveChunksAreNotDropped() throws {
        var collector = ExportCollector(metadata: try metadata(for: ["AAAA", "AAAA", "A"]))
        try collector.append("AAAA")
        try collector.append("AAAA")
        try collector.append("A")
        XCTAssertEqual(try collector.verifiedText(), "AAAAAAAAA")
        XCTAssertThrowsError(try collector.append("A"))
    }

    func testIncompleteCorruptedAndReorderedTransfersFail() throws {
        var collector = ExportCollector(metadata: try metadata(for: ["ABCD", "EFGH"]))
        XCTAssertThrowsError(try collector.verifiedText())
        XCTAssertThrowsError(try collector.append("ABC"))
        XCTAssertThrowsError(try collector.append("AB C"))
        try collector.append("EFGH")
        try collector.append("ABCD")
        XCTAssertThrowsError(try collector.verifiedText())
        var corrupt = ExportCollector(metadata: try metadata(for: ["ABCD"]))
        try corrupt.append("ABCE")
        XCTAssertThrowsError(try corrupt.verifiedText())
    }

    func testInvalidMetadataAndNonNarutoClipboardFail() throws {
        let sample = try fixture()
        let good = sample.blocks[0]
        for text in ["hello", sample.blocks[1], good.replacingOccurrences(of: "sha256", with: "md5"),
                     good.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"),
                     good.replacingOccurrences(of: "\"chunkSize\":73", with: "\"chunkSize\":0")] {
            XCTAssertThrowsError(try ExportMetadata.parse(text), text)
        }
    }

    func testUntrustedPathsAndNonSnapshotActionsAreRejected() throws {
        func parse(workspace: String = "project", path: String = "file.txt", action: String = "write", encoding: String = "utf8", content: String = "hello") throws {
            let packet: [String: Any] = ["format": "naruto-virtual-workspace", "version": 1,
                "operations": [["workspace": workspace, "path": path, "action": action, "encoding": encoding, "content": content]]]
            _ = try WorkspacePacket.parse(JSONSerialization.data(withJSONObject: packet))
        }
        for path in ["", "/tmp/escape", "../escape", "a/../escape", "a//b", "a/./b", "a\\b", "a\0b", "."] {
            XCTAssertThrowsError(try parse(path: path), path)
        }
        for workspace in ["", "..", "/tmp", "a/b", "a\\b"] { XCTAssertThrowsError(try parse(workspace: workspace)) }
        for action in ["rename", "create"] { XCTAssertThrowsError(try parse(action: action)) }
        XCTAssertThrowsError(try parse(encoding: "base64", content: "not base64"))
        XCTAssertNoThrow(try parse(path: ".", action: "mkdir"))
        XCTAssertThrowsError(try parse(action: "delete"))
    }

    private func snapshot(_ id: String, base: String? = nil, replace: [[String: String]] = [], operations: [[String: String]]) throws -> WorkspacePacket {
        var snapshot = ["id": String(repeating: id, count: 64)]
        if let base { snapshot["base"] = String(repeating: base, count: 64) }
        return try WorkspacePacket.parse(JSONSerialization.data(withJSONObject: [
            "format": "naruto-virtual-workspace", "version": 1, "snapshot": snapshot, "replace": replace, "operations": operations
        ]))
    }

    private func op(_ action: String, _ path: String, _ content: String? = nil, encoding: String = "utf8") -> [String: String] {
        var op = ["workspace": "project", "action": action, "path": path]
        if let content { op["content"] = content; op["encoding"] = encoding }
        return op
    }

    func testIncrementalRestoreKeepsUnchangedFilesAndAppliesDeletes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = root.appendingPathComponent("snapshots")
        defer { try? FileManager.default.removeItem(at: root) }
        let full = try snapshot("a", operations: [op("write", "keep.txt", "keep"), op("write", "edit.txt", "old"),
            op("write", "remove.txt", "remove"), op("write", "binary.bin", "AAH/", encoding: "base64"), op("mkdir", "empty")])
        let first = try ExportedFiles.extract(full, temporaryDirectory: root, snapshotDirectory: cache)
        // Editing the displayed result must not pollute the baseline used by later exports.
        try Data("local edit".utf8).write(to: first.directory.appendingPathComponent("project/keep.txt"))
        let delta = try snapshot("b", base: "a", operations: [op("delete", "remove.txt"), op("write", "edit.txt", "new"), op("write", "new.txt", "added")])
        let result = try ExportedFiles.extract(delta, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertEqual(try String(contentsOf: result.directory.appendingPathComponent("project/keep.txt"), encoding: .utf8), "keep")
        XCTAssertEqual(try String(contentsOf: result.directory.appendingPathComponent("project/edit.txt"), encoding: .utf8), "new")
        XCTAssertEqual(try String(contentsOf: result.directory.appendingPathComponent("project/new.txt"), encoding: .utf8), "added")
        XCTAssertEqual(try Data(contentsOf: result.directory.appendingPathComponent("project/binary.bin")), Data(base64Encoded: "AAH/"))
        XCTAssertTrue(result.items.contains { $0.relativePath == "project/empty" && $0.isDirectory })
        XCTAssertFalse(result.items.contains { $0.relativePath == "project/remove.txt" })
        XCTAssertFalse(result.items.contains { $0.relativePath == "NARUTO_CHANGES.json" })
        // A fresh extraction call loads the persisted baseline and permits retransmission.
        let retried = try ExportedFiles.extract(delta, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertEqual(retried.items.map(\.relativePath), result.items.map(\.relativePath))
        // Sender may report reception failed, then send another delta against the older baseline.
        let retry = try snapshot("c", base: "a", operations: [op("write", "retry.txt", "retry")])
        let olderBase = try ExportedFiles.extract(retry, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertEqual(try String(contentsOf: olderBase.directory.appendingPathComponent("project/edit.txt"), encoding: .utf8), "old")
    }

    func testMissingBaselineAndFailedRestoreDoNotPublishSnapshots() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = root.appendingPathComponent("snapshots")
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = try snapshot("b", base: "a", operations: [op("write", "new.txt", "new")])
        XCTAssertThrowsError(try ExportedFiles.extract(missing, temporaryDirectory: root, snapshotDirectory: cache)) { error in
            XCTAssertTrue(error.localizedDescription.contains("全量导出"))
        }
        let full = try snapshot("a", operations: [op("write", "file.txt", "original")])
        _ = try ExportedFiles.extract(full, temporaryDirectory: root, snapshotDirectory: cache)
        let invalid = try snapshot("b", base: "a", operations: [op("write", "file.txt", "modified"), op("mkdir", "file.txt/child")])
        XCTAssertThrowsError(try ExportedFiles.extract(invalid, temporaryDirectory: root, snapshotDirectory: cache))
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.appendingPathComponent(String(repeating: "b", count: 64)).path))
        XCTAssertEqual(try String(contentsOf: cache.appendingPathComponent(String(repeating: "a", count: 64) + "/project/file.txt"), encoding: .utf8), "original")
        let replacement = try snapshot("c", operations: [op("write", "only.txt", "full")])
        let result = try ExportedFiles.extract(replacement, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertEqual(result.items.filter { !$0.isDirectory }.map(\.relativePath), ["project/only.txt"])
    }

    func testHeaderRejectsMissingBaselineBeforeReceivingDataBlocks() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = root.appendingPathComponent("snapshots")
        defer { try? FileManager.default.removeItem(at: root) }
        var json: [String: Any] = ["format": "naruto-virtual-workspace-export", "version": 1,
            "chunkCount": 1, "chunkSize": 4, "byteLength": 4,
            "checksum": ["algorithm": "sha256", "value": String(repeating: "a", count: 64)]]
        json["snapshot"] = ["id": String(repeating: "b", count: 64), "base": String(repeating: "a", count: 64)]
        let header = try ExportMetadata.parse(String(decoding: JSONSerialization.data(withJSONObject: json), as: UTF8.self))
        XCTAssertThrowsError(try ExportedFiles.checkBaseline(header.snapshot, snapshotDirectory: cache)) { error in
            XCTAssertTrue(error.localizedDescription.contains("全量导出模式"))
        }
        let full = try snapshot("a", operations: [op("write", "keep.txt", "keep")])
        _ = try ExportedFiles.extract(full, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertNoThrow(try ExportedFiles.checkBaseline(header.snapshot, snapshotDirectory: cache))
        json["snapshot"] = ["id": "../escape", "base": String(repeating: "a", count: 64)]
        XCTAssertThrowsError(try ExportMetadata.parse(String(decoding: JSONSerialization.data(withJSONObject: json), as: UTF8.self)))
    }

    func testMixedModesReplaceFullSubtreeAndKeepUnchangedIncrementalFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = root.appendingPathComponent("snapshots")
        defer { try? FileManager.default.removeItem(at: root) }
        let full = try snapshot("a", operations: [op("write", "full/old.txt", "old"), op("write", "keep.txt", "keep")])
        _ = try ExportedFiles.extract(full, temporaryDirectory: root, snapshotDirectory: cache)
        let mixed = try snapshot("b", base: "a", replace: [["workspace": "project", "path": "full"]], operations: [
            op("mkdir", "full"), op("write", "full/new.txt", "new")
        ])
        let result = try ExportedFiles.extract(mixed, temporaryDirectory: root, snapshotDirectory: cache)
        XCTAssertEqual(try String(contentsOf: result.directory.appendingPathComponent("project/keep.txt"), encoding: .utf8), "keep")
        XCTAssertEqual(try String(contentsOf: result.directory.appendingPathComponent("project/full/new.txt"), encoding: .utf8), "new")
        XCTAssertFalse(result.items.contains { $0.relativePath == "project/full/old.txt" })
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.appendingPathComponent(String(repeating: "a", count: 64) + "/project/full/old.txt").path))
        XCTAssertThrowsError(try snapshot("c", base: "a", replace: [["workspace": "project", "path": "../escape"]], operations: []))
    }

    func testMalformedBrotliDoesNotProduceFiles() {
        XCTAssertThrowsError(try WorkspacePacket.decode("AAAA"))
        XCTAssertThrowsError(try WorkspacePacket.decode(""))
        XCTAssertThrowsError(try decodeBase91("bad text"))
    }

    func testArchiveContainsFilesAndEmptyDirectoriesAndIncludesEdits() throws {
        let sample = try fixture()
        let packet = try WorkspacePacket.decode(sample.blocks.dropFirst().joined())
        let result = try ExportedFiles.extract(packet)
        defer { try? FileManager.default.removeItem(at: result.directory.deletingLastPathComponent()) }
        let edited = result.directory.appendingPathComponent("other-workspace/empty.txt")
        try Data("edited".utf8).write(to: edited)
        let archive = try result.createArchive()
        XCTAssertTrue(FileManager.default.fileExists(atPath: archive.path))
        let unpacked = result.directory.deletingLastPathComponent().appendingPathComponent("unpacked")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", archive.path, unpacked.path]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: unpacked.appendingPathComponent("resources/other-workspace/empty.txt")), "edited")
        XCTAssertTrue(try unpacked.appendingPathComponent("resources/示例 project/empty folder").resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)
        XCTAssertEqual(try Data(contentsOf: unpacked.appendingPathComponent("resources/示例 project/binary.bin")), Data([0, 255, 128, 1, 10, 13]))
    }
}
