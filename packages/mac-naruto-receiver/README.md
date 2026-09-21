# mac-naruto-receiver

Naruto 的原生 macOS 导出接收助手，使用 AppKit、SwiftUI、CryptoKit 和系统 Compression 框架，无第三方运行时依赖。要求 macOS 13+。

从仓库根目录运行：

```sh
pnpm start:mac       # 构建并打开 .app
pnpm package:mac     # 仅构建 .app
pnpm test:mac        # 协议、解压及 ZIP 测试
```

也可在本目录运行 `swift build` 或 `swift test`。实际使用推荐运行 `.app`，以便系统对应用进行辅助功能授权。详细操作见[仓库文档](../../README.md)。

`swift test` 需要完整 Xcode 中的 XCTest。未将 Xcode 设为默认开发目录时，可通过 `DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer` 指定工具链。

## 接收行为

- 全局快捷键 **⌘⇧E** 开始或取消。起点使用 Quartz 屏幕坐标，进度浮窗使用 AppKit 屏幕坐标，支持多显示器。
- 首次点击等待起始元信息，最多 30 秒；后续每次点击等待一次新的剪贴板文本，最多 10 秒。通过 `NSPasteboard.changeCount` 判断新写入，不按文本内容去重。
- 每次仅发出一次单击；超时、非法分块或取消后停止，不自动重试。总数据块数量来自版本 1 元信息，收齐后不再点击。
- 校验分块长度、Base91 字符和最终 SHA-256，按 `Base91 → Brotli → JSON 字符串 → 工作区 JSON` 解码，兼容 `compress-brotli` 默认的二次序列化。
- 只接收插件实际导出的 `write` / `mkdir` 快照，不执行外部数据中的删除或重命名。写入前校验工作区名称和路径，拒绝路径穿越。
- 文件存放于 `$TMPDIR/naruto-<UUID>/resources/<workspace>/…`；ZIP 位于同一临时根目录下，避免把压缩包自身纳入内容。
- 单击使用系统默认应用打开。右键复制文本内容，二进制内容转为 Base64；复制 ZIP 使用 `NSPasteboard.writeObjects([NSURL])`，供支持文件粘贴的应用使用。
- 再次复制压缩包时会重新压缩当前文件，包含用户通过结果列表打开后保存的修改。

协议 v1 的数据块没有序号，只能在收齐后用整包校验发现乱序或同长度的剪贴板干扰。接收时应避免其他复制操作；失败后先取消 VS Code 端的导出再重新开始。

## 源码与测试

- `Sources/NarutoReceiver`：菜单栏应用、快捷键、鼠标与剪贴板采集、SwiftUI 窗口。
- `Sources/NarutoTransfer`：协议解析、校验、解压、临时目录还原和 ZIP 创建。
- `Tests/NarutoTransferTests`：跨语言固定样本、相邻重复块、校验失败、不安全路径、文件内容和归档测试。

固定样本由 `packages/vscode-naruto/scripts/receiver-fixtures.mjs` 调用插件真实编码器生成。自动测试不发送真实鼠标事件。桌面验收需授权辅助功能后，在 VS Code 的导出按钮上验证快捷键、浮窗、取消、文件打开和 ZIP 粘贴。
