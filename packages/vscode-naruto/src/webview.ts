import * as vscode from "vscode";
import createCompress from "compress-brotli";
import { base91Decode, base91Encode } from "./base91";

type CompressFn = ReturnType<typeof createCompress>["compress"];
type DecompressFn = ReturnType<typeof createCompress>["decompress"];

function chunkString(text: string, chunkSize: number) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function getWebviewHtml(webview: vscode.Webview) {
  const nonce = String(Date.now());
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Naruto 压缩/解压</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --card: #111827;
        --muted: #94a3b8;
        --text: #e2e8f0;
        --accent: #f97316;
        --accent-2: #fb923c;
        --border: #1f2937;
        --success: #22c55e;
      }

      @media (prefers-color-scheme: light) {
        :root {
          --bg: #fff7ed;
          --card: #ffffff;
          --muted: #475569;
          --text: #0f172a;
          --accent: #ea580c;
          --accent-2: #f97316;
          --border: #e2e8f0;
          --success: #16a34a;
        }
      }

      * {
        box-sizing: border-box;
        font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC",
          "Microsoft YaHei", "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        padding: 24px;
        background: radial-gradient(
            circle at 20% 20%,
            rgba(249, 115, 22, 0.2),
            transparent 50%
          ),
          radial-gradient(
            circle at 80% 0%,
            rgba(234, 88, 12, 0.2),
            transparent 40%
          ),
          var(--bg);
        color: var(--text);
      }

      .app {
        display: grid;
        gap: 16px;
        max-width: 1100px;
        margin: 0 auto;
      }

      .header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }

      .header h1 {
        margin: 0;
        font-size: 24px;
        letter-spacing: 0.5px;
      }

      .header p {
        margin: 4px 0 0;
        color: var(--muted);
      }

      .panel {
        display: grid;
        gap: 12px;
        padding: 16px;
        border-radius: 16px;
        background: linear-gradient(
          145deg,
          rgba(255, 255, 255, 0.02),
          rgba(0, 0, 0, 0.08)
        );
        border: 1px solid var(--border);
        backdrop-filter: blur(8px);
      }

      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }

      .control {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
      }

      .control input[type="number"],
      textarea {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--card);
        color: var(--text);
        padding: 10px 12px;
        font-size: 13px;
      }

      textarea {
        min-height: 160px;
        resize: vertical;
        font-family: "JetBrains Mono", "Fira Code", "Cascadia Mono", monospace;
      }

      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .btn {
        border: none;
        border-radius: 999px;
        padding: 10px 16px;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }

      .btn.secondary {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
      }

      .btn:active {
        transform: translateY(1px);
      }

      .badge {
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.15);
        color: var(--success);
      }

      .output {
        display: grid;
        gap: 10px;
      }

      .chunk-list {
        display: grid;
        gap: 10px;
      }

      .chunk-item {
        border: 1px dashed var(--border);
        border-radius: 12px;
        padding: 12px;
        display: grid;
        gap: 8px;
      }

      .chunk-item code {
        display: block;
        white-space: pre-wrap;
        word-break: break-all;
        font-family: "JetBrains Mono", "Fira Code", "Cascadia Mono", monospace;
        font-size: 12px;
      }

      .chunk-item .btn.copy {
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        color: #fff;
        border: none;
      }

      .muted {
        color: var(--muted);
        font-size: 12px;
      }

      .copied-header {
        justify-content: space-between;
      }

      .copied-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .copied-list[hidden] {
        display: none;
      }

      .copied-list .chunk-item {
        border-style: solid;
        border-color: rgba(34, 197, 94, 0.35);
        background: rgba(34, 197, 94, 0.08);
      }

      .status {
        min-height: 20px;
        color: var(--muted);
        font-size: 12px;
      }

      @media (max-width: 720px) {
        body {
          padding: 16px;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <div class="header">
        <div>
          <h1>Naruto 压缩 / 解压</h1>
          <p>Base91 + Brotli，适合快速处理文本</p>
        </div>
        <span class="badge" id="modeBadge">待命</span>
      </div>

      <section class="panel">
        <div class="controls">
          <label class="control">
            <span>分块开关</span>
            <input id="chunkToggle" type="checkbox" />
          </label>
          <label class="control">
            <span>分块大小</span>
            <input id="chunkSize" type="number" min="16" step="1" />
          </label>
          <div class="control">
            <span>快捷操作</span>
            <div class="row">
              <button class="btn" id="compressBtn">压缩</button>
              <button class="btn secondary" id="decompressBtn">解压</button>
            </div>
          </div>
          <div class="control">
            <span>复制结果</span>
            <div class="row">
              <button class="btn secondary" id="copyBtn">复制</button>
              <button class="btn secondary" id="clearBtn">清空</button>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <label class="control">
          <span>输入文本</span>
          <textarea id="input" placeholder="粘贴需要压缩或解压的文本，支持多行分块输入..."></textarea>
        </label>
        <div class="row">
          <button class="btn secondary" id="loadClipboard">从剪贴板读取</button>
          <button class="btn secondary" id="appendClipboard">追加剪贴板</button>
        </div>
        <div class="muted">多行分块可直接粘贴，解压时会自动忽略空白。</div>
      </section>

      <section class="panel output">
        <div class="row">
          <strong>输出结果</strong>
          <span class="muted" id="outputHint">可使用 Ctrl+C 复制</span>
        </div>
        <textarea id="output" placeholder="结果会显示在这里..." readonly></textarea>
        <div class="chunk-list" id="chunkList"></div>
        <div class="row copied-header">
          <div class="row">
            <strong>已复制分块</strong>
            <span class="muted" id="copiedCount">0</span>
          </div>
          <div class="copied-actions">
            <button class="btn secondary" id="toggleCopied">展开</button>
            <button class="btn secondary" id="resetCopied">一键复位</button>
          </div>
        </div>
        <div class="chunk-list copied-list" id="copiedList" hidden></div>
        <div class="status" id="status"></div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const input = document.getElementById("input");
      const output = document.getElementById("output");
      const chunkList = document.getElementById("chunkList");
      const copiedList = document.getElementById("copiedList");
      const chunkToggle = document.getElementById("chunkToggle");
      const chunkSize = document.getElementById("chunkSize");
      const status = document.getElementById("status");
      const modeBadge = document.getElementById("modeBadge");
      const outputHint = document.getElementById("outputHint");
      const toggleCopied = document.getElementById("toggleCopied");
      const resetCopied = document.getElementById("resetCopied");
      const copiedCount = document.getElementById("copiedCount");
      const loadClipboard = document.getElementById("loadClipboard");
      const appendClipboard = document.getElementById("appendClipboard");

      let allChunks = [];
      let copiedOrder = [];
      let copiedExpanded = false;

      function setStatus(text, kind = "info") {
        status.textContent = text;
        if (kind === "error") {
          status.style.color = "#ef4444";
        } else {
          status.style.color = "";
        }
      }

      function setMode(mode) {
        modeBadge.textContent = mode;
      }

      function clearChunks() {
        chunkList.innerHTML = "";
        copiedList.innerHTML = "";
        outputHint.textContent = "可使用 Ctrl+C 复制";
        copiedCount.textContent = "0";
        copiedExpanded = false;
        copiedList.hidden = true;
        toggleCopied.textContent = "展开";
        allChunks = [];
        copiedOrder = [];
      }

      function updateCopiedMeta() {
        copiedCount.textContent = String(copiedOrder.length);
      }

      function setCopiedExpanded(expanded) {
        copiedExpanded = expanded;
        copiedList.hidden = !expanded;
        toggleCopied.textContent = expanded ? "收起" : "展开";
      }

      function renderChunkItem(chunk, index, isCopied) {
        const item = document.createElement("div");
        item.className = "chunk-item";

        const title = document.createElement("div");
        title.className = "row";
        title.innerHTML =
          "<strong>Chunk " + (index + 1) + "</strong>" +
          "<span class=\\"muted\\">长度 " + chunk.length + "</span>";

        const code = document.createElement("code");
        code.textContent = chunk;

        const btn = document.createElement("button");
        btn.className = isCopied ? "btn secondary" : "btn copy";
        btn.textContent = isCopied ? "再次复制" : "复制该块";
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "copy", text: chunk });
          markCopied(index);
          setStatus("已复制第 " + (index + 1) + " 块");
        });

        item.appendChild(title);
        item.appendChild(code);
        item.appendChild(btn);
        return item;
      }

      function markCopied(index) {
        const existingIndex = copiedOrder.indexOf(index);
        if (existingIndex !== -1) {
          copiedOrder.splice(existingIndex, 1);
        }
        copiedOrder.unshift(index);
        renderChunkLists();
      }

      function renderChunkLists() {
        chunkList.innerHTML = "";
        copiedList.innerHTML = "";

        const copiedSet = new Set(copiedOrder);
        allChunks.forEach((chunk, index) => {
          if (copiedSet.has(index)) {
            return;
          }
          chunkList.appendChild(renderChunkItem(chunk, index, false));
        });

        copiedOrder.forEach((index) => {
          const chunk = allChunks[index];
          if (chunk === undefined) {
            return;
          }
          copiedList.appendChild(renderChunkItem(chunk, index, true));
        });

        updateCopiedMeta();
      }

      function renderChunks(chunks) {
        clearChunks();
        if (!chunks || chunks.length === 0) {
          return;
        }
        output.value = "";
        outputHint.textContent = "分块结果已生成，可逐个复制或 Ctrl+C 全部复制";
        allChunks = chunks.slice();
        copiedOrder = [];
        renderChunkLists();
      }

      function renderOutput(text) {
        clearChunks();
        output.value = text || "";
      }

      function applyInput(text, mode, source) {
        if (!text) {
          setStatus("没有读取到文本");
          return;
        }
        if (mode === "append" && input.value) {
          const separator = input.value.endsWith("\\n") ? "" : "\\n";
          input.value = input.value + separator + text;
        } else {
          input.value = text;
        }
        if (source === "clipboard") {
          setStatus(mode === "append" ? "已追加剪贴板内容" : "已读取剪贴板内容");
        } else if (source === "editor") {
          setStatus(mode === "append" ? "已追加编辑器内容" : "已读取编辑器内容");
        }
      }

      function submit(type) {
        const size = Number(chunkSize.value);
        vscode.postMessage({
          type,
          text: input.value || "",
          chunkingEnabled: chunkToggle.checked,
          chunkSize: Number.isFinite(size) ? size : null,
        });
      }

      document.getElementById("compressBtn").addEventListener("click", () => {
        setMode("压缩中");
        submit("compress");
      });

      document.getElementById("decompressBtn").addEventListener("click", () => {
        setMode("解压中");
        submit("decompress");
      });

      document.getElementById("copyBtn").addEventListener("click", () => {
        const text =
          allChunks.length > 0 ? allChunks.join("\\n") : output.value;
        vscode.postMessage({ type: "copy", text });
        setStatus("已复制结果");
      });

      document.getElementById("clearBtn").addEventListener("click", () => {
        input.value = "";
        output.value = "";
        clearChunks();
        setStatus("已清空");
      });

      loadClipboard.addEventListener("click", () => {
        vscode.postMessage({ type: "loadClipboard", mode: "replace" });
      });

      appendClipboard.addEventListener("click", () => {
        vscode.postMessage({ type: "loadClipboard", mode: "append" });
      });

      toggleCopied.addEventListener("click", () => {
        setCopiedExpanded(!copiedExpanded);
      });

      resetCopied.addEventListener("click", () => {
        copiedOrder = [];
        renderChunkLists();
        setStatus("已复位分块");
      });

      chunkToggle.addEventListener("change", () => {
        chunkSize.disabled = !chunkToggle.checked;
        vscode.postMessage({
          type: "updateSettings",
          chunkingEnabled: chunkToggle.checked,
          chunkSize: Number(chunkSize.value),
        });
      });

      chunkSize.addEventListener("change", () => {
        vscode.postMessage({
          type: "updateSettings",
          chunkingEnabled: chunkToggle.checked,
          chunkSize: Number(chunkSize.value),
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "settings") {
          chunkToggle.checked = Boolean(message.chunkingEnabled);
          const size = Number(message.chunkSize);
          if (Number.isFinite(size) && size > 0) {
            chunkSize.value = String(size);
          } else {
            chunkSize.value = "";
          }
          chunkSize.disabled = !chunkToggle.checked;
          return;
        }
        if (message.type === "setInput") {
          applyInput(String(message.text ?? ""), message.mode, message.source);
          // 如果设置了自动执行，在设置输入后立即执行
          if (message.autoExecute) {
            const autoExec = message.autoExecute;
            const mode = autoExec.mode;
            if (mode === "compress" || mode === "decompress") {
              // 使用 setTimeout 确保输入已经设置完成
              setTimeout(() => {
                setMode(mode === "compress" ? "压缩中" : "解压中");
                const size = Number(autoExec.chunkSize);
                vscode.postMessage({
                  type: mode,
                  text: input.value || "",
                  chunkingEnabled: Boolean(autoExec.chunkingEnabled),
                  chunkSize: Number.isFinite(size) ? size : null,
                });
              }, 50);
            }
          }
          return;
        }
        if (message.type === "result") {
          setMode(message.mode === "compress" ? "压缩完成" : "解压完成");
          setStatus(message.status || "");
          if (message.chunks && message.chunks.length > 0) {
            setCopiedExpanded(false);
            renderChunks(message.chunks);
          } else {
            renderOutput(message.output || "");
          }
          return;
        }
        if (message.type === "error") {
          setMode("待命");
          setStatus(message.error || "处理失败", "error");
        }
      });

      document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          const selection = window.getSelection();
          if (selection && selection.toString()) {
            return;
          }
          const text =
            allChunks.length > 0 ? allChunks.join("\\n") : output.value;
          if (text) {
            vscode.postMessage({ type: "copy", text });
            setStatus("已复制结果");
            event.preventDefault();
          }
        }
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
}

