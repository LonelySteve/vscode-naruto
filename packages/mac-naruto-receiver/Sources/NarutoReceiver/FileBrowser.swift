import SwiftUI
import NarutoTransfer

private enum FileViewMode: String, CaseIterable, Identifiable {
    case list, tree
    var id: String { rawValue }
    var title: String { self == .list ? "列表" : "树状" }
    var symbol: String { self == .list ? "list.bullet" : "list.bullet.indent" }
}

struct ExportFileBrowser: View {
    @ObservedObject var receiver: Receiver
    let result: ExportedFiles
    @AppStorage("fileViewMode") private var viewMode: FileViewMode = .tree

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(result.fileCount) 个文件 · 已还原").font(.headline)
                    Text(viewMode == .tree ? "单击文件打开 · 单击文件夹展开" : "显示文件相对路径 · 单击打开")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("文件视图", selection: $viewMode) {
                    ForEach(FileViewMode.allCases) { mode in
                        Label(mode.title, systemImage: mode.symbol).tag(mode)
                    }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 120)
                Button { receiver.reveal(result.directory) } label: { Label("Finder", systemImage: "folder") }
                Button { receiver.copyArchive() } label: {
                    Label(receiver.isArchiving ? "正在压缩…" : "复制压缩包", systemImage: "doc.on.doc")
                }.buttonStyle(.borderedProminent).tint(.orange)
                    .disabled(receiver.isArchiving || receiver.isReceiving)
            }.padding(20)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if viewMode == .tree {
                        ForEach(FileTreeNode.roots(from: result.items)) { node in
                            FileTreeRow(receiver: receiver, node: node, isRoot: true)
                        }
                    } else if result.fileCount == 0 {
                        Text("没有文件。切换到树状视图可查看空文件夹。")
                            .foregroundStyle(.secondary).padding(20)
                    } else {
                        ForEach(result.items.filter { !$0.isDirectory }) { item in
                            FileItemRow(receiver: receiver, item: item, title: item.relativePath) {
                                receiver.open(item)
                            }
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
            Divider()
            Text(result.directory.path).font(.caption).foregroundStyle(.secondary)
                .textSelection(.enabled).lineLimit(2).padding(16)
        }
    }
}

private struct FileTreeNode: Identifiable {
    let item: ExportedItem
    let children: [FileTreeNode]?
    var id: String { item.id }

    static func roots(from items: [ExportedItem]) -> [Self] {
        // Extraction enumerates every directory, including implicit parents and empty folders.
        let byParent = Dictionary(grouping: items) {
            $0.relativePath.split(separator: "/").dropLast().joined(separator: "/")
        }
        func children(of path: String) -> [Self] {
            (byParent[path] ?? []).sorted {
                if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
                return $0.url.lastPathComponent.localizedStandardCompare($1.url.lastPathComponent) == .orderedAscending
            }.map { item in
                Self(item: item, children: item.isDirectory ? children(of: item.relativePath) : nil)
            }
        }
        return children(of: "")
    }
}

private struct FileTreeRow: View {
    @ObservedObject var receiver: Receiver
    let node: FileTreeNode
    @State private var isExpanded: Bool

    init(receiver: Receiver, node: FileTreeNode, isRoot: Bool = false) {
        self.receiver = receiver
        self.node = node
        _isExpanded = State(initialValue: isRoot)
    }

    var body: some View {
        if let children = node.children {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(children) { child in
                        FileTreeRow(receiver: receiver, node: child)
                    }
                }.padding(.leading, 20)
            } label: {
                FileItemRow(receiver: receiver, item: node.item, title: node.item.url.lastPathComponent,
                            detail: children.isEmpty ? "空文件夹" : "\(children.count) 项", verticalPadding: 3) {
                    isExpanded.toggle()
                }
            }
        } else {
            FileItemRow(receiver: receiver, item: node.item, title: node.item.url.lastPathComponent, verticalPadding: 3) {
                receiver.open(node.item)
            }.padding(.leading, 12)
        }
    }
}

private struct FileItemRow: View {
    @ObservedObject var receiver: Receiver
    let item: ExportedItem
    let title: String
    var detail: String? = nil
    var verticalPadding: CGFloat = 9
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: item.isDirectory ? "folder.fill" : "doc.text")
                    .foregroundStyle(item.isDirectory ? .orange : .secondary).frame(width: 22)
                Text(title).lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(detail ?? ByteCountFormatter.string(fromByteCount: Int64(item.byteCount), countStyle: .file))
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, verticalPadding).contentShape(Rectangle())
        }.buttonStyle(.plain).help(item.relativePath)
            .contextMenu {
                Button("使用默认应用打开") { receiver.open(item) }
                Button("在 Finder 中显示") { receiver.reveal(item.url) }
                if !item.isDirectory {
                    Button("复制内容（文本 / Base64）") { receiver.copyContents(item) }.disabled(receiver.isReceiving)
                }
            }
    }
}
