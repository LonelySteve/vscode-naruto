import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import { FileNameFilter, fileNameMatcher, showFileNameFilter } from "./workspaceFilter";
import {
  applyFileEdit, applyPacket, containsUri, createExportBlocks, decodePacket, encodePacket,
  snapshotWorkspace, workspaceLocation, WorkspacePacket, Location,
} from "./workspaceTransfer";

type SortOrder = "added" | "files";

type ExportMode = "incremental" | "full";
type ExportScope = vscode.Uri | readonly vscode.Uri[];

export function selectedExportScope(uri: vscode.Uri | undefined, selection: readonly vscode.Uri[]): readonly vscode.Uri[] {
  if (uri && !selection.some(item => item.toString() === uri.toString())) {
    return [uri];
  }
  return selection;
}

function normalizeScope(scope: readonly vscode.Uri[]): vscode.Uri[] {
  return [...new Map(scope.map(uri => [uri.toString(), uri])).values()]
    .filter(uri => !scope.some(parent => parent.toString() !== uri.toString() && containsUri(parent, uri)))
    .sort((a, b) => a.toString().localeCompare(b.toString()));
}

function scopeRoots(scope?: ExportScope): vscode.Uri[] {
  return normalizeScope(scope instanceof vscode.Uri ? [scope] : scope ?? []);
}

interface ExportBaseline {
  snapshot: string;
  entries: Record<string, { workspace: string; path: string; hash: string; uri: string; action: string }>;
}

interface Selection {
  roots: string[];
  excluded: string[];
}

