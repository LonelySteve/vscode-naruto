# Naruto

Naruto 提供 Brotli + Base91 文本压缩，以及直接关联真实文件的虚拟工作区。

## 虚拟工作区

在资源管理器中右键文件或文件夹，选择 **添加到 Naruto 虚拟工作区**（支持多选）。活动栏的 Naruto 入口会打开虚拟工作区文件树，选择项随当前 VS Code 工作区保存。

- 点击文件可打开原文件并编辑。右键菜单支持新建文件、新建文件夹、重命名和删除，操作直接应用于真实工作区。
- **从 Naruto 虚拟工作区中移除**只隐藏选择项，保留真实文件；也可以单独移除已选目录内的子文件或子目录。
- 命令面板提供 **将当前文件添加到 Naruto 虚拟工作区**、**将当前文件从 Naruto 虚拟工作区中移除**。
- VS Code 中的重命名会同步更新虚拟列表；文件新增或删除会刷新文件树，也可以点击标题栏的刷新按钮。
- 标题栏的新建按钮允许选择真实工作区作为新文件或文件夹的位置。

## 分块导出与导入

1. 点击虚拟工作区标题栏的 **导出**。Naruto 递归读取选中文件夹，生成一份固定快照，并将压缩文本的第 1 块复制到剪贴板。
2. 粘贴当前块，再点击导出按钮或底部状态栏复制下一块。每次点击只复制一块；状态栏显示 `已复制块数/总块数`，旁边可取消剩余复制。取消保留当前剪贴板，下一次导出从新快照的第 1 块开始。
3. 按顺序拼接所有分块。可以用换行分隔；不添加编号或其他字符。
4. 外部使用 Naruto 原有解压方式得到下述 JSON，修改内容或动作，再使用原有压缩方式得到完整文本。现有 **Open Compression Webview** 也可以完成这一过程。
5. 将完整压缩文本放入剪贴板，点击标题栏的 **导入**。Naruto **只读取一次剪贴板**，解压后按操作顺序应用至真实工作区。

`naruto.virtualWorkspace.chunkSize` 控制每块的字节数，默认 **256**，独立于普通文本压缩设置。Base91 输出仅含 ASCII，因此每个字符恰好占一个字节。导出期间的后续文件修改不会改变已经生成的分块；全部复制完毕后再次点击导出会开始新快照。

## 外部交换格式（版本 1）

导出只包含当前内容，不包含本地已执行的动作历史。文件导出为 `write`，目录导出为 `mkdir`（包括空目录）。外部可修改这些记录或添加操作。

```json
{
  "format": "naruto-virtual-workspace",
  "version": 1,
  "operations": [
    {
      "action": "write",
      "workspace": "my-project",
      "path": "src/index.ts",
      "encoding": "utf8",
      "content": "console.log('Naruto');\n"
    },
    {
      "action": "mkdir",
      "workspace": "my-project",
      "path": "src/features"
    },
    {
      "action": "create",
      "workspace": "my-project",
      "path": "src/features/new.ts",
      "encoding": "utf8",
      "content": "export const enabled = true;\n"
    },
    {
      "action": "rename",
      "workspace": "my-project",
      "path": "src/old.ts",
      "to": "src/renamed.ts"
    },
    {
      "action": "delete",
      "workspace": "my-project",
      "path": "src/unused.ts"
    }
  ]
}
```

| 动作 | 行为 |
| --- | --- |
| `write` | 创建或覆盖文件；`encoding` 为 `utf8` 或 `base64`，`content` 为对应字符串。自动创建父目录。 |
| `create` | 新建文件；字段同 `write`，同名文件存在时失败。 |
| `mkdir` | 创建目录及父目录；已有目录保持原状。 |
| `rename` | 将文件或目录移动到同一工作区的 `to` 相对路径；目标父目录应已存在，不覆盖已有目标。 |
| `delete` | 删除真实文件或递归删除真实目录。 |

`workspace` 必须与当前打开的某个真实工作区根目录的名称唯一匹配。多根工作区以名称区分，导入到另一份副本时可修改该字段。路径使用 `/` 分隔，不能使用绝对路径或 `..`；`.` 仅用于根目录的 `mkdir` 记录，不能删除或重命名真实工作区根目录。

操作按数组顺序执行。重命名后的内容修改应使用新路径；从数据包中省略某个文件不会删除它，删除必须写明 `delete`。导入成功的项目会出现在虚拟列表中。

文本按 UTF-8 导出，二进制内容按 Base64 无损导出。打开且未保存的文本使用编辑器当前内容；导入遇到会覆盖、删除或重命名未保存文档的操作时，会要求先保存或撤销编辑。符号链接暂不参与导出，导入路径也不能经过符号链接。

压缩方式与原有 Naruto 一致：先将数据包 `JSON.stringify` 成字符串，再交给 `compress-brotli` 的默认 `compress`，最后 Base91 编码。解压执行相反步骤。注意 `compress-brotli` 默认还会对输入字符串做自身的序列化，直接压缩 JSON 的原始字节并不等价。

导入前会校验整个数据包的格式、路径、工作区和未保存文档。文件操作不具有事务性；若后续操作因文件不存在、目标冲突或 IO 错误失败，会停止并报告此前已应用的操作数量。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm run compile
pnpm test
```

测试在独立临时工作区中运行，覆盖文件操作、导入导出与剪贴板分块。可设置 `VSCODE_EXECUTABLE_PATH` 使用已有 VS Code 可执行文件，避免下载测试版本。
