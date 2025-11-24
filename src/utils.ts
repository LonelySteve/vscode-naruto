import * as vscode from "vscode";

export function isTextEditor(editor: vscode.TextEditor) {
  return (
    editor.document.uri.scheme === "file" ||
    editor.document.uri.scheme === "untitled"
  );
}

export function activeEditorFullIO() {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showInformationMessage("没有活动的文本编辑器");
    return;
  }

  if (!isTextEditor(editor)) {
    vscode.window.showInformationMessage("当前编辑器不是文本编辑器");
    return;
  }

  const document = editor.document;

  return {
    get: () => {
      const fullText = document.getText();

      return fullText;
    },
    set: async (text: string) => {
      await editor.edit((editBuilder) => {
        const end = document.lineAt(document.lineCount - 1).range.end;
        editBuilder.replace(
          new vscode.Range(new vscode.Position(0, 0), end),
          text
        );
      });
    },
  };
}
