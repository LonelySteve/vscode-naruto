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
        for action in ["delete", "rename", "create"] { XCTAssertThrowsError(try parse(action: action)) }
        XCTAssertThrowsError(try parse(encoding: "base64", content: "not base64"))
        XCTAssertNoThrow(try parse(path: ".", action: "mkdir"))
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
