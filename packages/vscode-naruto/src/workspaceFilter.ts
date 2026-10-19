import * as vscode from "vscode";

export interface FileNameFilter {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export function fileNameMatcher(filter: FileNameFilter): (name: string) => boolean {
  if (!filter.query) { return () => true; }
  let pattern = filter.regex ? filter.query : filter.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (filter.wholeWord) {
    pattern = `(?<![\\p{L}\\p{M}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}_])`;
  }
  const expression = new RegExp(pattern, filter.matchCase ? "u" : "iu");
  return name => expression.test(name);
}

export function showFileNameFilter(
  initial: FileNameFilter,
  preview: (filter: FileNameFilter) => void
): Promise<FileNameFilter | undefined> {
  const input = vscode.window.createInputBox();
  let draft = { ...initial };
  input.title = "Naruto · 按文件名筛选";
  input.placeholder = "输入文件名；留空显示全部文件";
  input.value = initial.query;
  input.ignoreFocusOut = false;
  const options = [
    { key: "matchCase", icon: "case-sensitive", label: "区分大小写" },
    { key: "wholeWord", icon: "whole-word", label: "全词匹配" },
    { key: "regex", icon: "regex", label: "正则表达式" },
  ] as const;
  function updateButtons(): void {
    input.buttons = [
      ...options.map(option => ({
        iconPath: new vscode.ThemeIcon(option.icon, draft[option.key] ? new vscode.ThemeColor("inputOption.activeForeground") : undefined),
        tooltip: `${option.label}：${draft[option.key] ? "开启" : "关闭"}（点击切换）`,
      })),
      { iconPath: new vscode.ThemeIcon("clear-all"), tooltip: "清除筛选文字" },
    ];
    input.prompt = `${options.map(option => `${option.label}：${draft[option.key] ? "开" : "关"}`).join(" · ")}；Enter 保留，Esc 取消`;
  }
  function updateFilter(): void {
    draft = { ...draft, query: input.value };
    try {
      fileNameMatcher(draft);
      input.validationMessage = undefined;
      preview({ ...draft });
    } catch (error) {
      input.validationMessage = `正则表达式无效：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  updateButtons();
  return new Promise(resolve => {
    let accepted: FileNameFilter | undefined;
    const subscriptions = [
      input.onDidChangeValue(updateFilter),
      input.onDidTriggerButton(button => {
        const option = options[input.buttons.indexOf(button)];
        if (option) {
          draft = { ...draft, [option.key]: !draft[option.key] };
          updateButtons();
          updateFilter();
        } else {
          input.value = "";
          updateFilter();
        }
      }),
      input.onDidAccept(() => {
        if (!input.validationMessage) {
          accepted = { ...draft };
          input.hide();
        }
      }),
      input.onDidHide(() => {
        subscriptions.forEach(subscription => subscription.dispose());
        input.dispose();
        resolve(accepted);
      }),
    ];
    input.show();
  });
}
