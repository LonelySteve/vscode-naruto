import createCompress from "compress-brotli";
import * as vscode from "vscode";
import { activeEditorFullIO } from "./utils";
import { base91Decode, base91Encode } from "./base91";

async function showChunkedDataInNewEditor(data: string, chunkSize: number) {
  const document = await vscode.workspace.openTextDocument({ content: "" });
  const editor = await vscode.window.showTextDocument(document);

  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await editor.edit((editBuilder) => {
      const end = document.lineAt(document.lineCount - 1).range.end;
      editBuilder.insert(end, chunk + "\n");
    });
  }
}

function needChunked(data: string, chunkSize: number | null | undefined) {
  console.log("data length:", data.length);
  console.log("chunk size:", chunkSize);
  if (chunkSize && data.length > chunkSize) {
    console.log("need chunked");
    return true;
  }
  console.log("no need chunked");
  return false;
}

// 剪切板
export async function compressTextInClipboard(
  compress: ReturnType<typeof createCompress>["compress"],
  chunkSize?: number | null
) {
  const text = await vscode.env.clipboard.readText();
  if (!text) {
    vscode.window.showInformationMessage("没有获取到文本内容");
    return;
  }

  const compressedData = await compress(text);
  const compressedText = base91Encode(compressedData);

  if (needChunked(compressedText, chunkSize)) {
    await showChunkedDataInNewEditor(compressedText, chunkSize!);
    vscode.window.showInformationMessage("压缩并在新编辑器中显示完成");
    return;
  }

  vscode.env.clipboard.writeText(compressedText);

  vscode.window.showInformationMessage("压缩并替换完成");
}

// 编辑器
export async function compressTextInEditor(
  compress: ReturnType<typeof createCompress>["compress"],
  chunkSize?: number | null
) {
  const io = activeEditorFullIO();

  const text = io?.get();
  if (!text) {
    vscode.window.showInformationMessage("没有获取到文本内容");
    return;
  }

  const compressedData = await compress(text);
  const compressedText = base91Encode(compressedData);

  if (needChunked(compressedText, chunkSize)) {
    await showChunkedDataInNewEditor(compressedText, chunkSize!);
    vscode.window.showInformationMessage("压缩并在新编辑器中显示完成");
    return;
  }

  // await io?.set(compressedText);
  vscode.env.clipboard.writeText(compressedText);

  vscode.window.showInformationMessage("压缩并替换完成");
}

export async function compressText(
  config: vscode.WorkspaceConfiguration,
  compress: ReturnType<typeof createCompress>["compress"]
) {
  const chunkingEnabled =
    config.get<boolean>("compression.chunkingEnabled") ?? false;
  const chunkSize = chunkingEnabled
    ? config.get<number | null>("compression.chunkSize")
    : null;
  const source = config.get<string>("compression.source");

  if (source === "askUser") {
    const options: ({ value: string } & vscode.QuickPickItem)[] = [
      {
        label: "当前活动编辑器",
        description: "compress in active editor",
        value: "activeEditor",
      },
      {
        label: "剪贴板",
        description: "compress in clipboard",
        value: "clipboard",
      },
    ];
    const selection = await vscode.window.showQuickPick(options, {
      placeHolder: "选择压缩源位置",
    });
    if (!selection) {
      vscode.window.showInformationMessage("未选择压缩源位置");
      return;
    }
    if (selection.value === "clipboard") {
      await compressTextInClipboard(compress, chunkSize);
      return;
    }
    if (selection.value === "activeEditor") {
      await compressTextInEditor(compress, chunkSize);
      return;
    }

    vscode.window.showErrorMessage("未知的压缩源位置选择");
    return;
  }

  if (source === "clipboard") {
    await compressTextInClipboard(compress, chunkSize);
    return;
  }
  if (source === "activeEditor") {
    await compressTextInEditor(compress, chunkSize);
    return;
  }

  vscode.window.showErrorMessage("未知的压缩源位置选择");
}

async function decompressTextInEditor(
  decompress: ReturnType<typeof createCompress>["decompress"]
) {
  const io = activeEditorFullIO();

  let text = io?.get();
  if (!text) {
    vscode.window.showInformationMessage("没有获取到文本内容");
    return;
  }

  text = text.split("\n").join("");

  return decompress(base91Decode(text))
    .then(async (decompressedText) => {
      await io?.set(decompressedText);
      vscode.window.showInformationMessage("解压并替换完成");
    })
    .catch((err) => {
      vscode.window.showErrorMessage(`解压失败：${err.message}`);
    });
}

async function decompressTextInClipboard(
  decompress: ReturnType<typeof createCompress>["decompress"]
) {
  const text = await vscode.env.clipboard.readText();
  if (!text) {
    vscode.window.showInformationMessage("没有获取到文本内容");
    return;
  }

  const cleanedText = text.split("\n").join("");

  return decompress(base91Decode(cleanedText))
    .then(async (decompressedText) => {
      await vscode.env.clipboard.writeText(decompressedText);
      vscode.window.showInformationMessage("解压并替换完成");
    })
    .catch((err) => {
      vscode.window.showErrorMessage(`解压失败：${err.message}`);
    });
}

export async function decompressText(
  config: vscode.WorkspaceConfiguration,
  decompress: ReturnType<typeof createCompress>["decompress"]
) {
  const chunkSize = config.get<number | null>("compression.chunkSize");
  const source = config.get<string>("decompression.source");

  if (source === "askUser") {
    const options: ({ value: string } & vscode.QuickPickItem)[] = [
      {
        label: "当前活动编辑器",
        description: "decompress in active editor",
        value: "activeEditor",
      },
      {
        label: "剪贴板",
        description: "decompress in clipboard",
        value: "clipboard",
      },
    ];
    const selection = await vscode.window.showQuickPick(options, {
      placeHolder: "选择解压源位置",
    });
    if (!selection) {
      vscode.window.showInformationMessage("未选择解压源位置");
      return;
    }
    if (selection.value === "clipboard") {
      decompressTextInClipboard(decompress);
      return;
    }
    if (selection.value === "activeEditor") {
      decompressTextInEditor(decompress);
      return;
    }

    vscode.window.showErrorMessage("未知的解压源位置选择");
    return;
  }

  if (source === "clipboard") {
    decompressTextInClipboard(decompress);
    return;
  }
  if (source === "activeEditor") {
    decompressTextInEditor(decompress);
    return;
  }

  vscode.window.showErrorMessage("未知的解压源位置选择");
}
