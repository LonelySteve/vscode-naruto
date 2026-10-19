import * as assert from "assert";
import * as vscode from "vscode";
import { createHash, randomBytes } from "crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "fs/promises";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import createCompress from "compress-brotli";
import { base91Decode, base91Encode } from "../base91";
import { VirtualWorkspace, WorkspaceExporter, selectedExportScope } from "../virtualWorkspace";
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
  const originalInformation = vscode.window.showInformationMessage;
  const uri = (name: string) => vscode.Uri.joinPath(root, name);
  const read = async (name: string) => Buffer.from(await vscode.workspace.fs.readFile(uri(name))).toString("utf8");
  const location = (name: string) => ({ workspace: folder.name, path: `${root.path.slice(folder.uri.path.length + 1)}/${name}` });
  const packet = (operations: WorkspaceOperation[]): WorkspacePacket => ({ format: "naruto-virtual-workspace", version: 1, operations });
  const write = (name: string, content: string): WorkspaceOperation => ({ ...location(name), action: "write", encoding: "utf8", content });
  const apply = (data: WorkspacePacket) => applyPacket(data, async () => {});

  setup(async () => {
    vscode.window.showInformationMessage = (async () => undefined) as typeof originalInformation;
    folder = vscode.workspace.workspaceFolders![0];
    assert.ok(folder, "Tests must run in the temporary workspace from .vscode-test.mjs");
    root = vscode.Uri.joinPath(folder.uri, `case-${sequence++}`);
    await vscode.workspace.fs.createDirectory(root);
    state = memoryState();
    tree = new VirtualWorkspace(state);
  });

  teardown(async () => {
    vscode.window.showInformationMessage = originalInformation;
    tree.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace.fs.delete(root, { recursive: true });
  });

  test("registers the view and requested commands", async () => {
    const extension = vscode.extensions.all.find(item => item.packageJSON.name === "naruto")!;
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["add", "addCurrentFile", "remove", "removeCurrentFile", "clear", "import", "export", "cancelExport", "setIncrementalMode", "setFullMode", "filter", "clearFilter", "sortAdded", "sortFiles", "rename", "delete", "newFile", "newFolder"]) {
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
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
      assert.deepStrictEqual((await decodePacket(await vscode.env.clipboard.readText())).operations, [write("keep.txt", "keep")]);
      // Start another export; confirming clear must also cancel its remaining blocks.
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
      choice = "清空";
      await vscode.commands.executeCommand("naruto.virtualWorkspace.clear");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      const header = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      const chunks: string[] = [];
      for (let i = 0; i < header.chunkCount; i++) {
        await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
        chunks.push(await vscode.env.clipboard.readText());
      }
      assert.deepStrictEqual((await decodePacket(chunks.join(""))).operations, [{ ...location("keep.txt"), action: "delete" }]);
      assert.strictEqual(errorMessage, undefined);
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
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
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

  test("root sorting switches between insertion order and natural Explorer order and persists", async () => {
    await vscode.workspace.fs.createDirectory(uri("folder10"));
    await vscode.workspace.fs.createDirectory(uri("folder2"));
    for (const name of ["file10.txt", "file2.txt"]) { await vscode.workspace.fs.writeFile(uri(name), Buffer.from(name)); }
    const added = ["file10.txt", "folder10", "file2.txt", "folder2"];
    await tree.add(added.map(uri));
    assert.deepStrictEqual((await tree.getChildren()).map(item => item.path.split("/").pop()), added);
    await tree.setSortOrder("files");
    assert.deepStrictEqual((await tree.getChildren()).map(item => item.path.split("/").pop()), ["folder2", "folder10", "file2.txt", "file10.txt"]);
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.strictEqual(tree.getSortOrder(), "files");
    await tree.setSortOrder("added");
    assert.deepStrictEqual((await tree.getChildren()).map(item => item.path.split("/").pop()), added);
  });

  test("filename filtering preserves ancestors, respects exclusions, and rejects invalid patterns", async () => {
    await vscode.workspace.fs.createDirectory(uri("nested/deep"));
    await vscode.workspace.fs.writeFile(uri("nested/deep/Target.ts"), Buffer.from("target"));
    await vscode.workspace.fs.writeFile(uri("nested/hidden.ts"), Buffer.from("hidden"));
    await vscode.workspace.fs.writeFile(uri("other.txt"), Buffer.from("other"));
    await tree.add([root]);
    await tree.remove(uri("nested/hidden.ts"));
    tree.setFilter({ query: ".ts", matchCase: false, wholeWord: false, regex: false });
    assert.deepStrictEqual((await tree.getChildren(root)).map(item => item.toString()), [uri("nested").toString()]);
    assert.deepStrictEqual((await tree.getChildren(uri("nested"))).map(item => item.toString()), [uri("nested/deep").toString()]);
    assert.deepStrictEqual((await tree.getFilteredFiles()).map(item => item.toString()), [uri("nested/deep/Target.ts").toString()]);
    assert.strictEqual((await tree.getTreeItem(uri("nested"))).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.throws(() => tree.setFilter({ query: "[", matchCase: false, wholeWord: false, regex: true }));
    assert.strictEqual(tree.getFilter().query, ".ts");
    await tree.saveFilter();
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.strictEqual(tree.getFilter().query, ".ts");
    tree.setFilter({ ...tree.getFilter(), query: "no-match" });
    assert.deepStrictEqual(await tree.getChildren(), []);
    tree.setFilter({ ...tree.getFilter(), query: "" });
    assert.strictEqual((await tree.getChildren(root)).length, 2);
    // Filtering is a display/range choice, not a removal from the virtual workspace baseline.
    assert.ok((await tree.prepareExport()).packet.operations.some(op => op.path === location("other.txt").path));
  });

  test("filter controls drive title exports and an empty result never falls back to a full export", async () => {
    for (const name of ["keep.ts", "other.txt"]) { await vscode.workspace.fs.writeFile(uri(name), Buffer.from(name)); }
    await vscode.commands.executeCommand("naruto.virtualWorkspace.add", root);
    await vscode.commands.executeCommand("list.selectAll");
    const originalInput = vscode.window.createInputBox;
    const originalError = vscode.window.showErrorMessage;
    const oldClipboard = await vscode.env.clipboard.readText();
    let error = "";
    let query = "^keep\\.ts$";
    let first = true;
    let clear = false;
    vscode.window.showErrorMessage = (async (message: string) => { error = message; return undefined; }) as typeof originalError;
    vscode.window.createInputBox = () => {
      const changed = new vscode.EventEmitter<string>();
      const triggered = new vscode.EventEmitter<vscode.QuickInputButton>();
      const accepted = new vscode.EventEmitter<void>();
      const hidden = new vscode.EventEmitter<void>();
      const input = {
        value: "", buttons: [] as readonly vscode.QuickInputButton[], validationMessage: undefined,
        onDidChangeValue: changed.event, onDidTriggerButton: triggered.event, onDidAccept: accepted.event, onDidHide: hidden.event,
        show() {
          input.value = query;
          changed.fire(query);
          if (first) {
            triggered.fire(input.buttons[2]);
            first = false;
          }
          if (clear) { triggered.fire(input.buttons[3]); }
          accepted.fire();
        },
        hide() { hidden.fire(); },
        dispose() { [changed, triggered, accepted, hidden].forEach(item => item.dispose()); },
      };
      return input as unknown as vscode.InputBox;
    };
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.filter");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      const metadata = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      const chunks: string[] = [];
      for (let i = 0; i < metadata.chunkCount; i++) {
        await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
        chunks.push(await vscode.env.clipboard.readText());
      }
      assert.deepStrictEqual((await decodePacket(chunks.join(""))).operations, [write("keep.ts", "keep.ts")]);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull", root);
      const scopedHeader = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      const scopedChunks: string[] = [];
      for (let i = 0; i < scopedHeader.chunkCount; i++) {
        await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull", root);
        scopedChunks.push(await vscode.env.clipboard.readText());
      }
      assert.deepStrictEqual((await decodePacket(scopedChunks.join(""))).operations, [write("keep.ts", "keep.ts")]);
      query = "missing";
      await vscode.commands.executeCommand("naruto.virtualWorkspace.filter");
      const previous = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export");
      assert.strictEqual(await vscode.env.clipboard.readText(), previous);
      assert.match(error, /没有匹配的文件/);
      clear = true;
      await vscode.commands.executeCommand("naruto.virtualWorkspace.filter");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
      const unfilteredHeader = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      const unfilteredChunks: string[] = [];
      for (let i = 0; i < unfilteredHeader.chunkCount; i++) {
        await vscode.commands.executeCommand("naruto.virtualWorkspace.exportFull");
        unfilteredChunks.push(await vscode.env.clipboard.readText());
      }
      assert.ok((await decodePacket(unfilteredChunks.join(""))).operations.some(op => op.path === location("other.txt").path));
    } finally {
      vscode.window.createInputBox = originalInput;
      vscode.window.showErrorMessage = originalError;
      await vscode.commands.executeCommand("naruto.virtualWorkspace.clearFilter");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });

  test("node export scopes files and folders while preserving paths and exclusions", async () => {
    await vscode.workspace.fs.createDirectory(uri("nested"));
    await vscode.workspace.fs.writeFile(uri("nested/keep.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("nested/hidden.txt"), Buffer.from("hidden"));
    await vscode.workspace.fs.writeFile(uri("outside.txt"), Buffer.from("outside"));
    await tree.add([root]);
    await tree.remove(uri("nested/hidden.txt"));
    assert.deepStrictEqual((await decodePacket(await tree.exportText(uri("nested/keep.txt")))).operations,
      [write("nested/keep.txt", "keep")]);
    assert.deepStrictEqual((await decodePacket(await tree.exportText(uri("nested")))).operations, [
      { ...location("nested"), action: "mkdir" }, write("nested/keep.txt", "keep"),
    ]);
  });

  test("node export commands continue the same node and restart when switching nodes", async () => {
    await vscode.workspace.fs.writeFile(uri("first.txt"), Buffer.from("first"));
    await vscode.workspace.fs.writeFile(uri("second.txt"), Buffer.from("second"));
    await vscode.commands.executeCommand("naruto.virtualWorkspace.add", root);
    const oldClipboard = await vscode.env.clipboard.readText();
    const next = (target?: vscode.Uri) => vscode.commands.executeCommand("naruto.virtualWorkspace.export", target);
    try {
      await next(uri("first.txt"));
      assert.strictEqual(JSON.parse(await vscode.env.clipboard.readText()).chunkCount, 1);
      await next(uri("second.txt"));
      assert.strictEqual(JSON.parse(await vscode.env.clipboard.readText()).chunkCount, 1);
      await next(uri("second.txt"));
      assert.deepStrictEqual((await decodePacket(await vscode.env.clipboard.readText())).operations, [write("second.txt", "second")]);
      await next(uri("first.txt"));
      await vscode.commands.executeCommand("naruto.virtualWorkspace.continueExport");
      assert.deepStrictEqual((await decodePacket(await vscode.env.clipboard.readText())).operations, [write("first.txt", "first")]);
      await next(uri("first.txt"));
      await next();
      assert.strictEqual(JSON.parse(await vscode.env.clipboard.readText()).format, "naruto-virtual-workspace-export");
    } finally {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.cancelExport");
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await vscode.env.clipboard.writeText(oldClipboard);
    }
  });

  test("title and selected item buttons share the selected range; unselected items use their own scope", () => {
    const selected = [uri("one"), uri("two.txt")];
    assert.deepStrictEqual(selectedExportScope(undefined, selected), selected);
    assert.deepStrictEqual(selectedExportScope(uri("two.txt"), selected), selected);
    assert.deepStrictEqual(selectedExportScope(uri("other.txt"), selected).map(item => item.toString()), [uri("other.txt").toString()]);
    assert.deepStrictEqual(selectedExportScope(undefined, []), []);
  });

  test("range exports deduplicate descendants and keep a baseline independent of selection order", async () => {
    await vscode.workspace.fs.createDirectory(uri("nested"));
    await vscode.workspace.fs.writeFile(uri("nested/a.txt"), Buffer.from("a"));
    await vscode.workspace.fs.writeFile(uri("b.txt"), Buffer.from("b"));
    await vscode.workspace.fs.writeFile(uri("outside.txt"), Buffer.from("outside"));
    await tree.add([root]);
    const scope = [uri("nested/a.txt"), uri("b.txt"), uri("nested"), uri("b.txt")];
    const first = await tree.prepareExport(scope);
    assert.deepStrictEqual(first.packet.operations, [
      write("b.txt", "b"), { ...location("nested"), action: "mkdir" }, write("nested/a.txt", "a"),
    ]);
    await first.confirm();
    const reordered = await tree.prepareExport([uri("nested"), uri("b.txt")]);
    assert.strictEqual(reordered.packet.snapshot?.base, first.packet.snapshot?.id);
    assert.deepStrictEqual(reordered.packet.operations, []);
    assert.strictEqual((await tree.prepareExport(uri("b.txt"))).packet.snapshot?.base, undefined);
  });

  test("mixed export modes send full items and changes from incremental items in the same range", async () => {
    await vscode.workspace.fs.createDirectory(uri("full"));
    await vscode.workspace.fs.writeFile(uri("full/keep.txt"), Buffer.from("keep"));
    await vscode.workspace.fs.writeFile(uri("full/removed.txt"), Buffer.from("removed"));
    await vscode.workspace.fs.writeFile(uri("incremental.txt"), Buffer.from("before"));
    await tree.add([root]);
    await tree.setExportMode([uri("full")], "full");
    const scope = [uri("full"), uri("incremental.txt")];
    const initial = await tree.prepareExport(scope);
    await initial.confirm();
    await tree.remove(uri("full/removed.txt"));
    const next = await tree.prepareExport(scope);
    assert.strictEqual(next.packet.snapshot?.base, initial.packet.snapshot?.id);
    assert.deepStrictEqual(next.packet.replace, [location("full")]);
    assert.deepStrictEqual(next.packet.operations, [{ ...location("full"), action: "mkdir" }, write("full/keep.txt", "keep")]);
    await vscode.workspace.fs.writeFile(uri("incremental.txt"), Buffer.from("after"));
    assert.ok((await tree.prepareExport(scope)).packet.operations.some(op => op.path === location("incremental.txt").path && op.action === "write"));
    await tree.setExportMode([uri("incremental.txt")], "full");
    const full = await tree.prepareExport(scope);
    assert.strictEqual(full.packet.snapshot?.base, undefined);
    assert.strictEqual(full.packet.replace, undefined);
  });

  test("per-item modes persist and incremental items show a leading icon", async () => {
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("a"));
    await vscode.workspace.fs.writeFile(uri("b.txt"), Buffer.from("b"));
    await tree.add([root]);
    const initial = await tree.getTreeItem(uri("a.txt"));
    assert.strictEqual((initial.iconPath as vscode.ThemeIcon).id, "diff");
    await tree.setExportMode([uri("a.txt")], "full");
    assert.strictEqual((await tree.getTreeItem(uri("a.txt"))).contextValue, "file:full");
    assert.strictEqual(((await tree.getTreeItem(uri("a.txt"))).iconPath as vscode.ThemeIcon).id, "file");
    tree.dispose();
    tree = new VirtualWorkspace(state);
    assert.strictEqual(tree.getExportMode(uri("a.txt")), "full");
    assert.strictEqual(tree.getExportMode(uri("b.txt")), "incremental");
    await tree.setExportMode([uri("a.txt"), uri("b.txt")], "incremental");
    assert.strictEqual((await tree.getTreeItem(uri("a.txt"))).contextValue, "file:incremental");
  });

  test("commands use multi-selection for export and mode switching", async () => {
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("a"));
    await vscode.workspace.fs.writeFile(uri("b.txt"), Buffer.from("b"));
    await vscode.workspace.fs.writeFile(uri("outside.txt"), Buffer.from("outside"));
    await vscode.commands.executeCommand("naruto.virtualWorkspace.add", root);
    const selected = [uri("a.txt"), uri("b.txt")];
    const oldClipboard = await vscode.env.clipboard.readText();
    const complete = async (clicked?: vscode.Uri) => {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export", clicked, selected);
      const header = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      const chunks: string[] = [];
      for (let i = 0; i < header.chunkCount; i++) {
        await vscode.commands.executeCommand("naruto.virtualWorkspace.export", clicked, selected);
        chunks.push(await vscode.env.clipboard.readText());
      }
      const data = await decodePacket(chunks.join(""));
      assert.deepStrictEqual(header.snapshot, data.snapshot);
      assert.deepStrictEqual(data.operations, [write("a.txt", "a"), write("b.txt", "b")]);
    };
    try {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.setFullMode", uri("a.txt"), selected);
      vscode.window.showInformationMessage = (async () => "接收成功") as typeof originalInformation;
      await complete(uri("b.txt"));
      await complete();
      await vscode.commands.executeCommand("naruto.virtualWorkspace.setIncrementalMode", uri("b.txt"), selected);
      const previous = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand("naruto.virtualWorkspace.export", undefined, selected);
      assert.strictEqual(await vscode.env.clipboard.readText(), previous);
    } finally {
      await vscode.commands.executeCommand("naruto.virtualWorkspace.remove", root);
      await vscode.commands.executeCommand("naruto.virtualWorkspace.cancelExport");
      await vscode.env.clipboard.writeText(oldClipboard);
    }
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

  test("incremental exports use only confirmed snapshots and persist hashes", async () => {
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("first"));
    await tree.add([root]);
    const first = await tree.prepareExport();
    assert.deepStrictEqual((await tree.prepareExport()).packet, first.packet);
    assert.strictEqual(first.packet.snapshot?.base, undefined);
    await first.confirm();
    assert.strictEqual((await tree.prepareExport()).packet.snapshot?.base, first.packet.snapshot?.id);
    assert.deepStrictEqual((await tree.prepareExport()).packet.operations, []);
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("second"));
    assert.deepStrictEqual((await tree.prepareExport()).packet.operations, [write("a.txt", "second")]);
    const recreated = new VirtualWorkspace(state);
    try {
      assert.deepStrictEqual((await recreated.prepareExport()).packet.operations, [write("a.txt", "second")]);
    } finally { recreated.dispose(); }
    await tree.remove(uri("a.txt"));
    assert.deepStrictEqual((await tree.prepareExport()).packet.operations, [{ ...location("a.txt"), action: "delete" }]);
    assert.strictEqual(await read("a.txt"), "second");
    const full = await tree.prepareExport(undefined, true);
    assert.strictEqual(full.packet.snapshot?.base, undefined);
    assert.ok(full.packet.operations.every(op => op.action !== "delete"));
  });

  test("removal configuration preserves deselected files but exports real deletions", async () => {
    const config = vscode.workspace.getConfiguration("naruto");
    await config.update("virtualWorkspace.deleteRemoved", false, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("first"));
      await tree.add([root]);
      await (await tree.prepareExport()).confirm();
      await tree.remove(uri("a.txt"));
      assert.deepStrictEqual((await tree.prepareExport()).packet.operations, []);
      await vscode.workspace.fs.delete(uri("a.txt"));
      assert.deepStrictEqual((await tree.prepareExport()).packet.operations, [{ ...location("a.txt"), action: "delete" }]);
    } finally {
      await config.update("virtualWorkspace.deleteRemoved", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("incremental completion advances the baseline only after successful reception", async () => {
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("first"));
    await tree.add([uri("a.txt")]);
    const exporter = new WorkspaceExporter(tree);
    const originalClipboard = await vscode.env.clipboard.readText();
    await (await tree.prepareExport()).confirm();
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("changed"));
    let answer: string | undefined = "接收失败";
    vscode.window.showInformationMessage = (async () => answer) as typeof originalInformation;
    try {
      for (const success of [false, true]) {
        answer = success ? "接收成功" : "接收失败";
        await exporter.next();
        const metadata = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
        for (let i = 0; i < metadata.chunkCount; i++) { await exporter.next(); }
        assert.strictEqual((await tree.prepareExport()).packet.operations.length, success ? 0 : 1);
      }
    } finally {
      exporter.dispose();
      await vscode.env.clipboard.writeText(originalClipboard);
    }
  });

  test("full completion records the baseline without confirmation; cancelled copies do not", async () => {
    await vscode.workspace.fs.writeFile(uri("a.txt"), Buffer.from("a"));
    await tree.add([uri("a.txt")]);
    const exporter = new WorkspaceExporter(tree);
    const oldClipboard = await vscode.env.clipboard.readText();
    let prompts = 0;
    vscode.window.showInformationMessage = (async () => { prompts++; return undefined; }) as typeof originalInformation;
    try {
      await exporter.next();
      exporter.cancel();
      assert.strictEqual((await tree.prepareExport()).packet.snapshot?.base, undefined);
      await exporter.next();
      const header = JSON.parse(await vscode.env.clipboard.readText()) as WorkspaceExportMetadata;
      for (let i = 0; i < header.chunkCount; i++) { await exporter.next(); }
      assert.strictEqual(prompts, 0);
      assert.strictEqual((await tree.prepareExport()).packet.snapshot?.base, header.snapshot?.id);
      assert.deepStrictEqual((await tree.prepareExport()).packet.operations, []);
    } finally {
      exporter.dispose();
      await vscode.env.clipboard.writeText(oldClipboard);
    }
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
    const exported = await encodePacket((await tree.prepareExport()).packet);
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
