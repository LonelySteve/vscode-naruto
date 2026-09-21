import * as assert from "assert";
import * as vscode from "vscode";
import { createHash, randomBytes } from "crypto";
import { symlink } from "fs/promises";
import createCompress from "compress-brotli";
import { base91Decode, base91Encode } from "../base91";
import { VirtualWorkspace, WorkspaceExporter } from "../virtualWorkspace";
import {
  applyFileEdit, applyPacket, createExportBlocks, decodePacket, encodePacket, parsePacket,
  snapshotWorkspace, splitExport, WorkspaceExportMetadata, WorkspaceOperation, WorkspacePacket,
} from "../workspaceTransfer";

function memoryState(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
}

suite("Naruto virtual workspace", () => {
  let root: vscode.Uri;
  let folder: vscode.WorkspaceFolder;
  let tree: VirtualWorkspace;
  let state: vscode.Memento;
  let sequence = 0;
  const uri = (name: string) => vscode.Uri.joinPath(root, name);
  const read = async (name: string) => Buffer.from(await vscode.workspace.fs.readFile(uri(name))).toString("utf8");
  const location = (name: string) => ({ workspace: folder.name, path: `${root.path.slice(folder.uri.path.length + 1)}/${name}` });
  const packet = (operations: WorkspaceOperation[]): WorkspacePacket => ({ format: "naruto-virtual-workspace", version: 1, operations });
  const write = (name: string, content: string): WorkspaceOperation => ({ ...location(name), action: "write", encoding: "utf8", content });
  const apply = (data: WorkspacePacket) => applyPacket(data, async () => {});

  setup(async () => {
    folder = vscode.workspace.workspaceFolders![0];
    assert.ok(folder, "Tests must run in the temporary workspace from .vscode-test.mjs");
    root = vscode.Uri.joinPath(folder.uri, `case-${sequence++}`);
    await vscode.workspace.fs.createDirectory(root);
    state = memoryState();
    tree = new VirtualWorkspace(state);
  });

  teardown(async () => {
    tree.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace.fs.delete(root, { recursive: true });
  });

  test("registers the view and requested commands", async () => {
    const extension = vscode.extensions.all.find(item => item.packageJSON.name === "naruto")!;
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["add", "addCurrentFile", "removeCurrentFile", "import", "export", "cancelExport", "rename", "delete", "newFile", "newFolder"]) {
      assert.ok(commands.includes(`naruto.virtualWorkspace.${id}`), id);
    }
    assert.strictEqual(extension.packageJSON.contributes.views.naruto[0].id, "naruto.virtualWorkspace");
  });

  test("current-file commands add the real editor file, export it, and remove it without deletion", async () => {
    await vscode.workspace.fs.writeFile(uri("current.txt"), Buffer.from("current editor"));
    const document = await vscode.workspace.openTextDocument(uri("current.txt"));
    await vscode.window.showTextDocument(document);
    const oldClipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.addCurrentFile");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      const metadata: WorkspaceExportMetadata = JSON.parse(await vscode.env.clipboard.readText());
      assert.strictEqual(metadata.format, "naruto-virtual-workspace-export");
      assert.strictEqual(metadata.chunkCount, 1);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      const data = await decodePacket(await vscode.env.clipboard.readText());
      assert.deepStrictEqual(data.operations, [write("current.txt", "current editor")]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.removeCurrentFile");
      assert.strictEqual(await read("current.txt"), "current editor");
    } finally {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.cancelExport");
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });

  test("removing a nested file only hides it, persists selection, and excludes it from export", async () => {
    await vscode.workspace.fs.writeFile(uri("keep.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("hidden.txt"), Buffer.from("hidden"));
    await tree.add([uri("keep.txt"), root]);
    await tree.remove(uri("hidden.txt"));
    assert.deepStrictEqual((await tree.getChildren()).map(item => item.toString()), [root.toString()]);
    assert.deepStrictEqual((await tree.getChildren(root)).map(item => item.toString()), [uri("keep.txt").toString()]);
    assert.strictEqual(await read("hidden.txt"), "hidden");
    const exported = await decodePacket(await tree.exportText());
    assert.ok(!exported.operations.some(op => op.path.endsWith("hidden.txt")));
    assert.strictEqual(exported.operations.filter(op => op.path.endsWith("keep.txt")).length, 1);
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.strictEqual((await tree.getChildren(root)).length, 1);
    await tree.add([uri("hidden.txt")]);
    assert.strictEqual((await tree.getChildren(root)).length, 2);
  });

  test("tree opens the real URI and tracks external VS Code rename and delete", async () => {
    await vscode.workspace.fs.writeFile(uri("before.txt"), Buffer.from("before"));
    await tree.add([uri("before.txt")]);
    const item = await tree.getTreeItem(uri("before.txt"));
    assert.strictEqual(item.resourceUri?.toString(), uri("before.txt").toString());
    assert.strictEqual(item.command?.command, "vscode.open");
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(uri("before.txt"), uri("after.txt"));
    await applyFileEdit(rename);
    assert.deepStrictEqual((await tree.getChildren()).map(item => item.toString()), [uri("after.txt").toString()]);
    const remove = new vscode.WorkspaceEdit();
    remove.deleteFile(uri("after.txt"));
    await applyFileEdit(remove);
    assert.deepStrictEqual(await tree.getChildren(), []);
  });

  test("snapshot roundtrips Unicode, binary bytes and empty directories with the original codec", async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await vscode.workspace.fs.writeFile(uri("中文.txt"), Buffer.from("你好\r\nNaruto"));
    await vscode.workspace.fs.writeFile(uri("image.bin"), binary);
    await vscode.workspace.fs.createDirectory(uri("empty"));
    const original = await snapshotWorkspace([root], []);
    const encoded = await encodePacket(original);
    const codec = createCompress();
    assert.deepStrictEqual(JSON.parse(await codec.decompress(base91Decode(encoded))), original);
    assert.deepStrictEqual(await decodePacket(base91Encode(await codec.compress(JSON.stringify(original)))), original);
    await vscode.workspace.fs.delete(uri("中文.txt"));
    await vscode.workspace.fs.delete(uri("image.bin"));
    await vscode.workspace.fs.delete(uri("empty"), { recursive: true });
    await tree.importText(encoded);
    assert.strictEqual(await read("中文.txt"), "你好\r\nNaruto");
    assert.deepStrictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri("image.bin"))), binary);
    assert.ok((await vscode.workspace.fs.stat(uri("empty"))).type & vscode.FileType.Directory);
  });

  test("applies ordered edits, create, directory rename, delete and updates open editors", async () => {
    await vscode.workspace.fs.writeFile(uri("edit.txt"), Buffer.from("old"));
    const document = await vscode.workspace.openTextDocument(uri("edit.txt"));
    await vscode.window.showTextDocument(document);
    const data = packet([
      write("edit.txt", "new"),
      { ...location("draft"), action: "mkdir" },
      { ...location("draft/created.txt"), action: "create", encoding: "utf8", content: "created" },
      { ...location("draft"), action: "rename", to: location("final").path },
      write("delete.txt", "remove me"),
      { ...location("delete.txt"), action: "delete" },
    ]);
    assert.strictEqual(await tree.importText(await encodePacket(data)), 6);
    assert.strictEqual(await read("edit.txt"), "new");
    assert.strictEqual(document.getText(), "new");
    assert.strictEqual(await read("final/created.txt"), "created");
    await assert.rejects(async () => vscode.workspace.fs.stat(uri("delete.txt")));
    assert.ok((await tree.getChildren()).some(item => item.toString() === uri("final").toString()));
  });

  test("validates all operations and workspace paths before writing anything", async () => {
    await vscode.workspace.fs.writeFile(uri("safe.txt"), Buffer.from("original"));
    for (const badPath of ["../escape.txt", "/tmp/escape.txt", "dir/../escape", "C:\\escape", ".", "a//b"]) {
      const data = packet([write("safe.txt", "changed"), { ...write("bad.txt", "bad"), path: badPath }]);
      await assert.rejects(apply(data), /格式无效/);
      assert.strictEqual(await read("safe.txt"), "original");
    }
    await assert.rejects(apply(packet([write("safe.txt", "changed"), { ...write("bad.txt", "bad"), workspace: "missing-workspace" }])), /真实工作区/);
    assert.strictEqual(await read("safe.txt"), "original");
    assert.throws(() => parsePacket(JSON.stringify({ format: "naruto-virtual-workspace", version: 2, operations: [] })));
  });

  test("rejects import through a symbolic link before applying earlier writes", async () => {
    await vscode.workspace.fs.createDirectory(uri("target"));
    await symlink(uri("target").fsPath, uri("link").fsPath, "dir");
    await vscode.workspace.fs.writeFile(uri("safe.txt"), Buffer.from("original"));
    await assert.rejects(apply(packet([write("safe.txt", "changed"), write("link/escape.txt", "bad")])), /符号链接/);
    assert.strictEqual(await read("safe.txt"), "original");
  });

  test("exports unsaved text and rejects imports that would discard unsaved edits", async () => {
    await vscode.workspace.fs.writeFile(uri("dirty.txt"), Buffer.from("saved"));
    const document = await vscode.workspace.openTextDocument(uri("dirty.txt"));
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(edit => edit.insert(new vscode.Position(0, 0), "unsaved "));
    try {
      const data = await snapshotWorkspace([uri("dirty.txt")], []);
      assert.strictEqual((data.operations[0] as { content: string }).content, "unsaved saved");
      await assert.rejects(apply(packet([write("dirty.txt", "overwrite")])), /未保存/);
      assert.strictEqual(await read("dirty.txt"), "saved");
    } finally {
      await document.save();
    }
  });

  test("reports partial application when a later operation cannot be applied", async () => {
    await assert.rejects(apply(packet([write("first.txt", "applied"), { ...location("missing.txt"), action: "rename", to: location("target.txt").path }])), /已应用 1 项/);
    assert.strictEqual(await read("first.txt"), "applied");
  });

  test("metadata describes data blocks without being split or included in the checksum", () => {
    for (const [length, size, count] of [[3, 256, 1], [256, 256, 1], [512, 256, 2], [513, 256, 3], [3, 1, 3]]) {
      const text = "A".repeat(length);
      const [header, ...chunks] = createExportBlocks(text, size);
      const metadata: WorkspaceExportMetadata = JSON.parse(header);
      assert.deepStrictEqual(metadata, {
        format: "naruto-virtual-workspace-export",
        version: 1,
        chunkCount: count,
        chunkSize: size,
        byteLength: length,
        checksum: { algorithm: "sha256", value: createHash("sha256").update(text, "utf8").digest("hex") },
      });
      assert.strictEqual(chunks.length, count);
      assert.strictEqual(chunks.join(""), text);
      assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= size));
    }
  });

  test("copies metadata first, then one data chunk per click from the same snapshot, and cancellation restarts", async () => {
    await vscode.workspace.fs.writeFile(uri("random.bin"), randomBytes(2048));
    await tree.add([uri("random.bin")]);
    const exported = await tree.exportText();
    const expected = splitExport(exported);
    assert.ok(expected.length > 2);
    const exporter = new WorkspaceExporter(tree);
    const oldClipboard = await vscode.env.clipboard.readText();
    try {
      const received: string[] = [];
      await exporter.next();
      const metadata: WorkspaceExportMetadata = JSON.parse(await vscode.env.clipboard.readText());
      assert.strictEqual(metadata.chunkCount, expected.length);
      assert.strictEqual(metadata.byteLength, Buffer.byteLength(exported));
      await vscode.workspace.fs.writeFile(uri("random.bin"), randomBytes(2048));
      for (let i = 0; i < metadata.chunkCount; i++) {
        await exporter.next();
        received.push(await vscode.env.clipboard.readText());
      }
      assert.deepStrictEqual(received, expected);
      assert.ok(received.every(chunk => Buffer.byteLength(chunk) <= 256));
      assert.strictEqual(createHash("sha256").update(received.join(""), "utf8").digest("hex"), metadata.checksum.value);
      assert.deepStrictEqual(await decodePacket(received.join("\n")), await decodePacket(exported));
      await exporter.next();
      const first = await vscode.env.clipboard.readText();
      const nextMetadata: WorkspaceExportMetadata = JSON.parse(first);
      assert.notStrictEqual(nextMetadata.checksum.value, metadata.checksum.value);
      exporter.cancel();
      assert.strictEqual(await vscode.env.clipboard.readText(), first);
      await exporter.next();
      assert.strictEqual(await vscode.env.clipboard.readText(), first);
      await exporter.next();
      const firstDataChunk = await vscode.env.clipboard.readText();
      exporter.cancel();
      assert.strictEqual(await vscode.env.clipboard.readText(), firstDataChunk);
      await exporter.next();
      assert.strictEqual(await vscode.env.clipboard.readText(), first);
    } finally {
      exporter.dispose();
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });
});
