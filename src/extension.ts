// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import createCompress from "compress-brotli";
import { compressText, decompressText } from "./commands";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const { compress, decompress } = createCompress<string, Promise<string>>();
  const config = vscode.workspace.getConfiguration("naruto");

  // ========== 命令 1：压缩文本 ==========
  const compressTextCommand = vscode.commands.registerCommand(
    "naruto.compressText",
    async () => {
      await compressText(config, compress);
    }
  );

  // ========== 命令 2：解压文本 ==========
  const decompressTextCommand = vscode.commands.registerCommand(
    "naruto.decompressText",
    async () => {
      await decompressText(config, decompress);
    }
  );

  context.subscriptions.push(compressTextCommand, decompressTextCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
