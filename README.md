# Naruto

Naruto 通过 Brotli + Base91 和剪贴板分块，在 VS Code 与 macOS 之间传输工作区文件。

## 项目结构

这是一个 pnpm workspace，包含两个独立的包：

| 包 | 职责 |
| --- | --- |
| [packages/vscode-naruto](packages/vscode-naruto) | VS Code 插件：文本压缩、虚拟工作区、分块导出与导入 |
| [packages/mac-naruto-receiver](packages/mac-naruto-receiver) | 原生 macOS 接收助手：自动点击采集、解压、浏览文件、复制 ZIP |

插件的命令、配置项和版本 1 传输协议保持兼容。完整协议和插件使用说明见 [VS Code 插件文档](packages/vscode-naruto/README.md)。

## 使用 macOS 导出助手

需要 macOS 13 或更高版本。开发构建需要 Xcode Command Line Tools（Swift 5.9+）、Node.js 和 pnpm 9；生成的 `.app` 无需 Node.js 或其他第三方运行时。

```sh
pnpm install --frozen-lockfile
pnpm start:mac
```

1. 首次运行，在 **系统设置 → 隐私与安全性 → 辅助功能**中允许 **Naruto Receiver** 模拟点击。应用中的权限按钮会触发系统提示。
2. 在 VS Code 的 Naruto 虚拟工作区中准备好要导出的文件，将鼠标停在**标题栏的导出按钮**上，不要提前点击。
3. 按 **⌘⇧E** 并松开按键。助手记录鼠标位置，点击一次并等待起始元信息，之后每收到一个数据块才继续点击。
4. 鼠标旁的浮窗显示接收进度，不抢焦点且允许鼠标事件穿透。接收时保持目标窗口和按钮位置不变，避免其他剪贴板操作。
5. 收齐后自动校验 SHA-256、解压并显示文件列表。单击使用默认应用打开；右键可在 Finder 显示或复制内容。文本按原文复制，二进制按 Base64 复制。
6. 点击 **复制压缩包**，助手把当前导出目录压缩为 ZIP，再把 ZIP **文件对象**写入剪贴板，可在 Finder 或支持文件粘贴的应用中粘贴。

再次按 **⌘⇧E** 可取消接收。取消、超时或校验失败后，需先在 VS Code 中执行 **取消 Naruto 虚拟工作区导出**，再从起始元信息重新导出。助手不会自动重试点击，避免跳过数据块。

关闭结果窗口后，助手继续在菜单栏运行。通过菜单栏可重新打开窗口或退出。每次成功接收使用独立的系统临时目录，保留工作区名称和相对路径；退出应用不会主动删除文件，需长期保存的文件请另存。

## 开发与打包

```sh
# 两个包一起编译（macOS）
pnpm compile

# 单独开发或打包插件
pnpm --filter naruto compile
pnpm watch
pnpm package:vsix

# 构建原生 .app（当前机器架构）
pnpm package:mac

# 测试
pnpm test:vscode
pnpm test:mac
```

VSIX 输出在 `packages/vscode-naruto/`；原生应用输出在 `packages/mac-naruto-receiver/dist/Naruto Receiver.app`。本地构建使用 ad-hoc 签名；对外分发需要 Developer ID 签名及 notarization。辅助功能授权与应用身份相关，重新构建或移动后若权限失效，应在系统设置中重新授权。

VS Code 中按 F5 会调试 `packages/vscode-naruto`。插件测试使用独立临时工作区，可通过 `VSCODE_EXECUTABLE_PATH` 指定现有 VS Code 安装。Swift 测试使用真实插件编码器生成的固定数据，验证协议校验、Brotli/Base91 兼容性、文件还原与 ZIP 内容；修改协议后运行 `pnpm --filter naruto fixtures:receiver` 更新测试数据。

运行 Swift 测试需要完整 Xcode 提供 XCTest。若 `xcode-select` 当前指向 Command Line Tools，可使用 `DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer pnpm test:mac` 单次指定工具链。
