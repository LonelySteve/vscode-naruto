import Foundation
import Compression
import CryptoKit

public struct TransferError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct ExportMetadata: Decodable, Sendable {
    public struct Checksum: Decodable, Sendable {
        public let algorithm: String
        public let value: String
    }
    public let format: String
    public let version: Int
    public let chunkCount: Int
    public let chunkSize: Int
    public let byteLength: Int
    public let checksum: Checksum

    public static func parse(_ text: String) throws -> Self {
        guard let metadata = try? JSONDecoder().decode(Self.self, from: Data(text.utf8)),
              metadata.format == "naruto-virtual-workspace-export", metadata.version == 1,
              metadata.chunkCount > 0, metadata.chunkSize > 0, metadata.byteLength > 0,
              metadata.chunkCount == (metadata.byteLength - 1) / metadata.chunkSize + 1,
              metadata.checksum.algorithm == "sha256",
              metadata.checksum.value.count == 64,
              metadata.checksum.value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw TransferError("未收到 Naruto 起始元信息。请先取消 VS Code 中未完成的导出，再将鼠标放到导出按钮上重试。")
        }
        return metadata
    }
}

/// One clipboard write is one block, even when adjacent blocks contain identical text.
public struct ExportCollector {
    public let metadata: ExportMetadata
    public private(set) var receivedCount = 0
    private var text = ""
    public var isComplete: Bool { receivedCount == metadata.chunkCount }

    public init(metadata: ExportMetadata) { self.metadata = metadata }

    public mutating func append(_ chunk: String) throws {
        guard !isComplete else { throw TransferError("已收齐全部分块") }
        let expected = receivedCount == metadata.chunkCount - 1
            ? metadata.byteLength - receivedCount * metadata.chunkSize : metadata.chunkSize
        guard chunk.utf8.count == expected, chunk.utf8.allSatisfy({ base91Table[$0] != nil }) else {
            throw TransferError("第 \(receivedCount + 1) 块长度或字符无效，剪贴板可能被其他程序改写。请取消 VS Code 导出后重试。")
        }
        text += chunk
        receivedCount += 1
    }

    public func verifiedText() throws -> String {
        guard isComplete else { throw TransferError("导出数据尚未收齐") }
        let digest = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        guard text.utf8.count == metadata.byteLength, digest == metadata.checksum.value else {
            throw TransferError("SHA-256 校验失败，数据存在缺失、乱序或改写。请重新导出。")
        }
        return text
    }
}

private let base91Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~\"".utf8)
private let base91Table = Dictionary(uniqueKeysWithValues: base91Alphabet.enumerated().map { ($1, $0) })

public func decodeBase91(_ text: String) throws -> Data {
    var buffer = 0
    var bits = 0
    var pending: Int?
    var output = Data()
    for character in text.utf8 {
        guard let decoded = base91Table[character] else { throw TransferError("Base91 数据包含非法字符") }
        guard let previous = pending else {
            pending = decoded
            continue
        }
        let value = previous + decoded * 91
        buffer |= value << bits
        bits += value & 8191 > 88 ? 13 : 14
        repeat {
            output.append(UInt8(buffer & 255))
            buffer >>= 8
            bits -= 8
        } while bits > 7
        pending = nil
    }
    if let value = pending, bits + 7 > 7 {
        output.append(UInt8((buffer | value << bits) & 255))
    }
    return output
}

private func decompressBrotli(_ source: Data) throws -> Data {
    guard !source.isEmpty else { throw TransferError("压缩数据为空") }
    let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: 65_536)
    defer { destination.deallocate() }
    var stream = compression_stream(dst_ptr: destination, dst_size: 65_536, src_ptr: destination, src_size: 0, state: nil)
    guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI) == COMPRESSION_STATUS_OK else {
        throw TransferError("无法初始化 Brotli 解码器")
    }
    defer { compression_stream_destroy(&stream) }
    return try source.withUnsafeBytes { bytes in
        stream.src_ptr = bytes.bindMemory(to: UInt8.self).baseAddress!
        stream.src_size = source.count
        var output = Data()
        while true {
            stream.dst_ptr = destination
            stream.dst_size = 65_536
            let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
            output.append(destination, count: 65_536 - stream.dst_size)
            if status == COMPRESSION_STATUS_END { return output }
            guard status == COMPRESSION_STATUS_OK else { throw TransferError("Brotli 数据损坏或不完整") }
        }
    }
}

public struct WorkspacePacket: Decodable, Sendable {
    public struct Operation: Decodable, Sendable {
        public let action: String
        public let workspace: String
        public let path: String
        public let encoding: String?
        public let content: String?
    }
    public let format: String
    public let version: Int
    public let operations: [Operation]

    public static func decode(_ text: String) throws -> Self {
        let bytes = try decompressBrotli(decodeBase91(text))
        // compress-brotli serializes the JSON string once more with json-buffer.
        // Workspace JSON starts with "{", so json-buffer's colon escape is not involved.
        let json = try JSONDecoder().decode(String.self, from: bytes)
        return try parse(Data(json.utf8))
    }

    public static func parse(_ data: Data) throws -> Self {
        let packet = try JSONDecoder().decode(Self.self, from: data)
        guard packet.format == "naruto-virtual-workspace", packet.version == 1 else {
            throw TransferError("不是受支持的 Naruto 工作区快照")
        }
        for op in packet.operations {
            guard validComponent(op.workspace), validPath(op.path),
                  op.path != "." || op.action == "mkdir" else {
                throw TransferError("快照包含不安全的工作区名称或路径：\(op.workspace)/\(op.path)")
            }
            switch op.action {
            case "mkdir": break
            case "write":
                guard let content = op.content, let encoding = op.encoding,
                      encoding == "utf8" || (encoding == "base64" && Data(base64Encoded: content)?.base64EncodedString() == content) else {
                    throw TransferError("文件内容编码无效：\(op.path)")
                }
            default:
                throw TransferError("导出快照仅支持 write 和 mkdir，不执行 \(op.action) 操作")
            }
        }
        return packet
    }
}

private func validComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." &&
        !value.unicodeScalars.contains { $0.value < 32 || $0 == "/" || $0 == "\\" }
}

private func validPath(_ path: String) -> Bool {
    path == "." || path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { validComponent(String($0)) }
}
