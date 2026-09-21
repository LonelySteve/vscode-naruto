import { createHash } from "crypto";
import createCompress from "compress-brotli";
import { base91Decode, base91Encode } from "./base91";

export interface Location {
  workspace: string;
  path: string;
}

export type WorkspaceOperation = Location & (
  | { action: "write" | "create"; encoding: "utf8" | "base64"; content: string }
  | { action: "mkdir" | "delete" }
  | { action: "rename"; to: string }
);

export interface WorkspacePacket {
  format: "naruto-virtual-workspace";
  version: 1;
  operations: WorkspaceOperation[];
}

export interface WorkspaceExportMetadata {
  format: "naruto-virtual-workspace-export";
  version: 1;
  chunkCount: number;
  chunkSize: number;
  byteLength: number;
  checksum: { algorithm: "sha256"; value: string };
}

const codec = createCompress<string, Promise<string>>();

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !/[\\\x00-\x1f]/.test(value) &&
    (value === "." || value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
}

export function parsePacket(text: string): WorkspacePacket {
  const packet = JSON.parse(text);
  if (packet?.format !== "naruto-virtual-workspace" || packet.version !== 1 || !Array.isArray(packet.operations)) {
    throw new Error("不是受支持的 Naruto 虚拟工作区数据包");
  }
  for (const [index, op] of packet.operations.entries()) {
    const fail = () => { throw new Error(`第 ${index + 1} 项操作格式无效`); };
    if (!op || typeof op.workspace !== "string" || !op.workspace || !validPath(op.path)) {
      fail();
    }
    if (op.path === "." && op.action !== "mkdir") {
      fail();
    }
    switch (op.action) {
      case "write":
      case "create":
        if (typeof op.content !== "string" || !["utf8", "base64"].includes(op.encoding)) {
          fail();
        }
        if (op.encoding === "base64" && Buffer.from(op.content, "base64").toString("base64") !== op.content) {
          fail();
        }
        break;
      case "rename":
        if (!validPath(op.to) || op.to === ".") {
          fail();
        }
        break;
      case "mkdir":
      case "delete":
        break;
      default:
        fail();
    }
  }
  return packet;
}

export async function encodePacket(packet: WorkspacePacket): Promise<string> {
  return base91Encode(await codec.compress(JSON.stringify(packet)));
}

export async function decodePacket(text: string): Promise<WorkspacePacket> {
  return parsePacket(await codec.decompress(base91Decode(text)));
}

export function splitExport(text: string, size = 256): string[] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("分块大小必须为正整数");
  }
  // Base91 only contains ASCII: each character occupies exactly one byte.
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export function createExportBlocks(text: string, size = 256): string[] {
  const chunks = splitExport(text, size);
  const metadata: WorkspaceExportMetadata = {
    format: "naruto-virtual-workspace-export",
    version: 1,
    chunkCount: chunks.length,
    chunkSize: size,
    byteLength: Buffer.byteLength(text, "utf8"),
    checksum: {
      algorithm: "sha256",
      value: createHash("sha256").update(text, "utf8").digest("hex"),
    },
  };
  return [JSON.stringify(metadata), ...chunks];
}
