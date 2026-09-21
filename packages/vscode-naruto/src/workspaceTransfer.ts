import * as vscode from "vscode";
import { Location, parsePacket, WorkspaceOperation, WorkspacePacket } from "./transferProtocol";
export * from "./transferProtocol";

export function containsUri(parent: vscode.Uri, child: vscode.Uri): boolean {
  return parent.scheme === child.scheme && parent.authority === child.authority &&
    (parent.path === child.path || child.path.startsWith(parent.path.replace(/\/$/, "") + "/"));
}

export function workspaceLocation(uri: vscode.Uri): Location {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    throw new Error("请选择当前真实工作区中的文件或文件夹");
  }
  if (vscode.workspace.workspaceFolders?.filter(item => item.name === folder.name).length !== 1) {
    throw new Error(`工作区名称 ${folder.name} 重复，请先为各工作区设置不同名称`);
  }
  return { workspace: folder.name, path: uri.path.slice(folder.uri.path.replace(/\/$/, "").length + 1) || "." };
}

export async function snapshotWorkspace(roots: readonly vscode.Uri[], excluded: readonly vscode.Uri[]): Promise<WorkspacePacket> {
  const operations: WorkspaceOperation[] = [];
  async function visit(uri: vscode.Uri): Promise<void> {
    if (excluded.some(item => containsUri(item, uri))) {
      return;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.SymbolicLink) {
      throw new Error(`暂不支持导出符号链接：${uri.fsPath}`);
    }
    const location = workspaceLocation(uri);
    if (stat.type & vscode.FileType.Directory) {
      operations.push({ ...location, action: "mkdir" });
      const children = await vscode.workspace.fs.readDirectory(uri);
      children.sort(([a], [b]) => a.localeCompare(b));
      for (const [name] of children) {
        await visit(vscode.Uri.joinPath(uri, name));
      }
    } else {
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
      const bytes = document ? Buffer.from(document.getText(), "utf8") : Buffer.from(await vscode.workspace.fs.readFile(uri));
      const text = bytes.toString("utf8");
      const encoding = !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes) ? "utf8" : "base64";
      operations.push({ ...location, action: "write", encoding, content: encoding === "utf8" ? text : bytes.toString("base64") });
    }
  }
  for (const root of roots) {
    await visit(root);
  }
  return { format: "naruto-virtual-workspace", version: 1, operations };
}

async function resolveLocation(location: Location): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.name === location.workspace) ?? [];
  if (folders.length !== 1) {
    throw new Error(`找不到唯一的真实工作区：${location.workspace}`);
  }
  const root = folders[0].uri;
  const uri = location.path === "." ? root : vscode.Uri.joinPath(root, location.path);
  // Imported paths must stay inside the named workspace, including through symlinks.
  let current = root;
  const segments = location.path === "." ? [] : location.path.split("/");
  for (let i = 0; i <= segments.length; i++) {
    try {
      const stat = await vscode.workspace.fs.stat(current);
      if (stat.type & vscode.FileType.SymbolicLink) {
        throw new Error(`导入路径不能经过符号链接：${current.fsPath}`);
      }
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
        throw error;
      }
      break;
    }
    if (i < segments.length) {
      current = vscode.Uri.joinPath(current, segments[i]);
    }
  }
  return uri;
}

export async function applyFileEdit(edit: vscode.WorkspaceEdit): Promise<void> {
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error("VS Code 未能应用文件操作");
  }
}

export async function applyPacket(
  packet: WorkspacePacket,
  onApplied: (op: WorkspaceOperation, uri: vscode.Uri, destination?: vscode.Uri) => Promise<void>
): Promise<number> {
  // Validate the entire payload before the first mutation.
  parsePacket(JSON.stringify(packet));
  const resolved = [];
  for (const op of packet.operations) {
    const uri = await resolveLocation(op);
    const destination = op.action === "rename" ? await resolveLocation({ ...op, path: op.to }) : undefined;
    if (op.action !== "mkdir" && vscode.workspace.textDocuments.some(doc => doc.isDirty &&
      (containsUri(uri, doc.uri) || (destination && containsUri(destination, doc.uri))))) {
      throw new Error(`请先保存或撤销未保存的编辑：${op.path}`);
    }
    resolved.push({ op, uri, destination });
  }
  let applied = 0;
  for (const [index, { op, uri, destination }] of resolved.entries()) {
    try {
      const edit = new vscode.WorkspaceEdit();
      switch (op.action) {
        case "mkdir":
          await vscode.workspace.fs.createDirectory(uri);
          break;
        case "write":
        case "create":
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
          edit.createFile(uri, { overwrite: op.action === "write", contents: Buffer.from(op.content, op.encoding) });
          await applyFileEdit(edit);
          break;
        case "rename":
          edit.renameFile(uri, destination!, { overwrite: false });
          await applyFileEdit(edit);
          break;
        case "delete":
          edit.deleteFile(uri, { recursive: true });
          await applyFileEdit(edit);
          break;
      }
      applied++;
      await onApplied(op, uri, destination);
    } catch (error) {
      throw new Error(`第 ${index + 1} 项操作失败；已应用 ${applied} 项：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return applied;
}
