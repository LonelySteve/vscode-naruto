import * as assert from "assert";
import * as vscode from "vscode";
import { createHash, randomBytes } from "crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "fs/promises";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
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
    for (const id of ["add", "addCurrentFile", "remove", "removeCurrentFile", "clear", "import", "export", "cancelExport", "rename", "delete", "newFile", "newFolder"]) {
      assert.ok(commands.includes(`naruto.virtualWorkspace.${id}`), id);
    }
    assert.strictEqual(extension.packageJSON.contributes.views.naruto[0].id, "naruto.virtualWorkspace");
  });

  test("context menus use the clicked file URI and support multiple resources", async () => {
    await vscode.workspace.fs.writeFile(uri("active.txt"), Buffer.from("active"));
    await vscode.workspace.fs.writeFile(uri("target.txt"), Buffer.from("target"));
    await vscode.workspace.fs.writeFile(uri("other.txt"), Buffer.from("other"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri("active.txt")));
    const oldClipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.add", uri("target.txt"));
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      const data = await decodePacket(await vscode.env.clipboard.readText());
      assert.deepStrictEqual(data.operations, [write("target.txt", "target")]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", uri("target.txt"));
      await vscode.commands.executeCommand("naruto.virtualWorkspace.add", uri("target.txt"), [uri("target.txt"), uri("other.txt")]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", uri("target.txt"), [uri("target.txt"), uri("other.txt")]);
      assert.strictEqual(await read("target.txt"), "target");
      assert.strictEqual(await read("other.txt"), "other");
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), uri("active.txt").toString());
    } finally {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.cancelExport");
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });

  test("clear command requires modal confirmation and leaves files intact", async () => {
    await vscode.workspace.fs.writeFile(uri("keep.txt"), Buffer.from("keep"));
    await vscode.commands.executeCommand("naruto.virtualWorkspace.add", uri("keep.txt"));
    const originalWarning = vscode.window.showWarningMessage;
    const originalError = vscode.window.showErrorMessage;
    const oldClipboard = await vscode.env.clipboard.readText();
    let choice: string | undefined;
    let warning: unknown[] = [];
    let errorMessage: unknown;
    vscode.window.showWarningMessage = (async (...args: unknown[]) => {
      warning = args;
      return choice;
    }) as typeof originalWarning;
    vscode.window.showErrorMessage = (async (message: string) => {
      errorMessage = message;
      return undefined;
    }) as typeof originalError;
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.clear");
      assert.strictEqual((warning[1] as vscode.MessageOptions).modal, true);
      assert.ok(warning.includes("清空"));
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      assert.deepStrictEqual((await decodePacket(await vscode.env.clipboard.readText())).operations, [write("keep.txt", "keep")]);
      // Start another export; confirming clear must also cancel its remaining blocks.
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      choice = "清空";
      await vscode.commands.executeCommand("naruto.virtualWorkspace.clear");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      assert.match(String(errorMessage), /请先将文件或文件夹添加/);
      assert.strictEqual(await read("keep.txt"), "keep");
    } finally {
      vscode.window.showWarningMessage = originalWarning;
      vscode.window.showErrorMessage = originalError;
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.cancelExport");
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });

  test("clearing persists an empty selection and resets excluded descendants without deleting files", async () => {
    await vscode.workspace.fs.writeFile(uri("keep.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("hidden.txt"), Buffer.from("hidden"));
    await tree.add([root]);
    await tree.remove(uri("hidden.txt"));
    await tree.clear();
    assert.deepStrictEqual(await tree.getChildren(), []);
    assert.deepStrictEqual(await tree.getSelectedResources(), []);
    assert.strictEqual(await read("keep.txt"), "keep");
    assert.strictEqual(await read("hidden.txt"), "hidden");
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.deepStrictEqual(await tree.getChildren(), []);
    await tree.add([root]);
    assert.strictEqual((await tree.getChildren(root)).length, 2);
  });

  test("menu membership includes descendants, respects exclusions, and restores saved selection", async () => {
    await vscode.workspace.fs.createDirectory(uri("nested/hidden"));
    await vscode.workspace.fs.writeFile(uri("nested/space #中文%.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("nested/hidden/file.txt"), Buffer.from("hidden"));
    await vscode.workspace.fs.writeFile(uri("outside.txt"), Buffer.from("outside"));
    await tree.add([uri("nested")]);
    const all = ["nested", "nested/hidden", "nested/hidden/file.txt", "nested/space #中文%.txt"].map(name => uri(name).toString()).sort();
    assert.deepStrictEqual((await tree.getSelectedResources()).sort(), all);
    await tree.remove(uri("nested/hidden"));
    const visible = [uri("nested").toString(), uri("nested/space #中文%.txt").toString()].sort();
    assert.deepStrictEqual((await tree.getSelectedResources()).sort(), visible);
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.deepStrictEqual((await tree.getSelectedResources()).sort(), visible);
    await tree.add([uri("nested/hidden")]);
    assert.deepStrictEqual((await tree.getSelectedResources()).sort(), all);
    await vscode.workspace.fs.writeFile(uri("nested/new.txt"), Buffer.from("new"));
    assert.ok((await tree.getSelectedResources()).includes(uri("nested/new.txt").toString()));
    await vscode.workspace.fs.delete(uri("nested/new.txt"));
    assert.deepStrictEqual((await tree.getSelectedResources()).sort(), all);
  });

  test("publishes updated menu membership after commands and external file changes", async () => {
    await vscode.workspace.fs.writeFile(uri("keep.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("hidden.txt"), Buffer.from("hidden"));
    const originalExecute = vscode.commands.executeCommand;
    let resources: string[] = [];
    vscode.commands.executeCommand = ((command: string, ...args: unknown[]) => {
      if (command === "setContext" && args[0] === "naruto.virtualWorkspace.resources") {
        resources = args[1] as string[];
      }
      return originalExecute(command, ...args);
    }) as typeof originalExecute;
    const expectResources = async (names: string[]) => {
      const expected = names.map(name => name ? uri(name).toString() : root.toString()).sort();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (JSON.stringify([...resources].sort()) === JSON.stringify(expected)) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.deepStrictEqual([...resources].sort(), expected);
    };
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.add", root);
      await expectResources(["", "keep.txt", "hidden.txt"]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", uri("hidden.txt"));
      await expectResources(["", "keep.txt"]);
      await vscode.workspace.fs.writeFile(uri("new.txt"), Buffer.from("new"));
      await expectResources(["", "keep.txt", "new.txt"]);
      const rename = new vscode.WorkspaceEdit();
      rename.renameFile(uri("keep.txt"), uri("renamed.txt"));
      await applyFileEdit(rename);
      await expectResources(["", "renamed.txt", "new.txt"]);
      await vscode.workspace.fs.delete(uri("new.txt"));
      await expectResources(["", "renamed.txt"]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await expectResources([]);
    } finally {
      vscode.commands.executeCommand = originalExecute;
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
    }
  });

  test("standalone skill output applies ordered operations through the real importer", async () => {
    const isolated = join(root.fsPath, "isolated-skill");
    await cp(resolve(__dirname, "../../../../skills/naruto-import/scripts"), isolated, { recursive: true });
    const cli = join(isolated, "naruto.mjs");
    const input = join(isolated, "changes.json");
    const output = join(isolated, "changes.naruto.txt");
    const decoded = join(isolated, "decoded.json");
    const content = "export const message = '你好 🍥';\r\n// $() `quotes` :base64:\r\n";
    const binary = Buffer.from([0, 255, 128, 10, 13]);
    await vscode.workspace.fs.writeFile(uri("old.txt"), Buffer.from("old"));
    await vscode.workspace.fs.writeFile(uri("remove.txt"), Buffer.from("remove"));
    const changes = packet([
      { ...location("moved"), action: "mkdir" },
      { ...location("old.txt"), action: "rename", to: location("moved/new.txt").path },
      write("moved/new.txt", content),
      { ...location("binary.bin"), action: "create", encoding: "base64", content: binary.toString("base64") },
      { ...location("empty"), action: "mkdir" },
      { ...location("remove.txt"), action: "delete" },
    ]);
    await writeFile(input, JSON.stringify(changes));
    execFileSync("node", [cli, "encode", input, output], { cwd: isolated });
    const compressed = await readFile(output, "utf8");
    assert.strictEqual(await tree.importText(compressed), changes.operations.length);
    assert.strictEqual(await read("moved/new.txt"), content);
    assert.deepStrictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri("binary.bin"))), binary);
    assert.strictEqual((await vscode.workspace.fs.stat(uri("empty"))).type, vscode.FileType.Directory);
    await assert.rejects(async () => vscode.workspace.fs.stat(uri("old.txt")));
    await assert.rejects(async () => vscode.workspace.fs.stat(uri("remove.txt")));
    execFileSync("node", [cli, "decode", output, decoded], { cwd: isolated });
    assert.deepStrictEqual(JSON.parse(await readFile(decoded, "utf8")), changes);
    const exported = await tree.exportText();
    await writeFile(output, exported);
    const exportedJSON = execFileSync("node", [cli, "decode", output], { cwd: isolated, encoding: "utf8" });
    assert.deepStrictEqual(JSON.parse(exportedJSON), await decodePacket(exported));
  });

  test("skill rejects invalid import paths before overwriting its output", async () => {
    const isolated = join(root.fsPath, "isolated-skill");
    await mkdir(isolated);
    const cli = resolve(__dirname, "../../../../skills/naruto-import/scripts/naruto.mjs");
    const input = join(isolated, "changes.json");
    const output = join(isolated, "changes.naruto.txt");
    await writeFile(input, JSON.stringify(packet([{ ...write("file.txt", "unsafe"), path: "../outside.txt" }])));
    await writeFile(output, "keep previous output");
    assert.throws(() => execFileSync("node", [cli, "encode", input, output], { cwd: isolated, stdio: "pipe" }));
    assert.strictEqual(await readFile(output, "utf8"), "keep previous output");
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
