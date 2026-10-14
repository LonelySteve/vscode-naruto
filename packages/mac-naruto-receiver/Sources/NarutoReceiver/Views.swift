import SwiftUI
import NarutoTransfer

struct ReceiverView: View {
    @ObservedObject var receiver: Receiver
    @FocusState private var pasteFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "arrow.down.doc.fill")
                    .font(.system(size: 27, weight: .medium))
                    .foregroundStyle(.orange)
                    .frame(width: 52, height: 52)
                    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Naruto Receiver").font(.system(size: 23, weight: .semibold))
                    Text("从剪贴板分块，还原完整工作区").foregroundStyle(.secondary)
                }
                Spacer()
                Text("⌘ ⇧ E").font(.system(.title3, design: .monospaced)).foregroundStyle(.secondary)
                    .padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 9))
            }.padding(24)
            Divider()
            receptionOptions
            Divider()
            if receiver.isReceiving {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(receiver.progressTitle).fontWeight(.medium)
                        Spacer()
                        if receiver.clickMode == .manual {
                            Button("显示接收器 · ⌘⇧R") { receiver.syncClipboardNow() }
                        }
                        Button("取消接收") { receiver.toggle() }
                    }
                    ProgressView(value: receiver.progress).tint(.orange)
                    if receiver.clickMode == .manual {
                        Text("每次点完导出，按 ⌘Tab 切到另一个应用触发同步；看到进度增加后再返回。⌘⇧R 可请求显示接收器。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if receiver.clickMode == .paste {
                        Text("在下面按 ⌘V 粘贴，然后提交。起始元信息和每个分块分别提交一次。")
                            .font(.callout).foregroundStyle(.secondary)
                        TextEditor(text: $receiver.pastedText)
                            .font(.system(.body, design: .monospaced))
                            .focused($pasteFocused)
                            .frame(height: 80)
                            .border(.secondary.opacity(0.3))
                            .accessibilityLabel("Naruto 分块粘贴输入")
                            .onAppear { pasteFocused = true }
                        HStack {
                            Text("\(receiver.pastedText.utf8.count) 字节").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("提交这一块") { receiver.submitPaste(); pasteFocused = true }
                                .buttonStyle(.borderedProminent).tint(.orange)
                                .disabled(!receiver.isWaitingForPaste || receiver.pastedText.isEmpty)
                        }
                    }
                }.padding(20)
            }
            if !receiver.clipboardStatus.isEmpty {
                DisclosureGroup("剪贴板诊断") {
                    Text(receiver.clipboardStatus).font(.caption.monospaced())
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                }.padding(.horizontal, 24).padding(.vertical, 8)
            }
            if let error = receiver.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).textSelection(.enabled).padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading).background(.red.opacity(0.07))
            }
            if let notice = receiver.notice {
                Label(notice, systemImage: "info.circle")
                    .foregroundStyle(.secondary).padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let result = receiver.result {
                ExportFileBrowser(receiver: receiver, result: result)
                    .id(result.directory)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(receiver.clickMode.isAutomatic ? "将鼠标停在导出按钮上" : "准备好后，启动手动接收").font(.system(size: 25, weight: .semibold))
                        instruction("1", "在 VS Code 中选择文件", "添加到 Naruto 虚拟工作区，准备一次新的导出。")
                        if receiver.clickMode == .paste {
                            instruction("2", "点击导出，逐块粘贴", "开始粘贴接收后，手动点远端导出，将文本粘贴到此窗口并提交。每次看到进度增加后再点下一块。")
                        } else if receiver.clickMode == .manual {
                            instruction("2", "先监听，再手动点导出", "点击“开始手动接收”或按 ⌘⇧E，切换到目标应用点击导出按钮；若失焦才同步，点完按 ⌘Tab 切到另一个应用。")
                        } else {
                            instruction("2", "激活目标窗口并移到导出按钮", "按 ⌘⇧E 并松开按键，助手会按所选方式在该位置逐次点击。")
                        }
                        instruction("3", "等待文件还原", "收齐全部分块后自动校验、解压。")
                        Text("接收时请保持目标窗口和按钮位置不变，避免操作剪贴板。再次按 ⌘⇧E 可取消；重试前需先取消 VS Code 中未完成的导出。")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if receiver.clickMode.isAutomatic {
                            Button("允许辅助功能权限…") { receiver.requestAccessibility() }.buttonStyle(.bordered)
                        }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }.frame(minWidth: 680, minHeight: 620)
    }

    private var receptionOptions: some View {
        VStack(alignment: .leading, spacing: 16) {
            settingsGroup("接收", symbol: "tray.and.arrow.down") {
                settingsRow("接收方式") {
                    Picker("接收方式", selection: $receiver.clickMode) {
                        ForEach(ClickMode.allCases) { mode in Text(mode.title).tag(mode) }
                    }.labelsHidden().frame(width: 260, alignment: .leading)
                    settingsHint(receiver.clickMode.detail)
                }
            }
            if receiver.clickMode.isAutomatic {
                settingsGroup("自动点击", symbol: "cursorarrow.click") {
                    settingsRow("点击节奏") {
                        Picker("点击节奏", selection: $receiver.clickPace) {
                            ForEach(ClickPace.allCases) { pace in Text(pace.title).tag(pace) }
                        }.pickerStyle(.segmented).labelsHidden().frame(width: 260, alignment: .leading)
                        settingsHint(receiver.clickPace.detail)
                    }
                    Divider().padding(.horizontal, 16)
                    settingsRow("剪贴板同步") {
                        HStack {
                            Text("点击后切换应用")
                            Spacer()
                            Toggle("点击后切换应用", isOn: $receiver.syncOnFocusLoss)
                                .labelsHidden().toggleStyle(.switch).tint(.orange)
                        }
                        settingsHint("适用于仅在失去焦点后同步剪贴板的应用。")
                    }
                    if receiver.syncOnFocusLoss {
                        settingsRow("切换方式") {
                            Picker("切换方式", selection: $receiver.focusSwitchMode) {
                                ForEach(FocusSwitchMode.allCases) { mode in Text(mode.title).tag(mode) }
                            }.labelsHidden().frame(width: 260, alignment: .leading)
                            settingsHint(receiver.focusSwitchMode.detail)
                        }
                    }
                }
            } else if !receiver.isReceiving {
                HStack {
                    Spacer()
                    Button(receiver.clickMode == .paste ? "开始粘贴接收" : "开始手动接收") { receiver.toggle() }
                        .buttonStyle(.borderedProminent).tint(.orange).disabled(receiver.isArchiving)
                }
            }
        }.controlSize(.regular).disabled(receiver.isReceiving)
            .padding(.horizontal, 24).padding(.vertical, 20)
    }

    private func settingsGroup<Content: View>(_ title: String, symbol: String,
                                             @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0, content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.primary.opacity(0.06)))
        }
    }

    private func settingsRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text(title).fontWeight(.medium).frame(width: 96, alignment: .leading).padding(.top, 4)
            VStack(alignment: .leading, spacing: 6, content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func settingsHint(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func instruction(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text(number).font(.system(.body, design: .monospaced).weight(.semibold))
                .foregroundStyle(.orange).frame(width: 28, height: 28)
                .background(.orange.opacity(0.1), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(title).fontWeight(.medium)
                Text(detail).foregroundStyle(.secondary)
            }
        }
    }
}

struct ProgressViewContent: View {
    @ObservedObject var receiver: Receiver
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(.orange)
                Text(receiver.progressTitle).font(.system(size: 14, weight: .semibold))
            }
            ProgressView(value: receiver.progress).tint(.orange)
            Text(receiver.progressDetail).font(.system(size: 11)).foregroundStyle(.secondary)
        }.padding(16).frame(width: 310, height: 108)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 15))
    }
}