export function openCompressionWebview(
  context: vscode.ExtensionContext,
  compress: CompressFn,
  decompress: DecompressFn,
  options?: {
    initialText?: string;
    initialMode?: "compress" | "decompress";
    source?: "editor" | "clipboard";
  }
) {
  const panel = vscode.window.createWebviewPanel(
    "narutoCompression",
    "Naruto 压缩 / 解压",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = getWebviewHtml(panel.webview);

  function postSettings() {
    const config = vscode.workspace.getConfiguration("naruto");
    const chunkingEnabled =
      config.get<boolean>("compression.chunkingEnabled") ?? false;
    const chunkSize = config.get<number | null>("compression.chunkSize") ?? 0;
    panel.webview.postMessage({
      type: "settings",
      chunkingEnabled,
      chunkSize,
    });
  }

  function postInitialData() {
    if (options?.initialText) {
      const config = vscode.workspace.getConfiguration("naruto");
      const chunkingEnabled =
        config.get<boolean>("compression.chunkingEnabled") ?? false;
      const chunkSize = config.get<number | null>("compression.chunkSize");
      
      panel.webview.postMessage({
        type: "setInput",
        mode: "replace",
        source: options.source || "editor",
        text: options.initialText,
        autoExecute: options.initialMode ? {
          mode: options.initialMode,
          chunkingEnabled,
          chunkSize: chunkSize || null,
        } : undefined,
      });
    }
  }

  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === "ready") {
        postSettings();
        postInitialData();
        return;
      }

      if (message.type === "updateSettings") {
        const config = vscode.workspace.getConfiguration("naruto");
        const chunkingEnabled = Boolean(message.chunkingEnabled);
        const rawSize = Number(message.chunkSize);
        const normalizedSize = Number.isFinite(rawSize)
          ? Math.max(16, Math.floor(rawSize))
          : null;

        await config.update(
          "compression.chunkingEnabled",
          chunkingEnabled,
          vscode.ConfigurationTarget.Global
        );
        await config.update(
          "compression.chunkSize",
          normalizedSize,
          vscode.ConfigurationTarget.Global
        );
        postSettings();
        return;
      }

      if (message.type === "copy") {
        const text = String(message.text ?? "");
        if (text) {
          await vscode.env.clipboard.writeText(text);
        }
        return;
      }

      if (message.type === "loadClipboard") {
        const mode = message.mode === "append" ? "append" : "replace";
        const text = await vscode.env.clipboard.readText();
        panel.webview.postMessage({
          type: "setInput",
          mode,
          source: "clipboard",
          text,
        });
        return;
      }

      if (message.type === "compress") {
        const text = String(message.text ?? "");
        const chunkingEnabled = Boolean(message.chunkingEnabled);
        const rawSize = Number(message.chunkSize);
        const chunkSize = Number.isFinite(rawSize)
          ? Math.max(16, Math.floor(rawSize))
          : null;

        const compressedData = await compress(text);
        const encoded = base91Encode(compressedData);
        const shouldChunk =
          chunkingEnabled && chunkSize && encoded.length > chunkSize;
        const chunks = shouldChunk ? chunkString(encoded, chunkSize) : [];

        panel.webview.postMessage({
          type: "result",
          mode: "compress",
          output: encoded,
          chunks,
          status: shouldChunk
            ? `已生成 ${chunks.length} 个分块`
            : `长度 ${encoded.length}`,
        });
        return;
      }

      if (message.type === "decompress") {
        const text = String(message.text ?? "");
        const decoded = base91Decode(text);
        const decompressedText = await decompress(decoded);

        panel.webview.postMessage({
          type: "result",
          mode: "decompress",
          output: decompressedText,
          chunks: [],
          status: `长度 ${decompressedText.length}`,
        });
      }
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : "未知错误";
      panel.webview.postMessage({
        type: "error",
        error: messageText,
      });
    }
  });
}
