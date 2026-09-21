import * as vscode from "vscode";
import * as path from "path";
import {
  applyFileEdit, applyPacket, containsUri, createExportBlocks, decodePacket, encodePacket,
  snapshotWorkspace, workspaceLocation,
} from "./workspaceTransfer";

interface Selection {
  roots: string[];
  excluded: string[];
}

export class VirtualWorkspace implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: vscode.Uri[];
  private excluded: vscode.Uri[];
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly state: vscode.Memento) {
    const selection = state.get<Selection>("naruto.virtualWorkspace", { roots: [], excluded: [] });
    this.roots = selection.roots.map(value => vscode.Uri.parse(value));
    this.excluded = selection.excluded.map(value => vscode.Uri.parse(value));
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.refreshIfSelected(uri)),
      watcher.onDidDelete(uri => this.refreshIfSelected(uri)),
      vscode.workspace.onDidRenameFiles(event => {
        void this.followRenames(event.files).catch(error => vscode.window.showErrorMessage(String(error)));
      }),
      vscode.workspace.onDidDeleteFiles(event => {
        void this.forgetDeleted(event.files).catch(error => vscode.window.showErrorMessage(String(error)));
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
    );
  }

  dispose(): void {
    this.disposables.forEach(item => item.dispose());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  private refreshIfSelected(uri: vscode.Uri): void {
    if (this.roots.some(root => containsUri(root, uri) || containsUri(uri, root))) {
      this.refresh();
    }
  }

  private async persist(): Promise<void> {
    await this.state.update("naruto.virtualWorkspace", {
      roots: this.roots.map(uri => uri.toString()),
      excluded: this.excluded.map(uri => uri.toString()),
    } satisfies Selection);
    this.refresh();
  }

  async add(uris: readonly vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      workspaceLocation(uri);
      await vscode.workspace.fs.stat(uri);
    }
    for (const uri of uris) {
      this.excluded = this.excluded.filter(item => !containsUri(item, uri) && !containsUri(uri, item));
      if (!this.roots.some(root => containsUri(root, uri))) {
        this.roots = this.roots.filter(root => !containsUri(uri, root));
        this.roots.push(uri);
      }
    }
    await this.persist();
  }

  async remove(uri: vscode.Uri): Promise<void> {
    this.roots = this.roots.filter(root => !containsUri(uri, root));
    this.excluded = this.excluded.filter(item => !containsUri(uri, item));
    if (this.roots.some(root => containsUri(root, uri)) && !this.excluded.some(item => containsUri(item, uri))) {
      this.excluded.push(uri);
    }
    await this.persist();
  }

  async clear(): Promise<void> {
    this.roots = [];
    this.excluded = [];
    await this.persist();
  }

  async getSelectedResources(): Promise<string[]> {
    const resources: string[] = [];
    const excluded = this.excluded;
    const visit = async (uri: vscode.Uri, type?: vscode.FileType): Promise<void> => {
      if (excluded.some(item => containsUri(item, uri))) {
        return;
      }
      try {
        type ??= (await vscode.workspace.fs.stat(uri)).type;
        resources.push(uri.toString());
        // Include links themselves, but never follow them while building menus.
        if ((type & vscode.FileType.Directory) && !(type & vscode.FileType.SymbolicLink)) {
          for (const [name, childType] of await vscode.workspace.fs.readDirectory(uri)) {
            await visit(vscode.Uri.joinPath(uri, name), childType);
          }
        }
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
          throw error;
        }
      }
    };
    for (const root of this.roots) {
      if (vscode.workspace.getWorkspaceFolder(root)) {
        await visit(root);
      }
    }
    return resources;
  }

  async followRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const move = (uri: vscode.Uri) => {
      const file = files.find(item => containsUri(item.oldUri, uri));
      return file ? file.newUri.with({ path: file.newUri.path + uri.path.slice(file.oldUri.path.length) }) : uri;
    };
    this.roots = this.roots.map(move);
    this.excluded = this.excluded.map(move);
    // Moving a selected file into a selected folder must not duplicate its export.
    this.roots = this.roots.filter((uri, index, roots) => !roots.some((other, otherIndex) =>
      otherIndex !== index && containsUri(other, uri) && (other.path !== uri.path || otherIndex < index)));
    await this.persist();
  }

  async forgetDeleted(uris: readonly vscode.Uri[]): Promise<void> {
    this.roots = this.roots.filter(root => !uris.some(uri => containsUri(uri, root)));
    this.excluded = this.excluded.filter(item => !uris.some(uri => containsUri(uri, item)));
    await this.persist();
  }

  async getChildren(parent?: vscode.Uri): Promise<vscode.Uri[]> {
    if (parent) {
      const children = await vscode.workspace.fs.readDirectory(parent);
      return children
        .filter(([name]) => !this.excluded.some(item => containsUri(item, vscode.Uri.joinPath(parent, name))))
        .sort(([a, aType], [b, bType]) => Number(Boolean(bType & vscode.FileType.Directory)) - Number(Boolean(aType & vscode.FileType.Directory)) || a.localeCompare(b))
        .map(([name]) => vscode.Uri.joinPath(parent, name));
    }
    const visible: vscode.Uri[] = [];
    for (const root of this.roots) {
      if (!vscode.workspace.getWorkspaceFolder(root)) {
        continue;
      }
      try {
        await vscode.workspace.fs.stat(root);
        visible.push(root);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
          throw error;
        }
      }
    }
    return visible;
  }

  async getTreeItem(uri: vscode.Uri): Promise<vscode.TreeItem> {
    const directory = Boolean((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory);
    const item = new vscode.TreeItem(uri, directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const isWorkspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === uri.toString();
    item.contextValue = isWorkspaceRoot ? "workspaceRoot" : directory ? "directory" : "file";
    item.iconPath = new vscode.ThemeIcon(directory ? "folder" : "file");
    item.tooltip = uri.fsPath;
    if (this.roots.some(root => root.toString() === uri.toString())) {
      item.description = vscode.workspace.asRelativePath(uri, true);
    }
    if (!directory) {
      item.command = { command: "vscode.open", title: "打开文件", arguments: [uri] };
    }
    return item;
  }

  async exportText(): Promise<string> {
    const roots = await this.getChildren();
    if (!roots.length) {
      throw new Error("请先将文件或文件夹添加到 Naruto 虚拟工作区");
    }
    return encodePacket(await snapshotWorkspace(roots, this.excluded));
  }

  async importText(text: string): Promise<number> {
    const packet = await decodePacket(text);
    return applyPacket(packet, async (op, uri, destination) => {
      // Rename/delete events already maintain existing selections.
      if (op.action !== "delete") {
        await this.add([destination ?? uri]);
      }
    });
  }
}

export class WorkspaceExporter implements vscode.Disposable {
  private session?: { chunks?: string[]; copied: number };
  private busy = false;
  private readonly progress = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly cancelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);

  constructor(private readonly workspace: VirtualWorkspace) {
    this.progress.name = "Naruto 导出进度";
    this.cancelItem.name = "取消 Naruto 导出";
    this.cancelItem.text = "$(close) 取消 Naruto 导出";
    this.cancelItem.command = "naruto.virtualWorkspace.cancelExport";
    this.cancelItem.tooltip = "取消剩余分块的复制，保留当前剪贴板内容";
  }

  async next(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    const session = this.session ?? { copied: 0 };
    this.session = session;
    try {
      if (!session.chunks) {
        this.progress.text = "$(loading~spin) Naruto 正在准备导出";
        this.progress.command = undefined;
        this.progress.show();
        this.cancelItem.show();
        const text = await this.workspace.exportText();
        const size = vscode.workspace.getConfiguration("naruto").get<number>("virtualWorkspace.chunkSize", 256);
        session.chunks = createExportBlocks(text, size);
      }
      if (this.session !== session) {
        return;
      }
      await vscode.env.clipboard.writeText(session.chunks[session.copied]);
      if (this.session !== session) {
        return;
      }
      session.copied++;
      const done = session.copied === session.chunks.length;
      const copiedDataChunks = session.copied - 1;
      const dataChunkCount = session.chunks.length - 1;
      this.progress.text = `$(clippy) Naruto ${copiedDataChunks}/${dataChunkCount}${done ? " 已复制完成" : copiedDataChunks === 0 ? " · 元信息已复制" : " · 复制下一块"}`;
      this.progress.tooltip = done ? "本次导出完成；点击可关闭进度" : copiedDataChunks === 0
        ? "请先粘贴起始元信息，再点击复制第 1 个数据块"
        : "请先粘贴当前数据块，再点击复制下一块";
      this.progress.command = done ? "naruto.virtualWorkspace.cancelExport" : "naruto.virtualWorkspace.export";
      if (done) {
        this.session = undefined;
        this.cancelItem.hide();
      }
    } catch (error) {
      // A failed clipboard write leaves the current chunk available for retry.
      if (!session.chunks) {
        this.cancel();
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  cancel(): void {
    this.session = undefined;
    this.progress.hide();
    this.cancelItem.hide();
  }

  dispose(): void {
    this.cancel();
    this.progress.dispose();
    this.cancelItem.dispose();
  }
}

function currentFile(): vscode.Uri {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    throw new Error("没有当前文件");
  }
  workspaceLocation(uri);
  return uri;
}

async function targetDirectory(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri) {
    return (await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, "..");
  }
  return (await vscode.window.showWorkspaceFolderPick({ placeHolder: "选择新建项目所属的真实工作区" }))?.uri;
}

async function requestName(prompt: string, value = ""): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt, value,
    validateInput: name => !name.trim() || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name)
      ? "请输入不包含路径分隔符的文件或文件夹名称" : undefined,
  });
}