export class VirtualWorkspace implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: vscode.Uri[];
  private excluded: vscode.Uri[];
  private sortOrder: SortOrder;
  private filter: FileNameFilter;
  private matchesName: (name: string) => boolean;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly state: vscode.Memento) {
    const selection = state.get<Selection>("naruto.virtualWorkspace", { roots: [], excluded: [] });
    this.sortOrder = state.get<SortOrder>("naruto.sortOrder", "added");
    this.filter = state.get<FileNameFilter>("naruto.fileNameFilter", { query: "", matchCase: false, wholeWord: false, regex: false });
    this.matchesName = fileNameMatcher(this.filter);
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
    const modes = this.state.get<Record<string, ExportMode>>("naruto.exportModes", {});
    await this.state.update("naruto.exportModes", Object.fromEntries(Object.entries(modes).map(([uri, mode]) => [move(vscode.Uri.parse(uri)).toString(), mode])));
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

  getSortOrder(): SortOrder { return this.sortOrder; }

  async setSortOrder(order: SortOrder): Promise<void> {
    this.sortOrder = order;
    await this.state.update("naruto.sortOrder", order);
    this.refresh();
  }

  getFilter(): FileNameFilter { return { ...this.filter }; }

  setFilter(filter: FileNameFilter): void {
    const matcher = fileNameMatcher(filter);
    this.filter = { ...filter };
    this.matchesName = matcher;
    this.refresh();
  }

  async saveFilter(): Promise<void> {
    await this.state.update("naruto.fileNameFilter", this.filter);
  }

  private async getRoots(): Promise<{ uri: vscode.Uri; type: vscode.FileType }[]> {
    const visible: { uri: vscode.Uri; type: vscode.FileType }[] = [];
    for (const root of this.roots) {
      if (!vscode.workspace.getWorkspaceFolder(root)) { continue; }
      try {
        visible.push({ uri: root, type: (await vscode.workspace.fs.stat(root)).type });
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) { throw error; }
      }
    }
    return visible;
  }

  async getFilteredFiles(roots?: readonly vscode.Uri[]): Promise<vscode.Uri[]> {
    const matches: vscode.Uri[] = [];
    const visit = async (uri: vscode.Uri, type?: vscode.FileType): Promise<void> => {
      if (this.excluded.some(item => containsUri(item, uri))) { return; }
      type ??= (await vscode.workspace.fs.stat(uri)).type;
      if (type & vscode.FileType.Directory) {
        if (type & vscode.FileType.SymbolicLink) { return; }
        for (const [name, childType] of await vscode.workspace.fs.readDirectory(uri)) {
          await visit(vscode.Uri.joinPath(uri, name), childType);
        }
      } else if (this.matchesName(path.posix.basename(uri.path))) {
        matches.push(uri);
      }
    };
    for (const uri of roots ?? (await this.getRoots()).map(item => item.uri)) { await visit(uri); }
    return matches;
  }

  async getChildren(parent?: vscode.Uri): Promise<vscode.Uri[]> {
    let children = parent
      ? (await vscode.workspace.fs.readDirectory(parent)).map(([name, type]) => ({ uri: vscode.Uri.joinPath(parent, name), type }))
      : await this.getRoots();
    children = children.filter(({ uri }) => !this.excluded.some(item => containsUri(item, uri)));
    if (parent || this.sortOrder === "files") {
      children.sort((a, b) => Number(Boolean(b.type & vscode.FileType.Directory)) - Number(Boolean(a.type & vscode.FileType.Directory)) ||
        path.posix.basename(a.uri.path).localeCompare(path.posix.basename(b.uri.path), undefined, { numeric: true, sensitivity: "base" }));
    }
    if (this.filter.query) {
      const matches = await this.getFilteredFiles(parent ? [parent] : undefined);
      children = children.filter(({ uri }) => matches.some(match => containsUri(uri, match)));
    }
    return children.map(item => item.uri);
  }

  getExportMode(uri: vscode.Uri): ExportMode {
    return this.state.get<Record<string, ExportMode>>("naruto.exportModes", {})[uri.toString()] ?? "incremental";
  }

  async setExportMode(uris: readonly vscode.Uri[], mode: ExportMode): Promise<void> {
    const modes = this.state.get<Record<string, ExportMode>>("naruto.exportModes", {});
    for (const uri of uris) { modes[uri.toString()] = mode; }
    await this.state.update("naruto.exportModes", modes);
    this.refresh();
  }

  async getTreeItem(uri: vscode.Uri): Promise<vscode.TreeItem> {
    const directory = Boolean((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory);
    const item = new vscode.TreeItem(uri, directory ? (this.filter.query ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = uri.toString();
    const isWorkspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === uri.toString();
    const mode = this.getExportMode(uri);
    item.contextValue = `${isWorkspaceRoot ? "workspaceRoot" : directory ? "directory" : "file"}:${mode}`;
    item.iconPath = new vscode.ThemeIcon(mode === "incremental" ? "diff" : directory ? "folder" : "file");
    item.tooltip = `${uri.fsPath}\n导出模式：${mode === "incremental" ? "增量" : "全量"}`;
    if (this.roots.some(root => root.toString() === uri.toString())) {
      item.description = vscode.workspace.asRelativePath(uri, true);
    }
    if (!directory) {
      item.command = { command: "vscode.open", title: "打开文件", arguments: [uri] };
    }
    return item;
  }

  async exportText(scope?: ExportScope): Promise<string> {
    const selected = scopeRoots(scope);
    const roots = selected.length ? selected : (await this.getRoots()).map(item => item.uri);
    if (!roots.length) {
      throw new Error("请先将文件或文件夹添加到 Naruto 虚拟工作区");
    }
    return encodePacket(await snapshotWorkspace(roots, this.excluded));
  }

  async prepareExport(scope?: ExportScope, full = false): Promise<{ packet: WorkspacePacket; confirm: () => Promise<void> }> {
    const selected = scopeRoots(scope);
    const scopeKey = !selected.length ? "selection" : selected.length === 1 ? selected[0].toString() : `range:${JSON.stringify(selected.map(uri => uri.toString()))}`;
    const key = `naruto.exportBaseline.v2:${scopeKey}`;
    const baseline = this.state.get<ExportBaseline>(key);
    const previous = baseline?.entries ?? {};
    const roots = selected.length ? selected : normalizeScope((await this.getRoots()).map(item => item.uri));
    const fullRoots = roots.filter(uri => full || this.getExportMode(uri) === "full");
    full ||= !baseline || (roots.length > 0 && fullRoots.length === roots.length);
    if (!roots.length && !Object.keys(previous).length) {
      throw new Error("请先将文件或文件夹添加到 Naruto 虚拟工作区");
    }
    const snapshot = await snapshotWorkspace(roots, this.excluded);
    const current: typeof previous = {};
    const operations: WorkspacePacket["operations"] = [];
    for (const op of snapshot.operations) {
      const id = JSON.stringify([op.workspace, op.path]);
      const folder = vscode.workspace.workspaceFolders!.find(item => item.name === op.workspace)!;
      const source = op.path === "." ? folder.uri : vscode.Uri.joinPath(folder.uri, op.path);
      const hash = createHash("sha256").update(JSON.stringify(op)).digest("hex");
      current[id] = { workspace: op.workspace, path: op.path, hash, uri: source.toString(), action: op.action };
      const fullItem = fullRoots.some(root => containsUri(root, source));
      if (full || fullItem || previous[id]?.hash !== hash) {
        if (!full && !fullItem && previous[id] && previous[id].action !== op.action && op.path !== ".") {
          operations.push({ workspace: op.workspace, path: op.path, action: "delete" });
        }
        operations.push(op);
      }
    }
    if (!full) {
      const deleteRemoved = vscode.workspace.getConfiguration("naruto").get<boolean>("virtualWorkspace.deleteRemoved", true);
      const deletions: WorkspacePacket["operations"] = [];
      // Delete children first so every operation also works for file/directory replacements.
      for (const [id, entry] of Object.entries(previous).sort((a, b) => b[1].path.split("/").length - a[1].path.split("/").length)) {
        if (current[id] || entry.path === "." || fullRoots.some(root => containsUri(root, vscode.Uri.parse(entry.uri)))) { continue; }
        if (!deleteRemoved) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.parse(entry.uri));
            continue;
          } catch (error) {
            if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) { throw error; }
          }
        }
        deletions.push({ workspace: entry.workspace, path: entry.path, action: "delete" });
      }
      operations.unshift(...deletions);
    }
    const base = full ? undefined : baseline?.snapshot;
    const replace: Location[] = base ? fullRoots.map(workspaceLocation) : [];
    const id = createHash("sha256").update(JSON.stringify({ base, operations, ...(replace.length ? { replace } : {}) })).digest("hex");
    return {
      packet: { ...snapshot, operations, ...(replace.length ? { replace } : {}), snapshot: { id, ...(base ? { base } : {}) } },
      confirm: async () => { await this.state.update(key, { snapshot: id, entries: current } satisfies ExportBaseline); },
    };
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
  private session?: { scope: vscode.Uri[]; full?: boolean; chunks?: string[]; copied: number; requiresConfirmation?: boolean; confirm?: () => Promise<void> };
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

  async next(scope?: ExportScope, full = false): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    const selected = scope === undefined && this.session ? this.session.scope : scopeRoots(scope);
    if ((this.session && JSON.stringify(selected.map(uri => uri.toString())) !== JSON.stringify(this.session.scope.map(uri => uri.toString()))) || (full && !this.session?.full)) {
      this.cancel();
    }
    const session = this.session ?? { scope: selected, full, copied: 0 };
    this.session = session;
    try {
      if (!session.chunks) {
        this.progress.text = "$(loading~spin) Naruto 正在准备导出";
        this.progress.command = undefined;
        this.progress.show();
        this.cancelItem.show();
        const prepared = await this.workspace.prepareExport(session.scope, session.full);
        if (!prepared.packet.operations.length) {
          this.cancel();
          void vscode.window.showInformationMessage("Naruto：没有需要导出的变化");
          return;
        }
        session.confirm = prepared.confirm;
        session.requiresConfirmation = prepared.packet.snapshot?.base !== undefined;
        const text = await encodePacket(prepared.packet);
        const size = vscode.workspace.getConfiguration("naruto").get<number>("virtualWorkspace.chunkSize", 256);
        session.chunks = createExportBlocks(text, size, prepared.packet.snapshot);
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
      this.progress.command = done ? "naruto.virtualWorkspace.cancelExport" : "naruto.virtualWorkspace.continueExport";
      if (done) {
        this.session = undefined;
        this.cancelItem.hide();
        if (session.requiresConfirmation) {
          const answer = await vscode.window.showInformationMessage(
            "Naruto：所有分块已复制，接收是否成功？成功后将更新本次导出范围的增量基准。",
            "接收成功", "接收失败"
          );
          if (answer === "接收成功") { await session.confirm!(); }
        } else {
          await session.confirm!();
        }
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

  function updateViewControls(): void {
    const filter = workspace.getFilter();
    view.message = filter.query ? `文件名筛选：${filter.query}${filter.matchCase ? " · 区分大小写" : ""}${filter.wholeWord ? " · 全词" : ""}${filter.regex ? " · 正则" : ""}` : undefined;
    void vscode.commands.executeCommand("setContext", "naruto.virtualWorkspace.filterActive", Boolean(filter.query));
    void vscode.commands.executeCommand("setContext", "naruto.virtualWorkspace.sortOrder", workspace.getSortOrder());
  }
  context.subscriptions.push(workspace.onDidChangeTreeData(updateViewControls));
  updateViewControls();

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
  async function clearTreeSelection(): Promise<void> {
    await vscode.commands.executeCommand("naruto.virtualWorkspace.focus");
    // The first native clear can reduce a multi-selection to its focused row.
    await vscode.commands.executeCommand("list.clear");
    await vscode.commands.executeCommand("list.clear");
  }
  register("filter", async () => {
    await clearTreeSelection();
    const initial = workspace.getFilter();
    const result = await showFileNameFilter(initial, filter => {
      exporter.cancel();
      workspace.setFilter(filter);
    });
    workspace.setFilter(result ?? initial);
    await workspace.saveFilter();
  });
  register("clearFilter", async () => {
    await clearTreeSelection();
    exporter.cancel();
    workspace.setFilter({ ...workspace.getFilter(), query: "" });
    await workspace.saveFilter();
  });
  register("sortAdded", () => workspace.setSortOrder("added"));
  register("sortFiles", () => workspace.setSortOrder("files"));
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
  const itemScope = (uri?: vscode.Uri, selected?: readonly vscode.Uri[]) => selectedExportScope(uri, selected?.length ? selected : view.selection);
  const exportScope = async (uri?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
    const scope = itemScope(uri, selected);
    if (workspace.getFilter().query) {
      const matches = await workspace.getFilteredFiles(scope.length ? scope : undefined);
      if (!matches.length) { throw new Error("没有匹配的文件可导出"); }
      return matches;
    }
    return scope;
  };
  register("export", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => exporter.next(await exportScope(uri, selected)));
  register("exportFull", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => exporter.next(await exportScope(uri, selected), true));
  register("continueExport", () => exporter.next());
  for (const [id, mode] of [["setIncrementalMode", "incremental"], ["setFullMode", "full"]] as const) {
    register(id, async (uri: vscode.Uri, selected?: vscode.Uri[]) => {
      exporter.cancel();
      await workspace.setExportMode(itemScope(uri, selected), mode);
    });
  }
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
