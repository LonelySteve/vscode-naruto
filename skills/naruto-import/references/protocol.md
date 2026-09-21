# Naruto 工作区导入协议 v1

## 外层传输

VS Code 命令 `naruto.virtualWorkspace.import` **只读取一次剪贴板**。内容是整份 Base91 压缩文本，不包含 `naruto-virtual-workspace-export` 元信息、不包含分块序号，也不是 ZIP、Base64 压缩包或明文 JSON。

编码顺序：`JSON.stringify(packet)` → `compress-brotli` 默认序列化和 Brotli 压缩 → Base91。`compress-brotli` 会再次序列化输入字符串，因此仅对原始 JSON 字节做 Brotli 压缩不兼容。解码可忽略空白，但生成时使用单行完整文本。

使用 `scripts/naruto.mjs`，其附带的 `protocol.cjs` 由插件的 `transferProtocol.ts` 和 `base91.ts` 构建；不要用通用 Base64、其他 Base91 字母表或手写压缩结果替代。

## 操作包

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
      "content": "export const enabled = true;\n"
    }
  ]
}
```

`my-project` 只是示例，必须替换为目标 VS Code 真实工作区根目录的准确名称。多根工作区分别填写名称；同名根目录无法唯一匹配时不能导入，需要用户先区分名称。

| action | 字段与行为 |
| --- | --- |
| `write` | `workspace`、`path`、`encoding`、`content`。创建或完整覆盖文件，自动创建父目录。 |
| `create` | 字段同 `write`，要求目标不存在；同名文件存在时失败。 |
| `mkdir` | `workspace`、`path`。递归创建目录，已存在则保留。 |
| `rename` | `workspace`、`path`、`to`。在同一工作区内移动文件或目录，不覆盖已有目标；目标父目录需要已存在，可先 `mkdir`。 |
| `delete` | `workspace`、`path`。删除文件或递归删除目录。 |

共同规则：

- 路径从指定工作区根目录开始，使用 `/`；不能使用绝对路径、空路径段、`.` / `..` 段、反斜杠或控制字符。
- 整个 `path` 为 `.` 仅用于根目录 `mkdir`。不能删除、重命名或覆盖工作区根目录，`to` 也不能是 `.`。
- `encoding` 为 `utf8` 时 `content` 是完整文本；为 `base64` 时必须使用标准、带所需 padding、无换行的 Base64，逐字节保留二进制文件。
- 数组顺序就是执行顺序。重命名后修改内容应使用新路径；需要移动的目标父目录应先创建。
- 导入前校验整包结构、路径、工作区与未保存文档，不允许路径经过符号链接。通过校验不代表所有文件操作都会成功，例如目标冲突仍可能在执行中报错。
- 文件操作不是事务。后续失败不会自动回滚已完成操作。`create`、`rename`、`delete` 等不能在不了解当前状态时整包重放。
- 导入操作会直接修改真实工作区；成功写入或移动的目标会添加到虚拟列表。单纯从结果中省略文件不产生删除操作。

## 从修改后的文件构造操作包

以下例子将暂存文件的完整内容放入 `write`，无需手工转义源码中的引号和换行。工作区名和路径应来自当前任务。

```python
import json
from pathlib import Path

packet = {
    "format": "naruto-virtual-workspace",
    "version": 1,
    "operations": [{
        "action": "write",
        "workspace": "my-project",
        "path": "src/index.ts",
        "encoding": "utf8",
        "content": Path("edited/index.ts").read_bytes().decode("utf-8"),
    }],
}
Path("changes.json").write_text(json.dumps(packet, ensure_ascii=False), encoding="utf-8")
```

文本读取使用原始字节再解码可保留原本的 CRLF 换行。二进制使用 `base64.b64encode(Path(...).read_bytes()).decode("ascii")` 并设置 `encoding: "base64"`。不要通过执行用户提供的源码来生成内容。
