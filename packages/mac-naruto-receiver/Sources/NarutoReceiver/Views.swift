import SwiftUI
import NarutoTransfer

struct ReceiverView: View {
    @ObservedObject var receiver: Receiver

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
            if receiver.isReceiving {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(receiver.progressTitle).fontWeight(.medium)
                        Spacer()
                        Button("取消接收") { receiver.toggle() }
                    }
                    ProgressView(value: receiver.progress).tint(.orange)
                }.padding(20)
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
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(result.fileCount) 个文件 · 已还原").font(.headline)
                        Text("单击打开 · 右键查看更多操作").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { receiver.reveal(result.directory) } label: { Label("Finder", systemImage: "folder") }
                    Button { receiver.copyArchive() } label: {
                        Label(receiver.isArchiving ? "正在压缩…" : "复制压缩包", systemImage: "doc.on.doc")
                    }.buttonStyle(.borderedProminent).tint(.orange)
                        .disabled(receiver.isArchiving || receiver.isReceiving)
                }.padding(20)
                Divider()
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(result.items) { item in
                            Button { receiver.open(item) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: item.isDirectory ? "folder.fill" : "doc.text")
                                        .foregroundStyle(item.isDirectory ? .orange : .secondary).frame(width: 24)
                                    Text(item.relativePath).lineLimit(1).truncationMode(.middle)
                                    Spacer()
                                    Text(item.isDirectory ? "文件夹" : ByteCountFormatter.string(fromByteCount: Int64(item.byteCount), countStyle: .file))
                                        .font(.caption).foregroundStyle(.secondary)
                                }.padding(.horizontal, 20).padding(.vertical, 10).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .contextMenu {
                                    Button("使用默认应用打开") { receiver.open(item) }
                                    Button("在 Finder 中显示") { receiver.reveal(item.url) }
                                    if !item.isDirectory {
                                        Button("复制内容（文本 / Base64）") { receiver.copyContents(item) }.disabled(receiver.isReceiving)
                                    }
                                }
                            Divider().padding(.leading, 56)
                        }
                    }.padding(.vertical, 8)
                }
                Divider()
                Text(result.directory.path).font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled).lineLimit(2).padding(16)
            } else {
                VStack(alignment: .leading, spacing: 24) {
                    Text("将鼠标停在导出按钮上").font(.system(size: 25, weight: .semibold))
                    instruction("1", "在 VS Code 中选择文件", "添加到 Naruto 虚拟工作区，准备一次新的导出。")
                    instruction("2", "鼠标移到标题栏的导出按钮", "按 ⌘⇧E 并松开按键，助手会在该位置逐次点击。")
                    instruction("3", "等待文件还原", "每次点击等待剪贴板更新，收齐后自动校验、解压。")
                    Text("接收时请保持目标窗口和按钮位置不变，避免操作剪贴板。再次按 ⌘⇧E 可取消；重试前需先取消 VS Code 中未完成的导出。")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("允许辅助功能权限…") { receiver.requestAccessibility() }.buttonStyle(.bordered)
                }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }.frame(minWidth: 640, minHeight: 540)
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