function assertNotWorkspaceRoot(uri: vscode.Uri): void {
  if (workspaceLocation(uri).path === ".") {
    throw new Error("不能在 Naruto 中删除或重命名真实工作区根目录");
  }
}

export function registerVirtualWorkspace(context: vscode.ExtensionContext): void {
  const workspace = new VirtualWorkspace(context.workspaceState);
  const exporter = new WorkspaceExporter(workspace);
  const view = vscode.window.createTreeView("naruto.virtualWorkspace", { treeDataProvider: workspace, canSelectMany: true });
  context.subscriptions.push(workspace, exporter, view);

  let menuRevision = 0;
  async function updateMenuContext(): Promise<void> {
    const revision = ++menuRevision;
    try {
      const resources = await workspace.getSelectedResources();
      // A directory scan must not restore stale menus after a newer selection change.
      if (revision === menuRevision) {
        await vscode.commands.executeCommand("setContext", "naruto.virtualWorkspace.resources", resources);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Naruto：更新工作区菜单失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  context.subscriptions.push(workspace.onDidChangeTreeData(() => { void updateMenuContext(); }));
  void updateMenuContext();

  function register(id: string, callback: (...args: any[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(`naruto.virtualWorkspace.${id}`, async (...args) => {
      try {
        await callback(...args);
      } catch (error) {
        await vscode.window.showErrorMessage(`Naruto：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  register("add", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
    await workspace.add(selected?.length ? selected : [uri ?? currentFile()]);
    await vscode.commands.executeCommand("naruto.virtualWorkspace.focus");
  });
  register("addCurrentFile", async () => {
    await workspace.add([currentFile()]);
    await vscode.commands.executeCommand("naruto.virtualWorkspace.focus");
  });
  register("removeCurrentFile", () => workspace.remove(currentFile()));
  register("remove", async (uri: vscode.Uri, selected?: vscode.Uri[]) => {
    for (const item of selected?.length ? selected : [uri]) {
      await workspace.remove(item);
    }
  });
  register("refresh", () => workspace.refresh());
  register("clear", async () => {
    const choice = await vscode.window.showWarningMessage(
      "确定清空 Naruto 虚拟工作区？",
      { modal: true, detail: "将移除所有虚拟工作区选择项并取消当前导出，真实文件和文件夹不会被删除。" },
      "清空"
    );
    if (choice !== "清空") {
      return;
    }
    await workspace.clear();
    exporter.cancel();
  });
  register("rename", async (uri: vscode.Uri) => {
    assertNotWorkspaceRoot(uri);
    const name = await requestName("重命名真实文件或文件夹", path.posix.basename(uri.path));
    if (!name || name === path.posix.basename(uri.path)) {
      return;
    }
    const destination = vscode.Uri.joinPath(uri, "..", name);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, destination, { overwrite: false });
    await applyFileEdit(edit);
  });
  register("delete", async (uri: vscode.Uri, selected?: vscode.Uri[]) => {
    const uris = selected?.length ? selected : [uri];
    uris.forEach(assertNotWorkspaceRoot);
    const choice = await vscode.window.showWarningMessage(
      `将从真实工作区删除 ${uris.length} 个项目及其内容。`,
      { modal: true, detail: uris.map(item => vscode.workspace.asRelativePath(item)).join("\n") },
      "删除"
    );
    if (choice !== "删除") {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    uris.filter(item => !uris.some(other => other !== item && containsUri(other, item)))
      .forEach(item => edit.deleteFile(item, { recursive: true }));
    await applyFileEdit(edit);
  });
  for (const directory of [false, true]) {
    register(directory ? "newFolder" : "newFile", async (uri?: vscode.Uri) => {
      const parent = await targetDirectory(uri);
      if (!parent) {
        return;
      }
      const name = await requestName(directory ? "新建文件夹" : "新建文件");
      if (!name) {
        return;
      }
      const destination = vscode.Uri.joinPath(parent, name);
      if (directory) {
        try {
          await vscode.workspace.fs.stat(destination);
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
            throw error;
          }
          await vscode.workspace.fs.createDirectory(destination);
          await workspace.add([destination]);
          return;
        }
        throw new Error("同名文件或文件夹已存在");
      }
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(destination);
      await applyFileEdit(edit);
      await workspace.add([destination]);
      await vscode.commands.executeCommand("vscode.open", destination);
    });
  }
  register("export", () => exporter.next());
  register("cancelExport", () => exporter.cancel());
  register("import", async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text.trim()) {
      throw new Error("剪贴板为空，请先复制完整的压缩文本");
    }
    const count = await workspace.importText(text);
    await vscode.window.showInformationMessage(`Naruto：已应用 ${count} 项操作`);
  });
}
