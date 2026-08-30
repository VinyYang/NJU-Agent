/* NJU CodePilot front-end — single self-contained module.

 * The UI is deliberately dependency-free so the stdlib server can serve this
 * directory directly.  Set window.CODEPILOT_API_BASE (or ?api=http://127.0.0.1:8000)
 * when the API lives on another origin.
 */

const API_BASE = (window.CODEPILOT_API_BASE || new URLSearchParams(location.search).get("api") || "").replace(/\/$/, "");

function uid() {
  return (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function $(id) {
  return document.getElementById(id);
}

// Initialize state with default values
const state = {
  mode: "execute",
  sessionId: null,
  connected: false,
  previewOnly: false,
  workspace: "",
  workspaceName: "",
  tree: null,
  selectedPath: "",
  readErrorPaths: new Set(),
  selectedFolderPath: "",
  lastTask: "",
  localFiles: new Map(),
  drafts: new Map(),
  savedFiles: new Map(),
  editorDirty: false,
  editorSavedContent: "",
  editorSaving: false,
  terminalHistory: [],
  terminalHistoryIndex: -1,
  activeRequestController: null,
  editingUserOrdinal: null,
  userMessageCount: 0,
  localHandles: new Map(),
  settings: { baseUrl: "https://xcpcai.com/v1", model: "gpt-5.6-sol", apiKey: "", wireApi: "auto", reasoningEffort: "medium" },
  apiKeyConfigured: false,
  collapsedPaths: new Set(),
  activities: [],
  changeReview: { changes: [], expanded: false },
  plan: [
    { id: uid(), text: "检查项目结构与现有测试入口", status: "todo" },
    { id: uid(), text: "实现任务所需的最小代码改动", status: "todo" },
    { id: uid(), text: "运行 smoke test，汇报结果并指出风险", status: "todo" },
  ],
  planState: "draft",
  workflow: {
    phase: "intake",
    route: "direct_execute",
    nextAction: "execute",
    clarificationRound: 0,
    questions: [],
    answers: {},
    assumptions: [],
    planRevision: 1,
  },
  planRequestPending: false,
  // Which sub-view the plan dialog shows ("clarify" | "plan" | null = follow phase).
  // The user can hop back and forth between 需求问答 and 执行计划 at any time,
  // including across multiple clarification rounds.
  planViewTab: null,
  selectedSessionIds: new Set(),
  sessionDeletePending: false,
  planReturnFocus: null,
  planScrollTop: 0,
  sessionCreatePayload: null,
  // Context compaction at the confirm->execute seam.  lastCompaction holds the
  // persisted checkpoint from the backend so the "查看压缩" button and modal
  // survive a reload/restore.
  lastCompaction: null,
  compactionAnimation: {
    el: null, startedAt: 0, data: null, finishing: false,
    minVisible: 1200, finalizeTimer: null, animBubble: null,
  },
  files: {
    "src/agent.py": `"""A tiny local-first coding agent."""\n\nfrom dataclasses import dataclass\n\n\n@dataclass\nclass Turn:\n    role: str\n    content: str\n\n\ndef next_action(turn: Turn) -> str:\n    """Return the next safe action for a conversation turn."""\n    if turn.role != "user":\n        return "wait"\n    return "inspect"\n`,
    "src/tools.py": `from pathlib import Path\n\n\ndef read_text(path: str) -> str:\n    return Path(path).read_text(encoding="utf-8")\n\n\ndef write_text(path: str, content: str) -> None:\n    Path(path).write_text(content, encoding="utf-8")\n`,
    "tests/test_agent.py": `from src.agent import Turn, next_action\n\n\ndef test_user_turn_starts_with_inspection():\n    assert next_action(Turn("user", "add a test")) == "inspect"\n`,
    "README.md": "# Demo project\n\nA local coding agent playground.\n",
    "pyproject.toml": "[project]\nname = \"demo-project\"\nversion = \"0.1.0\"\n",
    ".gitignore": "__pycache__/\n.venv/\n",
  },
};
// Scroll the conversation to the live bottom only while the user is already
// near it.  When the user scrolls up to read, model streaming must not yank
// the scrollbar back to the bottom.  Instead, a floating "回到最新消息"
// button appears; a dot on it marks that new content arrived while reading.
const scrollFollow = { pendingNewContent: false };
function updateScrollToBottomButton() {
  const el = $("conversation");
  const button = $("scrollToBottomButton");
  if (!el || !button) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  const away = distance >= 48;
  button.hidden = !away;
  const dot = $("scrollToBottomDot");
  if (dot) dot.hidden = !(scrollFollow.pendingNewContent && away);
  if (!away) scrollFollow.pendingNewContent = false;
}
function scrollConversationToBottom() {
  const el = $("conversation");
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distance < 48) el.scrollTop = el.scrollHeight;
  else scrollFollow.pendingNewContent = true;
  updateScrollToBottomButton();
}

// Surface swallowed frontend exceptions as a visible chat bubble so a
// silent stall (like a plan dialog that "never opens") can be diagnosed
// without opening DevTools.
const _surfaceFrontendError = (message) => {
  try {
    if (!document.querySelector("#conversation")) return;
    const modal = $("planModal");
    if (modal && !modal.hidden) return;
    appendMessage("assistant", "⚠ 界面内部错误（已显示以便排查）：" + String(message || "未知错误").slice(0, 300), "CodePilot · 界面");
    notify("界面错误：" + String(message || "未知错误").slice(0, 120), 5000);
  } catch { /* ignore */ }
};
window.addEventListener("error", (event) => _surfaceFrontendError(event?.message || "script error"));
window.addEventListener("unhandledrejection", (event) => _surfaceFrontendError(event?.reason?.message || event?.reason || "unhandled promise"));

const mockTree = {
  name: "demo-project",
  type: "directory",
  children: [
    { name: "src", type: "directory", children: [{ name: "agent.py", type: "file", path: "src/agent.py" }, { name: "tools.py", type: "file", path: "src/tools.py" }] },
    { name: "tests", type: "directory", children: [{ name: "test_agent.py", type: "file", path: "tests/test_agent.py" }] },
    { name: "README.md", type: "file", path: "README.md" },
    { name: "pyproject.toml", type: "file", path: "pyproject.toml" },
    { name: ".gitignore", type: "file", path: ".gitignore" },
  ],
};
function notify(message, timeout = 3000) {
  const toast = $("toast");
  toast.textContent = localizeNotice(message);
  toast.classList.add("show");
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => toast.classList.remove("show"), timeout);
}
function setConnection(connected, label) {
  state.connected = connected;
  const badge = $("workspaceAccessBadge");
  if (badge) {
    badge.hidden = connected;
    badge.textContent = connected ? "" : (label || "只读预览");
    badge.title = connected ? "后端已连接，可直接修改真实工作区" : "浏览器内存预览；不会写入原目录";
  }
  const preview = Boolean(state.previewOnly);
  const editor = $("codeEditor");
  if (editor) {
    editor.readOnly = preview;
    editor.setAttribute("aria-readonly", String(preview));
  }
  ["newFileButton", "newFolderButton"].forEach((id) => {
    const button = $(id);
    if (button) {
      if (!button.dataset.defaultTitle) button.dataset.defaultTitle = button.title || "";
      button.disabled = preview;
      button.title = preview ? "预览模式不可写入文件" : button.dataset.defaultTitle;
    }
  });
}
function shortPath(path) {
  if (!path) return "未连接工作区";
  const clean = path.replace(/[\\/]+$/, "");
  const bits = clean.split(/[\\/]/);
  return bits[bits.length - 1] || clean;
}
async function api(path, options = {}) {
  if (!API_BASE && location.protocol === "file:") return null;
  const { controller: suppliedController, timeout: requestTimeout, quiet, ...requestOptions } = options;
  const controller = suppliedController || new AbortController();
  const timeout = window.setTimeout(() => controller.abort("timeout"), requestTimeout || 12000);
  try {
    const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token") || "";
    const headers = { Accept: "application/json", ...(requestOptions.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestOptions.headers || {}) };
    const response = await fetch(`${API_BASE}${path}`, { ...requestOptions, headers, signal: controller.signal });
    const type = response.headers.get("content-type") || "";
    const raw = type.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = raw && typeof raw === "object" ? raw : {};
      return { ...detail, ok: false, error: detail.error || `HTTP ${response.status}` };
    }
    return raw;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "user") return { ok: false, cancelled: true };
    if (quiet !== true) console.info("CodePilot API unavailable:", path, error.message);
    // Keep transport failures in the same structured shape as HTTP errors so
    // the conversation can render an actionable agent message instead of
    // silently falling back to a local demo response.
    const transport = /network error|failed to fetch|load failed|connection/i.test(String(error?.message || ""));
    return {
      ok: false,
      error: transport
        ? "无法连接后端服务：实时连接已中断（后端可能刚重启）。请确认 python run.py 仍在运行后重试。"
        : `无法连接后端服务：${error?.message || "网络请求失败"}`,
      network_error: true,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function isTransportError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.name === "TypeError"
    || /network error|failed to fetch|load failed|err_connection|econnreset|connection reset|connection refused|backend exited|流式连接/.test(message);
}
function describeTransportError(error) {
  const raw = String(error?.message || error || "").trim();
  if (/timeout/i.test(raw) || error?.name === "AbortError" && error?.message === "timeout") {
    return "请求超时：模型或工具执行时间过长，请重试一次。";
  }
  // Chromium reports a bare ``network error`` when an SSE body is reset
  // mid-read (backend hot-reload, process crash, or proxy drop).
  return "与后端的实时连接已中断。常见原因是后端重启或网络抖动；若界面已出现待明确的问题，可直接在计划对话框继续回答，否则请重试。";
}
function streamHadUsefulProgress(events = []) {
  return events.some((event) => ["clarification_requested", "workflow_result", "assistant_delta", "assistant", "plan_progress"].includes(event?.type)
    && String(event.content || event.message || event.delta || (event.questions || []).length || "").trim());
}
async function streamAgentText(prompt, onDelta, suppliedController = null) {
  const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token") || "";
  const controller = suppliedController || new AbortController();
  const response = await fetch(`${API_BASE}/api/model/stream`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ prompt, model: state.settings.model, base_url: state.settings.baseUrl, api_key: state.settings.apiKey, wire_api: state.settings.wireApi, reasoning_effort: state.settings.reasoningEffort }), signal: controller.signal });
  if (!response.ok || !response.body) throw new Error((await response.text()) || "流式连接失败");
  await consumeSSE(response, (payload) => {
    const delta = payload.delta ?? payload.content ?? payload.text ?? "";
    if (delta) onDelta(String(delta));
  });
}
// One shared SSE reader for every streaming call.  It tolerates CRLF, chunk
// boundaries that split multi-byte UTF-8 or a frame, keep-alive comments,
// and a final frame that lacks the trailing blank line.
async function consumeSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const consume = async (frame) => {
    const lines = frame.replace(/\r/g, "").split("\n");
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return false;
    if (data === "[DONE]") return true;
    // Awaiting the handler matters: plan_progress handlers yield through
    // requestAnimationFrame, and only an awaited frame lets the browser paint
    // each completed step separately instead of flushing a whole batch.
    try {
      const parsed = JSON.parse(data);
      if (eventName && (!parsed || typeof parsed !== "object")) return false;
      // The SSE ``event:`` name is the source of truth for the frame kind.
      // Backend frames that omit ``type`` in their data body (the final
      // workflow_result / done frames) must still be recognised as such.
      if (eventName && parsed.type === undefined) parsed.type = eventName;
      return await onEvent(parsed) === true;
    } catch { return false; }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        if (await consume(frame)) return;
      }
      if (done) {
        if (buffer.trim()) await consume(buffer);
        return;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (isTransportError(error)) {
      const wrapped = new Error(describeTransportError(error));
      wrapped.name = "TransportError";
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}
// Only send provider fields when this tab actually has a key.  An explicitly
// empty api_key tells the backend to build an offline model, so omitting the
// field lets it fall back to the key saved on the account / in .env instead of
// silently turning every clarify/plan/run into a local stub.
function modelRequestFields() {
  return state.settings.apiKey ? {
    model: $("modelSelect").value,
    base_url: state.settings.baseUrl,
    api_key: state.settings.apiKey,
    wire_api: state.settings.wireApi,
    reasoning_effort: state.settings.reasoningEffort,
  } : {};
}
async function streamSessionWorkflow(action, payload, onEvent, timeoutMs = 600000) {
  if (!state.sessionId) throw new Error("session is not ready");
  const controller = state.activeRequestController || new AbortController();
  const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token") || "";
  // A long agent run may stream for many minutes.  Guard with a generous
  // wall-clock cap rather than the default 12s api() timeout so model
  // reasoning and local tool loops are never cut short mid-stream.
  const safetyTimer = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(state.sessionId)}/stream`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...payload, action }), signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const wrapped = new Error(describeTransportError(error));
      wrapped.name = "TransportError";
      wrapped.cause = error;
      throw wrapped;
    }
    if (!response.ok || !response.body) throw new Error(await response.text() || "流式连接失败");
    await consumeSSE(response, (event) => {
      const stop = onEvent(event) === true;
      if (event?.type === "workflow_result") {
        // Do NOT abort immediately: the backend still needs to write the
        // trailing ``done`` frame.  Tearing down the socket at this exact
        // moment races the server's ``on_disconnect`` into cancel() and can
        // flip a just-generated plan into "cancelled".  Give it a short
        // grace window so the stream ends cleanly.
        window.setTimeout(() => { if (!controller.signal.aborted) controller.abort("workflow_complete"); }, 2000);
        return false;
      }
      if (stop || event?.type === "done") {
        if (!controller.signal.aborted) controller.abort("workflow_complete");
        return true;
      }
      return false;
    });
  } catch (error) {
    if (error?.name === "AbortError" && controller.signal.reason === "workflow_complete") return;
    throw error;
  } finally {
    window.clearTimeout(safetyTimer);
  }
}
// Stream a brand-new session.  Session creation runs the slow model intake and
// planning analysis server-side; using the streamed create endpoint lets those
// ``assistant_delta`` tokens render live instead of behind a silent blocking
// gap followed by a burst of text.
async function streamCreateWorkflow(payload, onEvent, timeoutMs = 600000) {
  const controller = state.activeRequestController || new AbortController();
  const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token") || "";
  const safetyTimer = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${API_BASE}/api/sessions/stream`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const wrapped = new Error(describeTransportError(error));
      wrapped.name = "TransportError";
      wrapped.cause = error;
      throw wrapped;
    }
    if (!response.ok || !response.body) throw new Error(await response.text() || "流式连接失败");
    await consumeSSE(response, (event) => {
      const stop = onEvent(event) === true;
      if (event?.type === "workflow_result") {
        window.setTimeout(() => { if (!controller.signal.aborted) controller.abort("workflow_complete"); }, 2000);
        return false;
      }
      if (stop || event?.type === "done") {
        if (!controller.signal.aborted) controller.abort("workflow_complete");
        return true;
      }
      return false;
    });
  } catch (error) {
    if (error?.name === "AbortError" && controller.signal.reason === "workflow_complete") return;
    throw error;
  } finally {
    window.clearTimeout(safetyTimer);
  }
}
function normaliseTree(payload) {
  if (!payload) return mockTree;
  // The stdlib API returns {root: absolutePath, items: [...]}; tolerate
  // alternate shapes so the frontend also works with a small proxy/mock.
  if (Array.isArray(payload.items)) {
    const root = { name: state.workspaceName || shortPath(payload.root) || shortPath(state.workspace) || "workspace", type: "directory", children: [] };
    const folders = new Map([["", root]]);
    for (const raw of payload.items) {
      const path = String(raw.path || raw.name || "").replace(/^\.\//, "").replace(/\\/g, "/");
      if (!path) continue;
      const parts = path.split("/").filter(Boolean);
      const isDirectory = raw.type === "directory" || raw.kind === "directory";
      // Ensure intermediate directories exist even when the API supplies a
      // flat list (the stdlib backend intentionally does this for simplicity).
      let parent = root; let parentPath = "";
      parts.forEach((part, index) => {
        const currentPath = parentPath ? `${parentPath}/${part}` : part;
        const leaf = index === parts.length - 1;
        if (leaf && !isDirectory) {
          if (!(parent.children || []).some((entry) => entry.path === path)) parent.children.push({ name: part, type: "file", path });
          return;
        }
        let folder = (parent.children || []).find((entry) => entry.name === part && entry.type === "directory");
        if (!folder) { folder = { name: part, type: "directory", children: [] }; parent.children.push(folder); }
        parent = folder; parentPath = currentPath;
      });
      if (isDirectory && parts.length === 0) continue;
    }
    return root;
  }
  const root = payload.tree || payload.root || payload;
  if (Array.isArray(root)) return { name: state.workspaceName || shortPath(state.workspace) || "workspace", type: "directory", children: root };
  return root;
}
function countFiles(node) {
  if (!node) return 0;
  if (node.type === "file" || node.kind === "file") return 1;
  return (node.children || node.entries || []).reduce((n, child) => n + countFiles(child), 0);
}
function collectPaths(node, parent = "", output = [], includeSelf = false) {
  if (!node) return output;
  const path = node.path || (includeSelf ? (parent ? `${parent}/${node.name || ""}` : (node.name || "")) : parent);
  if (node.type === "file" || node.kind === "file") output.push(path);
  (node.children || node.entries || []).forEach((child) => collectPaths(child, path, output, true));
  return output;
}
function chooseSmokeCommand(tree) {
  const paths = collectPaths(tree).map((path) => path.replace(/\\/g, "/"));
  if (paths.includes("backend/smoke_test.py")) return "python backend/smoke_test.py";
  if (paths.includes("smoke_test.py")) return "python smoke_test.py";
  if (paths.some((path) => path.startsWith("backend/tests/"))) return "python -m unittest discover -s backend/tests -v";
  if (paths.includes("package.json")) return "npm test";
  if (paths.includes("Cargo.toml")) return "cargo test";
  if (paths.includes("go.mod")) return "go test ./...";
  if (paths.some((path) => path.startsWith("tests/") && path.endsWith(".py"))) return "python -m unittest discover -s tests -v";
  return "python -m unittest discover -v";
}
function iconClass(path = "") {
  const name = String(path || "").toLowerCase();
  const fileName = name.split(/[\\/]/).pop() || "";
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1) : "";
  if (fileName === "dockerfile") return ["docker", "DK"];
  if (fileName === "makefile") return ["make", "MK"];
  if (fileName === ".gitignore" || fileName === ".env" || fileName === ".npmrc") return ["env", "EN"];
  if (name.includes("test") || name.includes("spec")) return ["test", "✓"];
  const map = {
    py: ["py", "PY"],
    js: ["js", "JS"], mjs: ["js", "JS"], cjs: ["js", "JS"],
    jsx: ["jsx", "JX"],
    ts: ["ts", "TS"], tsx: ["tsx", "TX"],
    html: ["html", "HT"], htm: ["html", "HT"],
    css: ["css", "CS"], scss: ["css", "CS"], less: ["css", "CS"], sass: ["css", "CS"],
    vue: ["vue", "VU"],
    md: ["md", "MD"], mdx: ["md", "MD"],
    json: ["json", "{}"], toml: ["config", "{}"], yaml: ["config", "{}"], yml: ["config", "{}"], ini: ["config", "{}"], conf: ["config", "{}"],
    go: ["go", "GO"],
    rs: ["rs", "RS"],
    java: ["java", "JA"], kt: ["java", "JA"],
    c: ["c", "C"],
    h: ["h", "H"],
    cpp: ["cpp", "C+"], cc: ["cpp", "C+"], cxx: ["cpp", "C+"], hpp: ["cpp", "C+"],
    cs: ["cs", "C#"],
    php: ["php", "PH"],
    rb: ["rb", "RB"],
    swift: ["swift", "SW"],
    sh: ["shell", ">_"], bash: ["shell", ">_"], zsh: ["shell", ">_"],
    ps1: ["shell", "PS"], bat: ["shell", "BT"], cmd: ["shell", "CM"],
    sql: ["sql", "DB"],
    svg: ["image", "IM"], png: ["image", "IM"], jpg: ["image", "IM"], jpeg: ["image", "IM"], gif: ["image", "IM"], webp: ["image", "IM"], ico: ["image", "IM"],
    pdf: ["pdf", "PDF"],
    txt: ["txt", "TX"], log: ["txt", "LG"],
    zip: ["archive", "ZP"], tar: ["archive", "ZP"], gz: ["archive", "ZP"], "7z": ["archive", "ZP"], rar: ["archive", "ZP"],
    env: ["env", "EN"],
    lock: ["lock", "L"],
  };
  if (map[ext]) return map[ext];
  if (!ext && fileName.startsWith(".")) return ["env", "EN"];
  return ["", "·"];
}
function renderTree() {
  const target = $("fileTree");
  target.replaceChildren();
  const root = state.tree || mockTree;
  const rootChildren = root.children || root.entries || [];
  const renderNode = (node, depth, parent) => {
    const isFolder = node.type === "directory" || node.kind === "directory" || Array.isArray(node.children) || Array.isArray(node.entries);
    const path = node.path || (parent ? `${parent}/${node.name}` : node.name);
    const collapsed = isFolder && state.collapsedPaths.has(path);
    const row = document.createElement("div");
    row.className = `tree-node ${isFolder ? "folder" : "file"}${!isFolder && path === state.selectedPath ? " selected" : ""}`;
    row.setAttribute("role", "treeitem");
    row.dataset.path = path;
    row.dataset.kind = isFolder ? "directory" : "file";
    row.tabIndex = 0;
    if (isFolder) row.setAttribute("aria-expanded", String(!collapsed));
    else row.setAttribute("aria-selected", String(path === state.selectedPath));
    row.style.paddingLeft = `${8 + depth * 15}px`;
    const chevron = document.createElement("span");
    chevron.className = `node-chevron${isFolder ? (collapsed ? " collapsed" : " expanded") : " empty"}`;
    chevron.textContent = "";
    row.append(chevron);
    const icon = document.createElement("span");
    const [klass, glyph] = iconClass(path);
    icon.className = `node-icon ${isFolder ? "folder-icon" : klass}`;
    icon.textContent = isFolder ? "" : glyph;
    row.append(icon);
    const label = document.createElement("span");
    label.className = "node-label";
    label.textContent = node.name || path;
    row.append(label);
    const activate = () => {
      if (!isFolder) {
        state.selectedFolderPath = "";
        selectFile(path);
        return;
      }
      state.selectedFolderPath = path;
      if (state.collapsedPaths.has(path)) state.collapsedPaths.delete(path);
      else state.collapsedPaths.add(path);
      renderTree();
    };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    target.append(row);
    if (isFolder && !collapsed) (node.children || node.entries || []).forEach((child) => renderNode(child, depth + 1, path));
  };
  rootChildren.forEach((child) => renderNode(child, 0, ""));
  $("treeRootName").textContent = root.name || shortPath(state.workspace) || "workspace";
  const count = countFiles(root);
  $("treeCount").textContent = count;
  if ($("fileCount")) $("fileCount").textContent = `${count} 个文件`;
}
function languageFor(path = "") {
  if (path.endsWith(".py")) return "Python";
  if (path.endsWith(".js")) return "JavaScript";
  if (path.endsWith(".ts")) return "TypeScript";
  if (path.endsWith(".json")) return "JSON";
  if (path.endsWith(".md")) return "Markdown";
  if (path.endsWith(".toml")) return "TOML";
  return "Plain text";
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function highlight(line, path) {
  if (!(path.endsWith(".py") || path.endsWith(".js") || path.endsWith(".ts"))) return escapeHtml(line) || " ";
  // Tokenise the original source before escaping it.  Chaining regexes on
  // generated HTML would accidentally match the class names we add and leak
  // markup into the code preview.
  const tokenPattern = /(#[^\n]*$|\/\/[^\n]*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b(?:def|return|from|import|class|if|else|for|in|const|let|function|new|export|async|await|try|except|true|false|None|null)\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
  let output = "";
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(line))) {
    output += escapeHtml(line.slice(cursor, match.index));
    const token = match[0];
    let klass = "tok-function";
    if (/^(#|\/\/)/.test(token)) klass = "tok-comment";
    else if (/^("|'|`)/.test(token)) klass = "tok-string";
    else if (/^\d/.test(token)) klass = "tok-number";
    else if (/^(?:def|return|from|import|class|if|else|for|in|const|let|function|new|export|async|await|try|except|true|false|None|null)$/.test(token)) klass = "tok-keyword";
    output += `<span class="${klass}">${escapeHtml(token)}</span>`;
    cursor = match.index + token.length;
  }
  output += escapeHtml(line.slice(cursor));
  return output || " ";
}
function renderCode(content, path) {
  const value = String(content ?? "");
  const lines = value.split(/\r?\n/);
  const editor = $("codeEditor");
  editor.value = value;
  const highlightNode = $("codeHighlight");
  if (highlightNode) highlightNode.innerHTML = lines.map((line) => highlight(line, path)).join("\n") + (value.endsWith("\n") ? "\n" : "");
  editor.dataset.path = path;
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  updateEditorMetrics(value);
  if ($("editorLines")) $("editorLines").textContent = `1–${Math.max(lines.length, 1)} / ${Math.max(lines.length, 1)}`;
  if ($("editorLanguage")) $("editorLanguage").textContent = languageFor(path);
  $("editorFileName").textContent = path;
  const [klass, glyph] = iconClass(path);
  $("editorFileIcon").className = `file-icon ${klass}`;
  $("editorFileIcon").textContent = glyph;
  state.editorSavedContent = state.savedFiles.get(path) ?? value;
  state.editorDirty = state.drafts.has(path) && value !== state.editorSavedContent;
  state.editorSaving = false;
  updateEditorState();
}
function updateEditorMetrics(value) {
  const lineCount = Math.max(String(value ?? "").split(/\r?\n/).length, 1);
  if ($("editorLines")) $("editorLines").textContent = `1–${lineCount} / ${lineCount}`;
  $("editorGutter").textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
}
function updateEditorState() {
  const badge = $("editorDirtyBadge");
  if (!badge) return;
  badge.hidden = !state.editorDirty;
}
function markEditorDirty(value) {
  state.drafts.set(state.selectedPath, value);
  state.editorDirty = value !== state.editorSavedContent;
  updateEditorState();
  updateEditorMetrics(value);
  const highlightNode = $("codeHighlight");
  if (highlightNode) highlightNode.innerHTML = value.split(/\r?\n/).map((line) => highlight(line, state.selectedPath)).join("\n") + (value.endsWith("\n") ? "\n" : "");
}
async function confirmDiscardDraft() {
  if (!state.editorDirty) return true;
  // Keep the in-memory draft when the user confirms navigation.  A cancelled
  // confirmation leaves the editor focused, so edits can never disappear
  // silently while browsing the tree.
  const choice = window.confirm("当前文件有未保存修改。点击“确定”保留草稿并切换，点击“取消”留在当前文件。");
  if (!choice) return false;
  state.drafts.set(state.selectedPath, $("codeEditor").value);
  state.editorDirty = false;
  updateEditorState();
  return true;
}
async function selectFile(path) {
  if (!path || typeof path !== "string") return false;
  if (path === state.selectedPath && state.editorDirty) return true;
  if (!(await confirmDiscardDraft())) return false;
  state.selectedPath = path;
  renderTree();
  const draft = state.drafts.get(path);
  let content = draft;
  if (content == null && state.connected) {
    const result = await api(`/api/files/read?root=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(path)}`);
    if (result?.ok === false) {
      state.selectedPath = "";
      renderTree();
      renderCode("", "");
      if (!state.readErrorPaths.has(path)) {
        state.readErrorPaths.add(path);
        notify(result.error || `文件不存在：${path}`);
      }
      return false;
    }
    content = result?.content ?? result?.text ?? (typeof result === "string" ? result : "");
  }
  if (content == null && state.localHandles.has(path)) { try { content = await (await state.localHandles.get(path).getFile()).text(); } catch { content = ""; } }
  if (content == null) content = state.localFiles.get(path) ?? state.files[path];
  if (content == null) content = "// 文件尚未读取，发送任务后由 agent 获取内容。";
  if (!state.savedFiles.has(path)) state.savedFiles.set(path, draft == null ? content : (state.localFiles.get(path) ?? state.files[path] ?? ""));
  state.files[path] = content;
  renderCode(content, path);
  return true;
}
async function saveCode() {
  const editor = $("codeEditor");
  const path = state.selectedPath;
  const content = editor.value;
  if (state.previewOnly) {
    notify("当前是只读预览，不会写入原目录；请先连接后端原生工作区");
    return false;
  }
  if (!state.editorDirty || state.editorSaving) return true;
  state.editorSaving = true;
  updateEditorState();
  let result = null;
  try {
    if (state.connected && state.workspace) {
      result = await api("/api/files/write", {
        method: "PUT",
        body: JSON.stringify({ root: state.workspace, path, content }),
        timeout: 30000,
      });
      if (!result || result.ok === false) throw new Error(result?.error || "后端保存失败");
      notify(`已保存 ${path} 到本地工作区`);
    } else {
      state.localFiles.set(path, content);
      notify(`已保存 ${path} 的浏览器草稿（连接工作区后才会写入磁盘）`);
    }
    state.files[path] = content;
    state.savedFiles.set(path, content);
    state.drafts.delete(path);
    state.editorSavedContent = content;
    state.editorDirty = false;
    return true;
  } catch (error) {
    notify(`保存失败：${error.message || "未知错误"}`);
    return false;
  } finally {
    state.editorSaving = false;
    updateEditorState();
  }
}
function joinWorkspace(relative) {
  if (!state.workspace || /^[A-Za-z]:[\\/]/.test(relative) || relative.startsWith("/")) return relative;
  return `${state.workspace.replace(/[\\/]$/, "")}/${relative}`;
}
function appendMessage(role, content, meta, options = {}) {
  const conversation = $("conversation");
  const welcome = conversation.querySelector(".welcome-block");
  if (welcome) welcome.remove();
  const message = document.createElement("article");
  message.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "你" : "✦";
  const body = document.createElement("div");
  body.className = "message-body";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const messageMeta = document.createElement("div");
  messageMeta.className = "message-meta";
  messageMeta.textContent = meta || (role === "user" ? `你 · ${time}` : `CodePilot · ${time}`);
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  // Empty content is a live/streaming bubble: show nothing (the CSS renders a
  // waiting ellipsis) instead of a misleading "no output" line before the
  // first delta arrives.
  let visibleContent = String(content ?? "");
  if (visibleContent.trim()) visibleContent = localizeAgentText(visibleContent).trim() || visibleContent;
  bubble.innerHTML = formatMessage(visibleContent);
  body.append(messageMeta, bubble);
  if (role === "user") {
    const ordinal = Number.isInteger(options.userOrdinal) ? options.userOrdinal : state.userMessageCount;
    state.userMessageCount = Math.max(state.userMessageCount, ordinal + 1);
    message.dataset.userOrdinal = String(ordinal);
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.setAttribute("data-message-action", "edit-user-message");
    edit.title = "编辑并重新回答";
    edit.setAttribute("aria-label", "编辑这条问题并重新回答");
    edit.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m4 12.5-.7 2.7 2.7-.7 7.8-7.8-2-2zM10.8 5.7l2 2"/></svg>';
    edit.addEventListener("click", () => beginEditUserMessage(message, String(content ?? ""), ordinal));
    actions.append(edit);
    body.append(actions);
  }
  message.append(avatar, body);
  conversation.append(message);
  scrollConversationToBottom();
  return message;
}
async function appendMessageStream(role, content, meta, options = {}) {
  const node = appendMessage(role, "", meta, options);
  const bubble = node.querySelector(".message-bubble");
  const value = String(content ?? "");
  
  // Streaming with natural typing effect: variable speed for realism
  const step = value.length > 1200 ? 8 : value.length > 500 ? 4 : 2;
  for (let i = 0; i < value.length; i += step) {
    bubble.innerHTML = formatMessage(value.slice(0, i + step));
    scrollConversationToBottom();
    // Variable delay for more natural feel
    const delay = Math.random() * 8 + 4;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!value) bubble.innerHTML = formatMessage("本次模型未返回可显示内容，请检查后端运行记录后重试。");
  return node;
}

// New function for true SSE streaming from model API
async function appendMessageStreamFromSSE(role, prompt, meta, options = {}) {
  const node = appendMessage(role, "", meta, options);
  const bubble = node.querySelector(".message-bubble");
  let accumulated = "";
  
  try {
    await streamAgentText(prompt, (delta) => {
      accumulated += delta;
      bubble.innerHTML = formatMessage(accumulated);
      scrollConversationToBottom();
    }, options.controller || state.activeRequestController);
  } catch (error) {
    bubble.innerHTML = formatMessage(`流式输出失败：${error.message}`);
  }
  
  if (!accumulated) bubble.innerHTML = formatMessage("本次模型未返回可显示内容，请检查后端运行记录后重试。");
  return node;
}
function contextIconSvg(mode) {
  const path = mode === "plan" ? '<path d="m9 2 7 7-7 7-7-7z"/>' : '<path d="M4 2.5 15 9 4 15.5z"/>';
  return `<svg class="context-icon toolbar-icon" viewBox="0 0 18 18" aria-hidden="true">${path}</svg>`;
}
function updateComposerContext() {
  const context = $("composerContext");
  if (state.editingUserOrdinal !== null) {
    context.classList.add("editing");
    context.innerHTML = `${contextIconSvg("plan")}<span>正在编辑上一条问题 · 发送后会从此处重新回答</span>`;
    return;
  }
  context.classList.remove("editing");
  context.innerHTML = `${contextIconSvg(state.mode)}<span>${state.mode === "plan" ? "计划模式 · 先确认方案，再动手改代码" : "执行模式 · 我会自主阅读、修改并验证代码"}</span>`;
}
function beginEditUserMessage(node, content, ordinal) {
  if (state.activeRequestController) { notify("请先停止当前回答"); return; }
  state.editingUserOrdinal = ordinal;
  document.querySelectorAll(".message.editing-source").forEach((item) => item.classList.remove("editing-source"));
  node.classList.add("editing-source");
  $("messageInput").value = content;
  updateComposerContext();
  $("messageInput").focus();
}
function trimConversationFromUserOrdinal(ordinal) {
  const target = $("conversation").querySelector(`.message.user[data-user-ordinal="${ordinal}"]`);
  if (!target) return;
  let current = target;
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }
  state.userMessageCount = ordinal;
}
// Models sometimes wrap a plain-text reply (clarification Q&A, plan text) in
// a ``` fence.  That fence is an artifact, not intended content: left alone it
// gets parsed into a code block (or a stray visible ``` when unbalanced) and
// swallows the surrounding wording.  Strip one optional leading + trailing
// fence line so questions and plans render as clean text, while genuine
// interior code blocks are still rendered by formatMessage.
function removeMessageCodeFences(value) {
  let s = String(value ?? "").trim();
  s = s.replace(/^```[^\n]*\n?/, "");   // optional leading fence (```  or ```lang)
  s = s.replace(/\n?```\s*$/, "");      // optional trailing fence
  return s;
}
function formatMessage(value) {
  const text = removeMessageCodeFences(value);
  const chunks = [];
  let cursor = 0;
  const codePattern = /```([\w-]*)\n?([\s\S]*?)```/g;
  let match;
  while ((match = codePattern.exec(text))) {
    chunks.push(escapeHtml(text.slice(cursor, match.index)).replace(/\n/g, "<br>"));
    chunks.push(`<pre>${escapeHtml(match[2])}</pre>`);
    cursor = match.index + match[0].length;
  }
  chunks.push(escapeHtml(text.slice(cursor)).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, "<br>"));
  return chunks.join("");
}
function addThinking() {
  const conversation = $("conversation");
  const node = document.createElement("article");
  node.className = "message assistant thinking-message";
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = "✦";
  const body = document.createElement("div"); body.className = "message-body";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = "CodePilot · 正在处理";
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  const liveLog = document.createElement("div");
  liveLog.className = "thinking-live-log";
  liveLog.setAttribute("aria-live", "polite");
  const liveLines = [
    "先看一下项目结构，确认入口和现有测试怎么组织。",
    "我先把相关文件串起来，避免改动碰到不该动的地方。",
    "现在开始落最小改动；写完我会马上检查它具体解决了什么。",
    "代码写好后我会跑一遍验证，把结果和仍需注意的地方告诉你。",
  ];
  let liveIndex = 0;
  liveLog.textContent = liveLines[liveIndex];
  const progress = document.createElement("span"); progress.className = "thinking";
  [1, 2, 3].forEach(() => { const dot = document.createElement("i"); progress.append(dot); });
  const label = document.createElement("span"); label.className = "thinking-label"; label.textContent = "正在处理这件事 · 已用 0s"; progress.append(label);
  bubble.append(liveLog, progress); body.append(meta, bubble); node.append(avatar, body);
  const started = Date.now();
  node._progressTimer = window.setInterval(() => {
    label.textContent = `正在处理这件事 · 已用 ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  node._liveTimer = window.setInterval(() => {
    liveIndex = (liveIndex + 1) % liveLines.length;
    liveLog.textContent = liveLines[liveIndex];
    scrollConversationToBottom();
  }, 2400);
  conversation.append(node);
  scrollConversationToBottom();
  const remove = node.remove.bind(node);
  node.remove = () => { window.clearInterval(node._progressTimer); window.clearInterval(node._liveTimer); remove(); };
  return node;
}
// Surface the model's own narrative in the conversation transcript.  The
// backend emits assistant events for every model turn; previously these were
// only tucked into the collapsible diagnostics panel, making the interaction
// look silent until the whole tool loop completed.
async function appendAssistantEvents(events = []) {
  // Streaming callers already rendered assistant_delta into a live bubble;
  // avoid appending the same completed assistant turn a second time.
  if (events.some((event) => event?.type === "assistant_delta")) return 0;
  // Intake/plan narratives are the model's thinking; they streamed into the
  // live bubble as assistant_delta, so a completed assistant event would
  // render the same analysis twice.  Execution turns keep their assistant
  // events because those tool-loop messages have no live delta counterpart.
  const narrative = events.filter((event) => event?.type === "assistant" && String(event.content || "").trim() && !["intake", "plan"].includes(event?.stage));
  for (const event of narrative) {
    await appendMessageStream("assistant", event.content, "CodePilot · Agent 实时输出");
  }
  return narrative.length;
}
function describeAgentEvent(event) {
  const args = event.arguments || {}, result = event.result || {};
  if (event.type === "tool_start") {
    if (event.name === "read_file") return `正在读取 ${args.path || "文件"}，用于理解现有实现。`;
    if (event.name === "list_tree") return `正在扫描 ${args.path || "项目目录"}，确认入口和测试。`;
    if (event.name === "search_files") return `正在搜索 ${args.query || "相关代码"}。`;
    if (event.name === "write_file") return `正在写入 ${args.path || "目标文件"}。`;
    if (event.name === "run_command") return `正在验证：${args.command || "测试命令"}。`;
  }
  if (event.type === "tool_result") {
    const change = result.change || {};
    if (change.path || change.summary) {
      const path = change.path || result.path || "目标文件";
      const operation = change.operation === "create" ? "新建" : change.operation === "delete" ? "删除" : "更新";
      const additions = Number(change.additions || 0), deletions = Number(change.deletions || 0);
      const stats = additions || deletions ? `（${additions ? `增加 ${additions} 行` : ""}${additions && deletions ? "，" : ""}${deletions ? `删除 ${deletions} 行` : ""}）` : "";
      return `我已经${operation}了 ${path}${stats}，这一步是把当前方案落到代码里；接下来我会检查它是否和现有入口、测试保持一致。`;
    }
    if (["write_file", "apply_patch"].includes(event.name)) return `代码已写入 ${result.path || "目标文件"}，接下来进行验证。`;
    if (event.name === "read_file") return "文件已读取，模型正在基于内容分析。";
    if (event.name === "run_command") return result.ok === false ? `验证失败：${result.error || "请查看输出"}` : "验证命令已完成。";
  }
  return event.error || event.reason || event.message || event.type;
}
function renderWelcome() {
  $("conversation").innerHTML = `<div class="welcome-block"><div class="welcome-glyph">✦</div><h1 class="welcome-title">你好，我是 CodePilot</h1><p class="welcome-copy">我可以阅读你的本地项目、规划改动、写入文件并运行测试。先说说你想完成什么，计划模式会把每一步交给你确认。</p><div class="suggestion-row"><button class="suggestion-chip suggestion-chip-enhanced" data-prompt="帮我熟悉一下这个项目，找出主要入口和测试命令"><span class="suggestion-icon icon-compass" aria-hidden="true"></span><span>熟悉项目结构</span></button><button class="suggestion-chip suggestion-chip-enhanced" data-prompt="为这个项目补一个健康检查接口，并先给我可编辑的执行计划"><span class="suggestion-icon icon-plan" aria-hidden="true"></span><span>先写执行计划</span></button></div></div>`;
  $("conversation").scrollTop = 0;
  scrollFollow.pendingNewContent = false;
  updateScrollToBottomButton();
  $("conversation").querySelectorAll("[data-prompt]").forEach((button) => {
    if (/smoke\s*test/i.test(button.dataset.prompt || "")) { button.remove(); return; }
    button.classList.add("suggestion-chip-enhanced");
    // Preserve the semantic icon markup rendered above; replacing
    // textContent here used to erase the CSS-drawn compass/document icons.
    button.addEventListener("click", () => { $("messageInput").value = button.dataset.prompt; $("messageInput").focus(); });
  });
}
function renderPlan(justCompleted = -1) {
  const list = $("planList");
  if (!list) return;
  list.replaceChildren();
  // Plan not generated yet (still clarifying / intake / generating): never
  // paint the placeholder steps into the review list — show a loading state
  // instead so the user sees "正在生成" rather than a stale template that
  // gets replaced a moment later.
  const hasPlan = hasGeneratedPlan();
  const stillLoading = !hasPlan && state.planRequestPending;
  if (!hasPlan && !stillLoading) {
    list.classList.remove("executing");
    const empty = document.createElement("div");
    empty.className = "plan-empty-hint";
    empty.textContent = "计划尚未生成，请先完善需求问答。";
    list.append(empty);
    $("approvePlanButton").disabled = true;
    $("addStepButton").disabled = true;
    renderPlanProgress();
    renderPlanWorkflowModal();
    return;
  }
  if (stillLoading) {
    list.classList.remove("executing");
    const load = document.createElement("div");
    load.className = "plan-loading-hint";
    load.innerHTML = '<span class="plan-loading-spinner" aria-hidden="true"></span>正在生成执行计划，请稍候…';
    list.append(load);
    $("approvePlanButton").disabled = true;
    $("addStepButton").disabled = true;
    renderPlanProgress();
    renderPlanWorkflowModal();
    return;
  }
  // The step list is fully frozen while executing (or while the context
  // compression that precedes execution is running): no add/delete/edit.
  // Once the ORIGINAL plan has finished ("complete") the steps turn back into
  // an editable list, so the user can append / change steps for the next
  // round before confirming again.
  const frozen = state.planState === "executing" || state.planState === "compressing";
  const cardsLayout = state.planState === "executing" || state.planState === "complete";
  list.classList.toggle("executing", cardsLayout);
  state.plan.forEach((item, index) => {
    const row = document.createElement("div");
    const statusClass = item.status === "done" ? "done" : item.status === "current" ? "current" : "";
    const just = index === justCompleted ? " just-done" : "";
    row.className = `plan-item ${statusClass}${just}`;
    const number = document.createElement("span");
    number.className = "plan-number";
    number.textContent = item.status === "done" ? "✓" : index + 1;
    const input = document.createElement("input");
    input.className = "plan-input";
    input.value = String(item.text || item.title || "").replace(/`+/g, "");
    input.readOnly = frozen;
    if (item.description) input.title = item.description;
    input.setAttribute("aria-label", `计划步骤 ${index + 1}`);
    input.addEventListener("input", () => { item.text = input.value; item.title = input.value; state.planState = "draft"; updatePlanBadge(); renderPlanWorkflowModal(); });
    const remove = document.createElement("button");
    remove.className = "plan-remove";
    remove.type = "button";
    remove.title = "删除步骤";
    remove.textContent = "×";
    remove.disabled = frozen;
    remove.setAttribute("aria-label", `删除计划步骤 ${index + 1}`);
    remove.addEventListener("click", () => { state.plan.splice(index, 1); state.planState = "draft"; renderPlan(); renderPlanWorkflowModal(); });
    row.append(number, input, remove);
    list.append(row);
  });
  const approveDisabled = state.plan.length === 0 || frozen || state.planState === "complete";
  $("approvePlanButton").disabled = approveDisabled;
  const addBtn = $("addStepButton");
  if (addBtn) addBtn.disabled = frozen;
  renderPlanProgress();
  renderPlanWorkflowModal();
}
// Node-and-link progress bar shown while the plan is executing.  Completed
// nodes light up, the connector currently being crossed animates with a
// flowing gradient, and the caption below names the step in progress.
function renderPlanProgress() {
  const wrap = $("planProgress"); const track = $("planProgressTrack"); const caption = $("planProgressCaption");
  if (!wrap || !track || !caption) return;
  const steps = state.plan || [];
  const active = state.planState === "executing" || state.planState === "complete";
  if (!active || !steps.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  track.replaceChildren();
  const firstNotDone = steps.findIndex((step) => step.status !== "done");
  const currentIndex = firstNotDone === -1 ? steps.length - 1 : Math.max(0, firstNotDone);
  const allDone = firstNotDone === -1;
  steps.forEach((step, index) => {
    const done = step.status === "done" || allDone;
    const current = index === currentIndex && !allDone;
    const node = document.createElement("span");
    node.className = `plan-progress-node${done ? " done" : ""}${current ? " current" : ""}`;
    node.textContent = done ? "✓" : index + 1;
    node.setAttribute("aria-label", `第 ${index + 1} 步${done ? "（已完成）" : current ? "（进行中）" : ""}`);
    if (step.text) node.title = `${index + 1}. ${step.text}`;
    track.append(node);
    if (index < steps.length - 1) {
      const seg = document.createElement("span");
      seg.className = "plan-progress-segment";
      // A segment is "flowing/active" when it sits between a finished node and
      // the next unfinished one — the connector currently being crossed.
      const nextDone = steps[index + 1].status === "done";
      seg.classList.toggle("done", done && nextDone);
      seg.classList.toggle("active", done && !nextDone);
      track.append(seg);
    }
  });
  track.setAttribute("aria-valuemax", String(steps.length));
  track.setAttribute("aria-valuenow", String(allDone ? steps.length : currentIndex));
  caption.replaceChildren();
  if (allDone) {
    const label = document.createElement("span");
    label.className = "plan-progress-caption-done";
    label.textContent = `全部 ${steps.length} 步已完成`;
    caption.append(label);
  } else {
    const pre = document.createElement("span");
    pre.className = "plan-progress-caption-pre";
    pre.textContent = `正在第 ${currentIndex + 1} 步（共 ${steps.length} 步）：`;
    const name = document.createElement("span");
    name.className = "plan-progress-caption-text";
    name.textContent = steps[currentIndex]?.text || steps[currentIndex]?.title || `步骤 ${currentIndex + 1}`;
    caption.append(pre, name);
  }
}
async function applyPlanProgress(event) {
  if (!event || event.type !== "plan_progress") return;
  const total = Number(event.total) || state.plan.length;
  const completed = event.complete ? total : Math.max(0, Number(event.index) || 0);
  const previousDone = state.plan.reduce((count, step) => count + (step.status === "done" ? 1 : 0), 0);
  state.plan.forEach((step, index) => { step.status = index < completed ? "done" : index === completed ? "current" : "todo"; });
  state.planState = event.complete ? "complete" : "executing";
  renderPlan(completed > previousDone ? completed - 1 : -1);
  notify(event.complete ? `计划完成 ${total}/${total} 步` : `已完成 ${completed}/${total} 步`, 1800);
  // Yield to the browser so each step is painted as its own frame instead of
  // all progress events flushing in a single synchronous burst.
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
function updatePlanBadge() {
  const badge = $("planState");
  badge.className = `plan-state ${state.planState}`;
  badge.textContent = ({ draft: "待确认", confirmed: "已确认", compressing: "压缩中…", executing: "执行中", complete: "已完成" })[state.planState] || "待确认";
  const button = $("approvePlanButton");
  if (button) {
    // While executing/compressing the plan is frozen: no re-confirm.  After a
    // reload of an interrupted run (or a live stop) the same button turns into
    // "继续执行" and is enabled again.
    const frozen = ["executing", "compressing"].includes(state.planState);
    button.disabled = state.plan.length === 0 || frozen || state.planRequestPending;
    button.setAttribute("aria-busy", String(Boolean(state.planRequestPending)));
    const resuming = isResumablePlanSession();
    const icon = button.querySelector("span");
    if (icon) icon.textContent = resuming ? "▶" : "✓";
    let labelNode = null;
    for (const child of button.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) { labelNode = child; break; }
    }
    if (labelNode) labelNode.textContent = resuming ? " 继续执行" : " 确认并执行";
  }
}
// An approved plan that was stopped mid-run (live cancel) or restored while
// mid-execution (interrupted) can be continued instead of being replanned.
// A confirmed plan with partial step progress (some done, not all) is equally
// resumable: resuming must continue from the next undone step rather than
// re-running the whole plan from step 1.
function isResumablePlanSession() {
  const phase = String(state.workflow?.phase || "");
  const confirmed = state.planState === "confirmed";
  if (!confirmed) return false;
  if (phase === "cancelled" || phase === "interrupted") return true;
  // Partial-but-not-complete execution: at least one step finished, not all.
  const steps = state.plan || [];
  if (!steps.length) return false;
  const doneCount = steps.reduce((count, step) => count + (step.status === "done" ? 1 : 0), 0);
  return doneCount > 0 && doneCount < steps.length;
}
function addActivity(title, detail, icon = "↗", status = "normal") {
  state.activities.unshift({ title, detail, icon, time: new Date(), status });
  const badge = $("activityBadge"); if (badge) badge.textContent = state.activities.length;
  const list = $("activityList");
  if (!list) return;
  list.innerHTML = state.activities.map((item) => {
    const statusClass = item.status === "success" ? "success" : item.status === "error" ? "error" : item.status === "running" ? "running" : "";
    return `<div class="activity-item ${statusClass}"><span class="activity-icon">${item.icon}</span><span>${escapeHtml(localizeNotice(item.title))}<br><span style="color:#afa4b1">${escapeHtml(localizeNotice(item.detail))}</span></span><span class="activity-time">${item.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`;
  }).join("");
}
function renderRunMetrics(payload) {
  const metrics = payload?.result?.metrics || payload?.metrics;
  if (!metrics) return;
  const files = Array.isArray(metrics.files_changed) ? metrics.files_changed.length : 0;
  addActivity("运行摘要", `${metrics.tool_calls || 0} 次工具调用 · ${files} 个文件变更 · ${metrics.duration_ms || 0}ms · 验证${metrics.validation_passed ? "通过" : "未通过/未执行"}`, metrics.validation_passed ? "✓" : "!", metrics.validation_passed ? "success" : "error");
}
function changeLabel(operation) {
  return ({ create: "新增", modify: "修改", delete: "删除" })[operation] || "变更";
}
function extractChanges(events = []) {
  const grouped = new Map();
  events.filter((event) => event.type === "tool_result" && event.result?.change).forEach((event) => {
    const change = event.result.change;
    const path = String(change.path || event.result.path || "");
    if (!path) return;
    const previous = grouped.get(path);
    if (!previous) grouped.set(path, { ...change, path });
    else grouped.set(path, {
      ...previous,
      operation: previous.operation === "create" ? "create" : (change.operation || previous.operation),
      after_content: change.after_content ?? previous.after_content,
      additions: (previous.additions || 0) + (change.additions || 0),
      deletions: (previous.deletions || 0) + (change.deletions || 0),
      diff: change.diff || previous.diff,
      undoable: previous.undoable !== false && change.undoable !== false,
    });
  });
  return [...grouped.values()];
}
function renderChangeReview(changes = [], expanded = false) {
  state.changeReview = { changes, expanded };
  const card = $("changeReviewCard");
  if (!card) return;
  card.hidden = changes.length === 0;
  if (!changes.length) return;
  const additions = changes.reduce((sum, item) => sum + (item.additions || 0), 0);
  const deletions = changes.reduce((sum, item) => sum + (item.deletions || 0), 0);
  $("changeReviewTitle").textContent = `${changes.length} 个文件已修改`;
  $("changeReviewStats").innerHTML = `<span class="change-add">+${additions}</span> <span class="change-delete">-${deletions}</span>`;
  const list = $("changeReviewFiles");
  list.replaceChildren();
  const visible = expanded ? changes : changes.slice(0, 3);
  visible.forEach((change) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "change-review-file";
    row.innerHTML = `<span class="change-file-operation ${change.operation}">${changeLabel(change.operation)}</span><span class="change-file-path">${escapeHtml(change.path)}</span><span class="change-file-stats"><span class="change-add">+${change.additions || 0}</span> <span class="change-delete">-${change.deletions || 0}</span></span>`;
    row.addEventListener("click", () => openChangeDiff(change));
    list.append(row);
  });
  const more = $("changeReviewMore");
  more.hidden = changes.length <= 3;
  more.textContent = expanded ? "收起文件列表" : `再显示 ${changes.length - 3} 个文件`;
}
// All application dialogs share one visibility contract. Keeping this in a
// small manager prevents a plan review from being rendered underneath the
// history/settings/diff dialogs and keeps body scroll locking consistent.
const APP_MODAL_IDS = ["planModal", "sessionHistoryModal", "settingsModal", "personalCenterModal", "changeReviewModal", "compactionModal"];
function syncModalBodyLock() {
  const hasVisibleModal = APP_MODAL_IDS.some((id) => {
    const modal = $(id);
    return Boolean(modal && !modal.hidden);
  });
  document.body.classList.toggle("modal-open", hasVisibleModal);
}
function closeOtherModals(exceptId = "") {
  const plan = $("planModal");
  if (plan && exceptId !== "planModal" && !plan.hidden) {
    const panel = $("planPanel");
    const inspector = document.querySelector(".inspector");
    if (panel && inspector && !inspector.contains(panel)) inspector.append(panel);
  }
  APP_MODAL_IDS.forEach((id) => {
    if (id === exceptId) return;
    const modal = $(id);
    if (modal) modal.hidden = true;
  });
  syncModalBodyLock();
}
function openChangeDiff(change) {
  const modal = $("changeReviewModal");
  if (!modal) return;
  closeOtherModals("changeReviewModal");
  $("changeDiffTitle").textContent = `${changeLabel(change.operation)} · ${change.path}`;
  const diffMessage = change.diff
    ? change.diff
    : (change.undoable === false ? "（文件内容过大，未生成逐行 diff）" : "（无文本内容变更）");
  $("changeDiffContent").textContent = diffMessage;
  modal.hidden = false;
  syncModalBodyLock();
}
function closeChangeDiff() {
  const modal = $("changeReviewModal");
  if (modal) modal.hidden = true;
  syncModalBodyLock();
}
async function undoChanges() {
  const changes = state.changeReview.changes;
  if (!changes.length) return;
  const button = $("undoChangesButton");
  button.disabled = true;
  try {
    for (const change of [...changes].reverse()) {
      if (!change.undoable) throw new Error(`${change.path} 无法自动撤销`);
      if (change.operation === "create") {
        const result = await api("/api/files/delete", { method: "DELETE", body: JSON.stringify({ root: state.workspace, path: change.path }), timeout: 30000 });
        if (!result || result.ok === false) throw new Error(result?.error || `删除 ${change.path} 失败`);
      } else {
        const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ root: state.workspace, path: change.path, content: change.before_content || "" }), timeout: 30000 });
        if (!result || result.ok === false) throw new Error(result?.error || `恢复 ${change.path} 失败`);
      }
    }
    renderChangeReview([]);
    await refreshWorkspaceTree();
    notify("本轮文件改动已撤销");
  } catch (error) {
    notify(`撤销失败：${error.message || "未知错误"}`);
  } finally {
    button.disabled = false;
  }
}
async function ensureSession(onEvent) {
  if (state.sessionId || !state.connected) return state.sessionId;
  const provider = modelRequestFields();
  const payload = { workspace: state.workspace, task: state.lastTask, mode: state.mode, ...provider };
  let created = null;
  const streamed = [];
  // A live agent conversation must never hide the model's intake and planning
  // work behind a single synchronous response.  Route creation through the
  // streamed endpoint and forward events to the caller so every turn is
  // agent-driven; the blocking endpoint remains only a fallback for callers
  // that have no SSE sink (e.g. sidebar helpers).
  if (typeof onEvent === "function") {
    try {
      await streamCreateWorkflow(payload, (event) => {
        streamed.push(event);
        if (event?.type === "workflow_result") created = event;
        onEvent(event);
      }, 600000);
    } catch (error) {
      if (!created) created = streamed.filter((event) => event?.type === "workflow_result").at(-1) || null;
      if (!created || !(created.id || created.session_id || created.sessionId || created.session?.id)) throw error;
      notify("会话已创建，但实时连接中断；已保留问答与计划结果。");
    }
    if (!created) throw new Error("无法通过流式接口创建会话，请检查后端连接和 API 配置");
  } else {
    created = await api("/api/sessions", { method: "POST", body: JSON.stringify(payload), timeout: 300000 });
    if (created?.ok === false) throw new Error(created.error || "无法创建会话");
  }
  if (!(created.id || created.session_id || created.sessionId || created.session?.id)) {
    throw new Error(created.error || "无法创建会话，请检查后端连接和 API 配置");
  }
  state.sessionCreatePayload = created;
  state.sessionId = created?.id || created?.session_id || created?.sessionId || created?.session?.id || null;
  if (created && created.ok !== false) syncWorkflow(created, { open: false });
  // 保存会话ID到localStorage
  if (state.sessionId) {
    localStorage.setItem("codepilot.sessionId", state.sessionId);
  }
  return state.sessionId;
}
function mockReply(message) {
  if (/测试|test|smoke/i.test(message)) return "我会先检查测试入口，再运行 smoke test。计划已放在右侧，你可以修改步骤后确认。";
  if (/结构|熟悉|入口/.test(message)) return "我会从 README、src/ 和 tests/ 开始扫描，确认启动入口和测试命令。计划已生成，确认后才会读取并执行命令。";
  return "收到。我先把需求拆成可验证的步骤，计划在右侧可直接编辑。确认计划后，我才会写文件或运行命令。";
}
function extractAssistant(payload) {
  if (!payload) return null;
  return payload.message || payload.content || payload.reply || payload.output || payload.result?.message || payload.result?.output || payload.assistant?.content || payload.session?.last_message || (Array.isArray(payload.messages) ? payload.messages.at(-1)?.content : null);
}

function localizeAgentText(value) {
  let text = String(value || "");
  const map = [["No model API key configured", "尚未配置模型 API Key"], ["API key is required", "请先配置 API Key"], ["Model API", "模型服务"], ["Generation stopped by the user.", "已按你的要求停止生成。"], ["The agent stopped after reaching the step limit.", "Agent 达到步骤上限，尚未完成全部工作。"], ["The model returned an empty response", "模型返回了空内容，请重试"]];
  map.forEach(([from, to]) => { text = text.replaceAll(from, to); });
  return text;
}

function localizeNotice(value) {
  let text = localizeAgentText(value);
  const map = [["HTTP ", "接口错误 "], ["timeout", "请求超时"], ["failed", "失败"], ["error", "错误"], ["request", "请求"], ["backend", "后端"], ["network", "网络"]];
  map.forEach(([from, to]) => { text = text.replaceAll(from, to).replaceAll(from.toUpperCase(), to); });
  return text;
}
function extractPlan(payload) {
  if (!payload) return null;
  const plan = payload.plan || payload.steps || payload.data?.plan || payload.result?.plan || payload.session?.plan;
  if (!plan) return null;
  // Models wrap code identifiers in inline backticks (`index.html`, `#63065F`);
  // strip them everywhere a plan step is read so the UI never shows literal ``.
  const clean = (value) => String(value || "").replace(/`+/g, "").trim();
  if (typeof plan === "string") return plan.split("\n").map((text) => clean(text).replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")).filter(Boolean).map((text) => ({ id: uid(), text, description: "", status: "todo" }));
  const normaliseStep = (step) => {
    if (typeof step === "string") return { id: uid(), text: clean(step), description: "", status: "todo" };
    const rawStatus = step?.status || "todo";
    const status = rawStatus === "completed" ? "done" : (rawStatus === "active" ? "current" : rawStatus);
    return { id: step?.id || uid(), text: clean(step?.text || step?.title || step?.name || "未命名步骤"), description: clean(step?.description), status };
  };
  if (Array.isArray(plan)) return plan.map(normaliseStep).filter((step) => step.text.trim());
  if (plan && Array.isArray(plan.steps)) return plan.steps.map(normaliseStep).filter((step) => step.text.trim());
  return null;
}
function extractWorkflow(payload) {
  const session = payload?.session || {};
  const raw = payload?.workflow || session.workflow || {};
  const intake = raw.intake || session.intake || {};
  // Accept both the canonical nested shape and early flat snapshots so a
  // session created by an older frontend can still reopen its plan dialog.
  const legacyQuestions = raw.questions || session.questions;
  const legacyAnswers = raw.answers || session.answers || {};
  const legacyAssumptions = raw.assumptions || session.assumptions || [];
  const phaseCandidates = [String(raw.phase || ""), String(session.phase || ""), String(payload?.result?.status || "")];
  const planPhase = phaseCandidates.find((value) => ["awaiting_approval", "planning", "replanning"].includes(value));
  const hasPlanGeneratedEvent = (payload?.events || payload?.result?.events || []).some((event) => event?.type === "plan_generated");
  // Promotion to an approval-ready phase ONLY when the payload itself already
  // says so, or a plan_generated event proves a real model plan was produced.
  // A plain clarification session carries a default plan stub which must NOT
  // surface the plan review — otherwise the Q&A step would be skipped.
  const phase = planPhase || (hasPlanGeneratedEvent ? "awaiting_approval" : (phaseCandidates.find(Boolean) || "intake"));
  const planState = payload?.plan_state || session.plan || {};
  const event = (payload?.events || payload?.result?.events || []).filter((item) => item.type === "clarification_requested").at(-1);
  const questionSources = [intake.questions, legacyQuestions, event?.all_questions, event?.questions];
  const questions = questionSources.find((value) => Array.isArray(value) && value.length) || [];
  // Completed clarification batches (round 1, round 2, ...).  Persisted on the
  // session snapshot so a reload keeps showing earlier rounds as read-only
  // history next to the interactive current round.
  const roundHistory = Array.isArray(intake.rounds)
    ? intake.rounds
    : (Array.isArray(raw.rounds) ? raw.rounds : (Array.isArray(session.rounds) ? session.rounds : []));
  return {
    phase,
    route: String(raw.route || session.route || "direct_execute"),
    nextAction: String(raw.next_action || ""),
    clarificationRound: Number(intake.round || raw.clarification_round || event?.round || 0),
    rounds: roundHistory.map((entry, index) => ({
      round: index + 1,
      questions: (Array.isArray(entry?.questions) ? entry.questions : []).map((question) => ({
        id: String(question.id || uid()),
        text: String(question.text || question.question || ""),
        required: question.required !== false,
        answered: true,
        answer: String(entry?.answers?.[question.id] || question.answer || ""),
        choices: Array.isArray(question.choices) ? question.choices : [],
      })).filter((question) => question.text && question.answer),
    })),
    questions: Array.isArray(questions) ? questions.map((question) => ({
      id: String(question.id || uid()),
      text: String(question.text || question.question || ""),
      required: question.required !== false,
       answered: Boolean(question.answered || question.answer || intake.answers?.[question.id] || legacyAnswers?.[question.id]),
       answer: String(question.answer || intake.answers?.[question.id] || legacyAnswers?.[question.id] || ""),
      choices: Array.isArray(question.choices) ? question.choices : [],
    })).filter((question) => question.text) : [],
     answers: { ...legacyAnswers, ...(intake.answers || {}) },
     assumptions: Array.isArray(intake.assumptions) && intake.assumptions.length ? intake.assumptions : legacyAssumptions,
    planRevision: Number(raw.plan_revision || session.plan_version || payload?.plan_revision || 1),
    planStatus: String(planState.status || "proposed"),
    // The revision that actually executed (if any).  Matching it against
    // planRevision is what tells the UI "this approved plan already ran" so a
    // reload/restore never falls back to asking for confirmation again.
    lastRunPlanVersion: (session.last_run_plan_version === null || session.last_run_plan_version === undefined || session.last_run_plan_version === "")
      ? null
      : Number(session.last_run_plan_version),
  };
}
function syncWorkflow(payload, options = {}) {
  if (!payload) return state.workflow;
  const workflow = extractWorkflow(payload);
  state.workflow = workflow;
  const plan = extractPlan(payload);
  if (plan) state.plan = plan;
  // Only reason about phase/plan when the payload actually carries workflow
  // truth.  Thin payloads (e.g. a bare run event list with no session) have
  // no authoritative phase and must not flip an already confirmed/completed
  // plan back to "待确认".
  const session = payload?.session || payload || {};
  const hasWorkflowInfo = Boolean(
    payload?.workflow || session.workflow || payload?.phase || session.phase || payload?.plan_state || session.plan
  );
  if (!hasWorkflowInfo) return workflow;
  const phase = workflow.phase;
  const planApproved = workflow.planStatus === "approved";
  // An approved plan whose revision already executed is DONE: this session's
  // plan must not bounce back to "待确认" after a reload, a restore, or when
  // the run ends in needs_validation (results just need a human check, not a
  // fresh approval).  The confirmation and progress are both persisted in the
  // snapshot, so the UI only has to reflect them.
  const executedThisRevision = planApproved && workflow.lastRunPlanVersion === workflow.planRevision;
  const planBacked = workflow.route === "plan" || planApproved;
  if (phase === "executing") state.planState = "executing";
  else if (["intake", "clarifying", "planning", "awaiting_approval", "replanning"].includes(phase)) state.planState = "draft";
  else if (executedThisRevision || (phase === "completed" && planBacked)) state.planState = "complete";
  else if (planApproved) state.planState = "confirmed";
  else if (["failed", "error", "blocked"].includes(phase)) state.planState = "draft";
  renderPlan();
  updatePlanBadge();
  renderClarificationView();
  if (options.open !== false && ["clarifying", "planning", "awaiting_approval", "replanning"].includes(phase)) {
    openPlanModal();
  }
  return workflow;
}
// Robust "plan arrived" surface.  A workflow_result carries the final phase
// plus the produced plan inside its session snapshot.  Sync it, then pop the
// plan dialog — deliberately permissive on phase so a single bad source field
// cannot swallow the popup.
function surfacePlanFromResult(event, trigger = null) {
  if (!event) return false;
  const session = event?.session || {};
  const workflow = event?.workflow || session.workflow || {};
  const phaseCandidates = [String(workflow.phase || ""), String(session.phase || ""), String(event?.result?.status || "")];
  const plan = extractPlan(event);
  const planPhase = phaseCandidates.find((value) => ["awaiting_approval", "planning", "replanning"].includes(value));
  const hasPlanGeneratedEvent = (event?.events || event?.result?.events || []).some((item) => item?.type === "plan_generated");
  // Only surface the plan review when the payload already reports an
  // approval-ready phase or a plan_generated event proves a real plan exists.
  // A clarifying round's default plan stub must never force this view.
  const phase = planPhase || (hasPlanGeneratedEvent ? "awaiting_approval" : (phaseCandidates.find(Boolean) || ""));
  if (["awaiting_approval", "planning", "clarifying", "replanning", "intake"].includes(phase)) {
    // Only adopt the payload plan on a genuine plan-ready phase; a clarifying
    // round still carries the default stub which must not overwrite state.plan.
    if (plan && ["awaiting_approval", "planning", "replanning"].includes(phase)) state.plan = plan;
    state.workflow = { ...(state.workflow || {}), ...(workflow || {}), phase, nextAction: "" };
    renderPlan();
    renderPlanWorkflowModal();
    updatePlanBadge();
    openPlanModal(trigger);
    return true;
  }
  return false;
}

// Guaranteed "plan arrived" surface, mirroring how loadClarificationEvent pops
// the dialog for the questions.  Called from every stream point the moment a
// workflow_result carrying an approved-plan phase streams in, so the finished
// plan opens the modal just like a question batch does — regardless of which
// socket path produced it or any later failure in the turn tail.
function loadPlanEvent(event, trigger = null) {
  if (!event) return false;
  const session = event?.session || {};
  const workflow = event?.workflow || session.workflow || {};
  const phaseCandidates = [String(workflow.phase || ""), String(session.phase || ""), String(event?.result?.status || "")];
  const plan = extractPlan(event);
  const planPhase = phaseCandidates.find((value) => ["awaiting_approval", "planning", "replanning"].includes(value));
  const hasPlanGeneratedEvent = (event?.events || event?.result?.events || []).some((item) => item?.type === "plan_generated");
  // A carried turn may expose an older clarifying phase in `workflow` while
  // the session snapshot/events prove a real plan was generated.  Promote only
  // then; a plain clarifying round with its default stub must keep Q&A active.
  const phase = planPhase || (hasPlanGeneratedEvent ? "awaiting_approval" : (phaseCandidates.find(Boolean) || ""));
  if (!["awaiting_approval", "planning", "replanning"].includes(phase)) return false;
  if (plan && ["awaiting_approval", "planning", "replanning"].includes(phase)) state.plan = plan;
  state.workflow = { ...(state.workflow || {}), ...(workflow || {}), phase, nextAction: "" };
  // A finished plan brings the 执行计划 view forward (before rendering).
  state.planViewTab = "plan";
  renderPlan();
  renderPlanWorkflowModal();
  updatePlanBadge();
  if ($("planModal")) openPlanModal(trigger);
  return true;
}

// Shared live-event handler: a fresh clarification round (during intake,
// plan revision, or execution) must load its questions into the dialog and
// bring the dialog to the front so the user answers in place instead of
// typing into the chat box.
function loadClarificationEvent(event) {
  const questions = event.questions || [];
  const allQuestions = event.all_questions?.length ? event.all_questions : questions;
  if (!allQuestions.length) return false;
  const previousAnswers = state.workflow?.answers || {};
  const eventAnswers = event.answers || {};
  // Completed rounds from the backend event (round 1, round 2, ...), shown as
  // read-only history above the interactive current round.
  const roundHistory = Array.isArray(event.rounds) ? event.rounds : (state.workflow?.rounds || []);
  state.workflow = {
    ...(state.workflow || {}),
    phase: "clarifying",
    questions: allQuestions.map((question) => ({
      id: String(question.id || uid()),
      text: String(question.text || question.question || ""),
      required: question.required !== false,
      answered: Boolean(question.answered || question.answer || eventAnswers[question.id] || previousAnswers[question.id]),
      answer: String(question.answer || eventAnswers[question.id] || previousAnswers[question.id] || ""),
      choices: Array.isArray(question.choices) ? question.choices : [],
    })).filter((question) => question.text),
    rounds: roundHistory.map((entry, index) => ({
      round: index + 1,
      questions: (Array.isArray(entry?.questions) ? entry.questions : []).map((question) => ({
        id: String(question.id || uid()),
        text: String(question.text || question.question || ""),
        required: question.required !== false,
        answered: true,
        answer: String(entry?.answers?.[question.id] || question.answer || ""),
        choices: Array.isArray(question.choices) ? question.choices : [],
      })).filter((question) => question.text && question.answer),
    })),
    answers: { ...previousAnswers, ...eventAnswers },
    clarificationRound: Number(event.round ?? state.workflow?.clarificationRound ?? 0),
  };
  // A fresh question round brings the 需求问答 view forward again.
  state.planViewTab = "clarify";
  renderClarificationView();
  renderPlanWorkflowModal();
  openPlanModal();
  return true;
}
function renderClarificationView() {
  const container = $("clarificationQuestions");
  if (!container) return;
  const workflow = state.workflow || {};
  const answers = workflow.answers || {};
  container.replaceChildren();
  // Earlier rounds appear as compact read-only history so round 1 / round 2 …
  // stay visible and clearly separated from the interactive current round.
  (workflow.rounds || []).forEach((round) => {
    const group = document.createElement("div");
    group.className = "clarification-round";
    const label = document.createElement("div");
    label.className = "clarification-round-label";
    label.textContent = `第 ${round.round} 轮（已记录）`;
    group.append(label);
    round.questions.forEach((question, index) => {
      const item = document.createElement("div");
      item.className = "clarification-question clarification-history-item";
      const number = document.createElement("span");
      number.className = "clarification-question-number";
      number.textContent = "✓";
      const body = document.createElement("div");
      const text = document.createElement("div");
      text.className = "clarification-question-text";
      text.textContent = question.text;
      const record = document.createElement("div");
      record.className = "clarification-question-answer";
      record.textContent = `已答：${question.answer}`;
      body.append(text, record);
      item.append(number, body);
      group.append(item);
    });
    container.append(group);
  });
  const current = workflow.questions || [];
  if (current.length) {
    const currentLabel = document.createElement("div");
    currentLabel.className = "clarification-round-label current";
    currentLabel.textContent = `第 ${(workflow.rounds?.length || 0) + 1} 轮（当前）`;
    container.append(currentLabel);
  }
  current.forEach((question, index) => {
    const answered = Boolean(question.answered || answers[question.id]);
    const card = document.createElement("div");
    card.className = `clarification-question${answered ? " is-answered" : ""}`;
    const number = document.createElement("span");
    number.className = "clarification-question-number";
    number.textContent = answered ? "✓" : String(index + 1);
    const body = document.createElement("div");
    const text = document.createElement("div");
    text.className = "clarification-question-text";
    text.textContent = question.text;
    const meta = document.createElement("div");
    meta.className = "clarification-question-meta";
    meta.textContent = answered ? `已记录：${answers[question.id] || question.answer}` : (question.required ? "需要确认" : "可选偏好");
    body.append(text, meta);

    // Each question is a pill-style option group with an automatic "其他"
    // free-text input, matching the natural chat-first elicitation flow.
    const options = document.createElement("div");
    options.className = "clarification-options";
    options.setAttribute("role", "radiogroup");
    options.setAttribute("aria-label", `回答：${question.text}`);
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.className = "clarification-selected";
    hidden.dataset.questionId = question.id;
    const otherWrap = document.createElement("div");
    otherWrap.className = "clarification-other";
    otherWrap.hidden = true;
    const custom = document.createElement("input");
    custom.className = "clarification-inline-answer clarification-custom-answer";
    custom.dataset.questionId = question.id;
    custom.placeholder = "请填写你的答案";
    custom.setAttribute("aria-label", `回答：${question.text}（其他）`);
    otherWrap.append(custom);
    const selectOption = (value) => {
      options.querySelectorAll(".clarification-option").forEach((button) => {
        const active = button.dataset.value === value;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-checked", String(active));
      });
      const isOther = value === "__other__";
      hidden.value = isOther ? "" : String(value || "");
      otherWrap.hidden = !isOther;
      card.classList.toggle("is-answered", Boolean(isOther || value));
      if (isOther) {
        custom.value = "";
        custom.focus();
      }
    };
    const existing = String(answers[question.id] || question.answer || "");
    const choices = [...(question.choices && question.choices.length ? question.choices : [{ value: "是", label: "是" }, { value: "否", label: "否" }])];
    const normalizedChoices = choices.map((choice) => ({ value: String(choice.value ?? choice), label: String(choice.label ?? choice.value ?? choice) }));
    const matchedChoice = normalizedChoices.find((choice) => choice.value === existing);
    const showOther = Boolean(existing) && !matchedChoice;
    normalizedChoices.forEach((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clarification-option";
      button.dataset.value = choice.value;
      button.textContent = choice.label;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(choice.value === existing));
      button.addEventListener("click", () => selectOption(choice.value));
      options.append(button);
    });
    const otherButton = document.createElement("button");
    otherButton.type = "button";
    otherButton.className = "clarification-option clarification-option-other";
    otherButton.dataset.value = "__other__";
    otherButton.textContent = "其他…";
    otherButton.setAttribute("role", "radio");
    otherButton.setAttribute("aria-checked", String(showOther));
    otherButton.addEventListener("click", () => selectOption("__other__"));
    options.append(otherButton);
    if (matchedChoice) selectOption(matchedChoice.value);
    if (showOther) {
      selectOption("__other__");
      custom.value = existing;
    }
    body.append(options, otherWrap, hidden);
    card.append(number, body);
    if (state.planRequestPending) card.querySelectorAll("button, input, textarea").forEach((el) => { el.disabled = true; });
    container.append(card);
  });
  const answerInput = $("clarificationAnswerInput");
  if (answerInput) answerInput.value = String(workflow.answers?._freeform || "");
}
function renderPlanViewTabs() {
  const tabbar = $("planViewTabs");
  if (!tabbar) return;
  const clarifyTab = $("clarificationTabButton");
  const planTab = $("planReviewTabButton");
  const hasPlan = hasGeneratedPlan();
  const active = state.planViewTab === "plan" && hasPlan ? "plan" : "clarify";
  if (clarifyTab) {
    clarifyTab.classList.toggle("active", active === "clarify");
    clarifyTab.setAttribute("aria-selected", String(active === "clarify"));
  }
  if (planTab) {
    planTab.classList.toggle("active", active === "plan");
    planTab.setAttribute("aria-selected", String(active === "plan"));
  }
  // While executing/compressing the whole dialog is frozen: hide the tabs so
  // the user cannot jump back to answering mid-run.
  tabbar.hidden = ["executing", "compressing"].includes(state.planState);
  if (planTab) planTab.disabled = !hasPlan;
}
function hasGeneratedPlan() {
  const wf = state.workflow || {};
  return ["awaiting_approval", "planning", "replanning", "executing", "complete"].includes(wf.phase)
    || wf.planStatus === "approved"
    || state.planState === "confirmed"
    || state.planState === "complete";
}
// Switch the plan dialog between 需求问答 and 执行计划 at any time (including
// across rounds).  "返回问答改答案 → 重新生成计划" and "已生成计划跳回计划视图"
// both go through here; the plan is frozen while it is running.
function switchPlanView(tab, trigger = null) {
  const view = tab === "plan" ? "plan" : "clarify";
  if (view === "plan" && !hasGeneratedPlan()) {
    notify("计划尚未生成，请先在“需求问答”完善信息后再查看计划。");
    return;
  }
  state.planViewTab = view;
  renderPlanViewTabs();
  renderPlanWorkflowModal();
  renderClarificationView();
  const modal = $("planModal");
  if (modal) {
    if (modal.hidden) openPlanModal(trigger);
    setTimeout(() => {
      if (view === "clarify") $("clarificationAnswerInput")?.focus();
      else $("replanFeedbackInput")?.focus?.();
    }, 0);
  }
}
function renderPlanWorkflowModal() {
  const modal = $("planModal");
  const card = modal?.querySelector(".plan-modal-card");
  const clarify = $("planClarificationView");
  const review = $("planReviewView");
  if (!modal || !card || !clarify || !review) return;
  const phase = state.workflow?.phase || "awaiting_approval";
  const hasPlan = hasGeneratedPlan();
  // Resolve which sub-view to show: an explicit user choice wins, otherwise
  // fall back to the phase (Q&A while clarifying, plan once a plan exists).
  let isClarifying;
  if (state.planViewTab === "plan" && hasPlan) isClarifying = false;
  else if (state.planViewTab === "plan") isClarifying = true; // plan not ready yet
  else if (state.planViewTab === "clarify") isClarifying = true;
  else isClarifying = phase === "clarifying" || phase === "intake";
  clarify.hidden = !isClarifying;
  review.hidden = isClarifying;
  card.setAttribute("aria-busy", String(Boolean(state.planRequestPending)));
  const replanButton = $("submitReplanButton");
  if (replanButton) {
    replanButton.disabled = Boolean(state.planRequestPending);
    replanButton.setAttribute("aria-busy", String(Boolean(state.planRequestPending)));
  }
  const title = $("planModalTitle");
  const copy = $("planModalCopy");
  const eyebrow = $("planModalEyebrow");
  const status = $("planWorkflowStatus");
  if (isClarifying) {
    if (eyebrow) eyebrow.textContent = "CLARIFICATION";
    if (title) title.textContent = "先把需求说清楚";
    if (copy) copy.textContent = "回答下面的问题后，我会生成一份可编辑、可验证的执行计划。";
    if (status) status.textContent = `第 ${(state.workflow?.rounds?.length || 0) + 1} 轮 · 已记录 ${Object.keys(state.workflow?.answers || {}).length} 项`;
  } else if (state.planState === "complete") {
    // Plan was already confirmed AND executed; this state is persisted in the
    // session snapshot, so show it as done instead of asking to confirm again.
    if (eyebrow) eyebrow.textContent = "PLAN DONE";
    if (title) title.textContent = "计划已确认并执行";
    if (copy) copy.textContent = "确认结果与每步执行进度均已保存。继续对话即可发起新任务或修订。";
    if (status) status.textContent = `版本 v${state.workflow?.planRevision || 1} · ${state.plan.length} 个步骤已记录`;
  } else {
    if (eyebrow) eyebrow.textContent = "PLAN REVIEW";
    if (title) title.textContent = "确认执行计划";
    if (copy) copy.textContent = "你可以编辑、删除或新增步骤；点击“重新规划”后才会生成下一版。";
    if (status) status.textContent = `版本 v${state.workflow?.planRevision || 1} · ${state.plan.length} 个步骤`;
  }
  // A clarification/plan turn is in flight: surface the wait instead of
  // leaving a disabled-looking dialog with no explanation ("卡住").
  const busy = Boolean(state.planRequestPending);
  card.classList.toggle("is-busy", busy);
  if (busy) {
    if (status) {
      status.textContent = phase === "awaiting_approval" || phase === "planning"
        ? "正在生成执行计划，请稍候…"
        : "正在根据你的回答分析需求，请稍候…";
    }
    $("submitClarificationButton")?.setAttribute("disabled", "");
    $("clarificationAnswerInput")?.setAttribute("disabled", "");
  } else {
    $("submitClarificationButton")?.removeAttribute("disabled");
    $("clarificationAnswerInput")?.removeAttribute("disabled");
  }
  renderPlanViewTabs();
}
async function sendMessage() {
  if (state.activeRequestController) { await stopGeneration(); return; }
  const input = $("messageInput");
  const message = input.value.trim();
  if (!message) return;
  // Provider credentials are required for model-backed requests.  A key that
  // was saved to the backend stays there across reloads, so only block when
  // neither this tab nor the backend has one.
  // Provider credentials are always resolved server-side: the backend reads
  // the key from its own .env / account settings, so a missing frontend key
  // (fresh reload, another browser, or after logout/re-login) must never block
  // or prompt.  The frontend never holds, asks for, or renders the secret.
  // When neither the tab nor the backend holds a key at all, guide the user to
  // configure one; otherwise the request would silently run the offline demo.
  // Re-check with the backend first: after a fresh login the settings load may
  // still be in flight, and a .env-configured key must never be treated as
  // missing just because the async bootstrap has not finished yet.
  if (!state.settings.apiKey) {
    if (!state.apiKeyConfigured) {
      await loadBackendSettings();
      if (!state.apiKeyConfigured) {
        openSettings();
        notify("请先在设置中填写 API Key");
        return;
      }
    }
  }
  const editingOrdinal = state.editingUserOrdinal;
  input.value = "";
  state.lastTask = message;
  if (editingOrdinal !== null) trimConversationFromUserOrdinal(editingOrdinal);
  appendMessage("user", message, undefined, { userOrdinal: editingOrdinal === null ? state.userMessageCount : editingOrdinal });
  state.editingUserOrdinal = null;
  updateComposerContext();
  const thinking = addThinking();
  const controller = new AbortController();
  state.activeRequestController = controller;
  const sendButton = $("sendButton");
  sendButton.disabled = false;
  sendButton.classList.add("is-generating");
  sendButton.setAttribute("aria-label", "停止回答");
  $("sendButtonLabel").textContent = "停止";
  let payload = null;
  let streamed = [];
  try {
    const hadSession = Boolean(state.sessionId);
    // One live assistant bubble backends the whole streamed request.  The
    // initial session creation runs the model's intake + planning analysis,
    // so it must stream just like every later turn instead of hiding behind a
    // silent blocking /api/sessions gap.
    const live = { node: null, bubble: null, text: "" };
    const ensureLive = () => {
      if (live.node) return;
      live.node = appendMessage("assistant", "", "CodePilot · 实时回答");
      live.bubble = live.node.querySelector(".message-bubble");
    };
    streamed = [];
    const streamEvent = async (event) => {
      if (!event) return;
      streamed.push(event);
      if (event.type === "assistant_delta") {
        const piece = String(event.content || event.delta || "");
        // Intake returns structured JSON; never paint that into the live bubble.
        const combined = `${live.text}${piece}`;
        if (event.stage === "intake" && (/^\s*\{/.test(piece) || (/^\s*\{/.test(combined) && /"kind"\s*:/.test(combined)))) {
          return;
        }
        ensureLive();
        live.text += piece;
        live.bubble.innerHTML = formatMessage(live.text);
        scrollConversationToBottom();
      } else if (event.type === "workflow_result" && event.message && !live.text) {
        ensureLive();
        live.text = String(event.message);
        live.bubble.innerHTML = formatMessage(live.text);
        scrollConversationToBottom();
      } else if (event.type === "clarification_requested") {
        ensureLive();
        // Replace any leaked structured payload with the human question list.
        if (/^\s*\{/.test(live.text) && /"kind"\s*:/.test(live.text)) live.text = "";
        const questions = event.questions || [];
        const questionText = questions.length > 0
          ? "请先补充以下信息（可逐项回答）：\n" + questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
          : "需求信息已收集完整，接下来会整理成可执行的计划。";
        if (!live.text.includes(questionText)) live.text = live.text ? `${live.text}\n${questionText}` : questionText;
        live.bubble.innerHTML = formatMessage(live.text);
        scrollConversationToBottom();
      } else if (event.type === "plan_progress") {
        await applyPlanProgress(event);
      }
      // The first workflow_result carries the final phase + produced plan.
      // Pop the plan dialog right as it finishes streaming (like the
      // questions pop), regardless of any later failure in the tail.
      if (event.type === "workflow_result") loadPlanEvent(event);
      if (event.type === "tool_start") addActivity(`调用 ${event.name}`, "模型已发起工具调用", "▶", "running");
      if (event.type === "tool_result") {
          await deferUntilCompressionDone(() => addActivity(`${event.name} 完成`, event.result?.ok === false ? (event.result.error || "执行失败") : "已返回结果", event.result?.ok === false ? "!" : "✓", event.result?.ok === false ? "error" : "success"));
          return;
        }
    };
    await ensureSession(streamEvent);
    if (!state.sessionId) throw new Error("当前未连接可用工作区，请先刷新或重新选择工作区");
    // Session creation already performs local routing.  Do not send the
    // initial task a second time when it entered clarification or review;
    // only direct-execute intake needs a follow-up turn.
    const createdWorkflow = state.sessionCreatePayload ? extractWorkflow(state.sessionCreatePayload) : state.workflow;
    const creationHandled = !hadSession && editingOrdinal === null && state.sessionCreatePayload && createdWorkflow.phase !== "intake";
    if (creationHandled) {
      payload = state.sessionCreatePayload;
    } else {
      const endpoint = editingOrdinal === null ? "turn" : "retry";
      const body = { message, ...(state.settings.apiKey ? { model: $("modelSelect").value, base_url: state.settings.baseUrl, api_key: state.settings.apiKey, wire_api: state.settings.wireApi, reasoning_effort: state.settings.reasoningEffort } : {}) };
      if (editingOrdinal !== null) body.user_ordinal = editingOrdinal;
      await streamSessionWorkflow(endpoint, body, streamEvent, 300000);
      const resultEvent = streamed.filter((event) => event.type === "workflow_result").at(-1);
      payload = resultEvent ? { ...resultEvent, events: streamed } : { ok: !streamed.some((event) => event.type === "error"), events: streamed, result: { status: streamed.some((event) => event.type === "error") ? "error" : "completed", events: streamed } };
    }
    if (live.node && !live.text.trim()) live.node.remove();
    if (state.sessionId) localStorage.setItem("codepilot.sessionId", state.sessionId);
  } catch (error) {
    if (error?.name === "AbortError") {
      // A deliberate stop via the send button (or the cancel endpoint) is
      // not a failure; render a friendly interruption instead of an error.
      // ``workflow_complete`` means the SSE result already arrived and the
      // client closed the hung keep-alive on purpose.
      if (controller.signal.reason === "workflow_complete") {
        const resultEvent = streamed.filter((event) => event.type === "workflow_result").at(-1);
        payload = resultEvent
          ? { ...resultEvent, events: streamed }
          : { ok: true, events: streamed };
      } else {
        payload = { ok: false, cancelled: true };
      }
    } else if (isTransportError(error) && streamHadUsefulProgress(streamed)) {
      // Backend reloads often cut the SSE socket after clarify/plan text was
      // already rendered. Keep that progress instead of wiping the turn.
      const resultEvent = streamed.filter((event) => event.type === "workflow_result").at(-1);
      const errorEvent = streamed.filter((event) => event.type === "error").at(-1);
      payload = resultEvent
        ? { ...resultEvent, events: streamed, stream_interrupted: true, ok: resultEvent.ok !== false }
        : {
            ok: !errorEvent,
            events: streamed,
            stream_interrupted: true,
            message: streamed.filter((event) => event.type === "assistant_delta" || event.type === "assistant" || event.type === "clarification_requested").map((event) => event.content || event.message || "").join(""),
            error: errorEvent?.error,
          };
      notify("实时连接中断，已保留当前回复。若已进入问答/计划，可直接继续。");
    } else {
      const friendly = isTransportError(error) ? describeTransportError(error) : (error?.message || "请求失败");
      payload = { ok: false, error: friendly, network_error: isTransportError(error), events: streamed };
      notify(friendly);
    }
  } finally {
    thinking.remove();
    state.activeRequestController = null;
    sendButton.disabled = false;
    sendButton.classList.remove("is-generating");
    sendButton.removeAttribute("aria-label");
    $("sendButtonLabel").textContent = state.mode === "plan" ? "发送" : "执行";
  }
  if (payload?.cancelled) { appendMessage("assistant", "已停止回答。你可以继续提问，或编辑上一条问题后重新回答。", "CodePilot · 已停止"); return; }
  const workflow = syncWorkflow(payload, { open: false });
  // The backend is authoritative: an underspecified Execute request also
  // enters the same two-stage Plan dialog.  The selected tab is only the
  // user's preference, never a way to bypass clarification/approval.
  if (["clarifying", "planning", "awaiting_approval"].includes(workflow.phase)) setMode("plan", { persist: false });
  // Elicitation questions and the finished plan both surface in the modal;
  // the streamed analysis is the conversation, the modal is the decision point.
  if (workflow.phase === "clarifying" || workflow.phase === "awaiting_approval") openPlanModal();
  const events = payload?.events || payload?.result?.events || [];
  await appendAssistantEvents(events);
  const concrete = events.filter((event) => ["tool_start", "tool_result"].includes(event.type)).map(describeAgentEvent).filter(Boolean);
  if (concrete.length) await appendMessageStream("assistant", concrete.join("\n"), "CodePilot · 工作进度");
  renderRunMetrics(payload);
  events.forEach((event) => {
    if (event.type === "tool_start") addActivity(`调用 ${event.name}`, JSON.stringify(event.arguments || {}), "▶", "running");
    if (event.type === "approval_required") {
      const reason = event.reason || "需要确认：该操作被安全策略拦截";
      addActivity("需要确认", reason, "!", "error");
    }
    if (event.type === "tool_result") {
      const result = event.result || {};
      addActivity(`${event.name} 完成`, result.ok === false ? (result.error || "执行失败") : "已返回结果", result.ok === false ? "!" : "✓", result.ok === false ? "error" : "success");
    }
    if (event.type === "error") addActivity("Agent 错误", event.error || "模型请求失败", "!", "error");
  });
  renderChangeReview(extractChanges(events));
  if (events.some((event) => event.type === "tool_result" && ["write_file", "delete_file", "apply_patch", "make_directory"].includes(event.name))) refreshWorkspaceTree();
  const assistant = extractAssistant(payload);
  // Transport drops are not credential problems; only open settings for
  // genuine model/auth configuration failures.
  if (payload?.error && !payload?.network_error && !payload?.stream_interrupted) {
    openSettings();
    notify("模型连接失败，请检查设置中的 Base URL、协议和 API Key", 5000);
  }
  if (payload?.ok === false || (!payload && state.settings.apiKey)) {
    await appendMessageStream("assistant", `Agent 执行失败：${payload?.error || "无法连接模型服务，请检查 Base URL、协议和 API Key"}`, "CodePilot · 请求错误");
  } else if (payload?.stream_interrupted) {
    addActivity("连接中断", "已保留当前流式回复，可继续问答或重试", "!", "error");
  } else if (!events.some((event) => ["assistant", "assistant_delta", "clarification_requested", "workflow_result", "completed", "halted", "needs_input"].includes(event?.type) && String(event.content || event.message || "").trim())) {
    await appendMessageStream("assistant", assistant || mockReply(message));
  }
  // Only reveal the plan dialog after the assistant text has finished typing.
  syncWorkflow(payload, { open: true });
  addActivity("收到新任务", message.length > 58 ? `${message.slice(0, 58)}…` : message, "✦", "normal");
}
async function stopGeneration() {
  const controller = state.activeRequestController;
  if (!controller) return;
  controller.abort("user");
  if (state.sessionId) {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/cancel`, { method: "POST", body: JSON.stringify({}), quiet: true, timeout: 10000 });
  }
  notify("已请求停止回答");
}
// ---------------------------------------------------------------
// Context compaction UI (confirm-plan -> execute seam)
// ---------------------------------------------------------------
function clearCompactionState() {
  state.lastCompaction = null;
  const a = state.compactionAnimation;
  if (a.finalizeTimer) clearTimeout(a.finalizeTimer);
  if (a.el && a.el.isConnected) a.el.remove();
  Object.assign(a, { el: null, startedAt: 0, data: null, finishing: false, finalizeTimer: null });
  const btn = $("openCompactionButton");
  if (btn) { btn.hidden = true; btn.classList.remove("compaction-pop"); }
}

// Live bubble played once the backend emits compaction_started.  It shows the
// "正在压缩" cue + an indeterminate progress bar, so the teacher can see the
// context-pressure step happening at the seam.
function showCompactionBubble(data) {
  const a = state.compactionAnimation;
  if (a.el && a.el.isConnected) { a.data = data || a.data; return; }
  a.data = data || {};
  a.startedAt = Date.now();
  const node = appendMessage("assistant", "", "CodePilot · 上下文压缩");
  node.classList.add("compaction-live");
  const bubble = node.querySelector(".message-bubble");
  bubble.classList.add("compaction-bubble");
  bubble.innerHTML = `<span class="compaction-spinner" aria-hidden="true"></span>
    <span class="compaction-label">正在对前面的问答与计划做上下文压缩…</span>
    <div class="compaction-progress" aria-hidden="true"><span class="compaction-progress-track"><span class="compaction-progress-fill"></span></span></div>`;
  a.el = node;
  a.finishing = false;
  scrollConversationToBottom();
}

// compaction_done (or workflow_result carrying a compaction checkpoint):
// let the animation breathe for a minimum perceptible duration, then replace
// it with the "查看压缩" toolbar button + pop animation.
function finishCompactionBubble(compaction, onDone = null) {
  const a = state.compactionAnimation;
  const complete = () => { if (typeof onDone === "function") onDone(); };
  if (a.finishing) { complete(); return; }
  a.finishing = true;
  a.data = compaction || a.data || {};
  const elapsed = Date.now() - (a.startedAt || Date.now());
  const remaining = Math.max(0, a.minVisible - elapsed);
  a.finalizeTimer = setTimeout(() => {
    if (a.el && a.el.isConnected) a.el.remove();
    a.el = null;
    a.finishing = false;
    const checkpoint = compaction && compaction.summary ? compaction : (compaction || null);
    if (checkpoint && checkpoint.summary) {
      state.lastCompaction = checkpoint;
      showCompactionButton();
    }
    complete();
  }, remaining);
}

// Finalize any still-running compression animation when the run stream ends
// without having confirmed a checkpoint (defensive / offline path).
function finalizeCompactionFallback() {
  const a = state.compactionAnimation;
  if (!a.el || !a.el.isConnected || a.finishing) return;
  a.el.remove();
  a.el = null;
}

function showCompactionButton() {
  const btn = $("openCompactionButton");
  if (!btn) return;
  btn.hidden = false;
  // Re-trigger the pop animation if it is already capped (allowed via offsetWidth).
  btn.classList.remove("compaction-pop");
  void btn.offsetWidth;
  btn.classList.add("compaction-pop");
}

function renderCompactionDigest(digest = {}) {
  const wrap = $("compactionDigest");
  if (!wrap) return;
  const total = (v) => Number(v) || 0;
  const chips = [
    { label: "消息数量", value: `${total(digest.messages_before)} → ${total(digest.messages_after)}` },
    { label: "上下文占用", value: `${total(digest.chars_before)} → ${total(digest.chars_after)} 字符` },
    { label: "缩减", value: `-${total(digest.reduced_chars)} 字符` },
    { label: "问答轮数", value: `${total(digest.clarification_rounds)} 轮` },
    { label: "已回答问题", value: `${total(digest.questions_answered)} 项` },
    { label: "计划修订", value: `${total(digest.plan_revisions)} 次` },
  ];
  wrap.replaceChildren();
  chips.forEach((chip) => {
    const item = document.createElement("div");
    item.className = "compaction-digest-chip";
    const label = document.createElement("span"); label.className = "compaction-digest-label"; label.textContent = chip.label;
    const value = document.createElement("strong"); value.className = "compaction-digest-value"; value.textContent = chip.value;
    item.append(label, value);
    wrap.append(item);
  });
}

function openCompactionModal() {
  const modal = $("compactionModal");
  if (!modal) return;
  closeOtherModals("compactionModal");
  const c = state.lastCompaction;
  if (!c || !c.summary) { notify("暂无上下文压缩内容"); return; }
  if (typeof renderPlanWorkflowModal === "function") renderPlanWorkflowModal();
  renderCompactionDigest(c.digest);
  $("compactionModalCopy").textContent = c.model_summarized
    ? "确认计划后，问答与计划内容已交由模型生成为执行交接摘要（压缩检查点）。"
    : "确认计划后，问答与计划内容已压缩为一份结构化的执行交接摘要。";
  const body = $("compactionBody");
  if (body) body.innerHTML = formatMessage(c.summary);
  modal.hidden = false;
  syncModalBodyLock();
}

function closeCompactionModal() {
  const modal = $("compactionModal");
  if (modal) { modal.hidden = true; syncModalBodyLock(); }
}
async function approvePlan() {
  if (!state.plan.length || state.planRequestPending) return;
  await ensureSession();
  if (!state.sessionId) { notify("请先连接本地后端再确认计划"); return; }
  // Detect a resume BEFORE any step status is mutated.  A plan with partial
  // progress must continue from the first undone step; a fresh confirm starts
  // from step 1.
  const resuming = isResumablePlanSession();
  const firstUndone = resuming ? state.plan.findIndex((item) => item.status !== "done") : 0;
  state.planRequestPending = true;
  state.planState = "executing";
  state.plan.forEach((item, index) => {
    // Keep the already-completed steps lit on a resume; only re-arm the first
    // undone step as current and clear the rest so execution continues from
    // where it stopped instead of restarting the whole plan.
    item.status = item.status === "done" && resuming ? "done" : (index === firstUndone ? "current" : "todo");
  });
  renderPlan(); updatePlanBadge();
  const thinking = addThinking();
  let approval = null;
  let runPayload = null;
  let cancelledByUser = false;
  try {
    approval = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/plan/approve`, {
      method: "POST",
      body: JSON.stringify({
        plan: state.plan.map(({ id, text, description }) => ({ id, title: String(text || "").trim(), description: description || "" })),
        expected_plan_version: state.workflow?.planRevision || 1,
      }),
      timeout: 30000,
    });
    if (approval?.ok !== false) {
      syncWorkflow(approval, { open: false });
      // Approval commits the workflow transition immediately. Switch the
      // visible mode before opening the long-running stream so the toolbar
      // reflects execution even while the first model delta is in flight.
      setMode("execute", { persist: false });
      // Confirming the plan is a deliberate hand-off to execution: drop the
      // modal and bring the conversation forward so the user watches the live
      // coding bubble instead of a static approval card. The executing plan is
      // re-opened below the instant the run actually starts producing steps.
      if (state.planViewTab === "plan") {
        closePlanModal();
        scrollConversationToBottom();
      }
      // Gate the step list while the compression animation is on screen: the
      // original plan is now frozen until this run completes.  A resumed run
      // skips the compression seam and re-uses the current executing start.
      state.planState = resuming ? "executing" : "compressing";
      renderPlan(); updatePlanBadge();
      // Approval is a real state transition. Immediately ask the backend to
      // run the bounded model/tool loop; the UI animation is only used when
      // the backend is unavailable (offline browser demo).
      const streamed = [];
      let liveNode = null;
      let liveBubble = null;
      let liveText = "";
      let compactionFinished = false;
      let deferredPlanEvents = [];
      let runModalReopened = false;
      // Drain deferred plan/tool painting sequentially so each held
      // plan_progress handler gets its own requestAnimationFrame slice.  A
      // synchronous ``for (queued of queue) queued()`` fires them all in one
      // frame, which skips the 1/12 → 2/12 → … animation and jumps straight
      // to the last painted step ("直接完成").
      const drainDeferred = async () => {
        const queue = deferredPlanEvents; deferredPlanEvents = [];
        for (const queued of queue) await queued();
        ensureLive();
      };
      const ensureLive = () => {
        if (liveNode && liveBubble) return;
        liveNode = appendMessage("assistant", "", "CodePilot · 实时编写");
        liveBubble = liveNode.querySelector(".message-bubble");
        if (liveText) liveBubble.innerHTML = formatMessage(liveText);
      };
      await streamSessionWorkflow("run", { ...modelRequestFields(), max_steps: 24 }, async (event) => {
        streamed.push(event);
        if (event.type === "workflow_started") addActivity("流式工作流已启动", event.provider === "provider" ? `真实模型：${event.model}` : "离线 DemoModel（非真实模型）", event.provider === "provider" ? "✓" : "!", event.provider === "provider" ? "success" : "error");
        // Context compression runs at the confirm->execute seam and must fully
        // settle before any execution Q&A or tool activity is shown.
        if (event.type === "compaction_started") { showCompactionBubble(event); return; }
        if (event.type === "compaction_done") {
          // Transfer the "executing" green light only once the compression
          // animation has actually finished on screen, so execution Q&A / step
          // painting never overlaps with the compression cue.
          finishCompactionBubble(event.compaction || event, () => {
            compactionFinished = true;
            if (state.planState === "compressing") { state.planState = "executing"; renderPlan(); updatePlanBadge(); }
            drainDeferred();
          });
          return;
        }
        const deferUntilCompressionDone = (run) => {
          // Defer execution Q&A / tool painting only while compression is the
          // current visible phase, so the animation finishes first.  Resumed
          // runs start in "executing" (no new compaction) and are never held.
          if (compactionFinished || state.planState !== "compressing") return run();
          deferredPlanEvents.push(run);
          return Promise.resolve();
        };
        if (event.type === "assistant_delta") {
          await deferUntilCompressionDone(async () => {
            ensureLive();
            liveText += event.content || event.delta || "";
            liveBubble.innerHTML = formatMessage(liveText);
            scrollConversationToBottom();
          });
          return;
        }
        if (event.type === "clarification_requested") {
          await deferUntilCompressionDone(async () => {
            ensureLive();
            const questions = event.questions || [];
            const questionText = questions.length > 0
              ? "请先补充以下信息（可逐项回答）：\n" + questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
              : "需求信息已收集完整，接下来会整理成可执行的计划。";
            liveText += questionText;
            liveBubble.innerHTML = formatMessage(liveText);
            scrollConversationToBottom();
            loadClarificationEvent(event);
          });
          return;
        }
        // Each plan_progress handler yields through requestAnimationFrame so
        // the side-by-side step cards paint 1/N, 2/N, ... as the tools finish.
        if (event.type === "plan_progress") {
          await deferUntilCompressionDone(async () => {
            ensureLive();
            // Execution has genuinely begun: bring the executing plan back up
            // (it was closed on confirmation) so the user watches the step
            // cards animate 1/12 → 2/12 → … in place.
            if (!runModalReopened && state.planState === "executing") {
              runModalReopened = true;
              state.planViewTab = "plan";
              if ($("planModal")) openPlanModal();
            }
            await applyPlanProgress(event);
            const total = Number(event.total) || state.plan.length;
            const stepIndex = event.complete ? -1 : Math.max(0, Number(event.index) || 0);
            if (!event.complete && state.plan[stepIndex]) {
              const cue = `▶ 正在执行第 ${stepIndex + 1}/${total} 步：${state.plan[stepIndex].text || state.plan[stepIndex].title || ""}`;
              if (liveBubble && !liveText.endsWith(cue)) {
                liveText += (liveText ? "\n" : "") + cue;
                liveBubble.innerHTML = formatMessage(liveText);
                scrollConversationToBottom();
              }
            }
          });
          return;
        }
        if (event.type === "tool_start") { await deferUntilCompressionDone(() => addActivity(`调用 ${event.name}`, "模型已发起工具调用", "▶", "running")); return; }
        if (event.type === "tool_result") {
          await deferUntilCompressionDone(() => addActivity(`${event.name} 完成`, event.result?.ok === false ? (event.result.error || "执行失败") : "已返回结果", event.result?.ok === false ? "!" : "✓", event.result?.ok === false ? "error" : "success"));
          return;
        }
        // A compressed plan already has a persisted context_compaction on the
        // resumed session snapshot.  Show the view button without replaying the
        // live animation (already persisted from the previous run).
        if (event.type === "workflow_result") {
          const snapshot = event.session || {};
          // workflow_result is the terminal frame of the run: the model has
          // already produced its final answer (completed, needs_validation, or
          // a max_steps halt).  Guarantee the step animation reaches the end
          // here — a summary reply that stops mid-plan is a pass/fail gap, not
          // a "continue from step N" state.  (User cancellation exits earlier
          // through the AbortError branch and never reaches this event, so
          // that resumable partial state stays intact.)
          const terminalStatus = String(event?.result?.status || snapshot?.status || "");
          if (terminalStatus !== "cancelled") {
            state.plan.forEach((item) => { item.status = "done"; });
            state.planState = terminalStatus === "completed" || terminalStatus === "success"
              ? "complete"
              : terminalStatus === "failed" || terminalStatus === "error"
                ? "draft"
                : "complete";
            renderPlan();
            updatePlanBadge();
          }
          const checkpoint = event.compaction || snapshot?.context_compaction;
          if (checkpoint && checkpoint.summary) {
            if (checkpoint.summary === state.lastCompaction?.summary) { /* already visible */ }
            else if (!state.lastCompaction?.summary) finishCompactionBubble(checkpoint);
          }
          // Failsafe: if the compaction "done" event was never seen (resumed or
          // interrupted run), flush deferred execution painting now so the step
          // cards still update instead of waiting forever.
          if (deferredPlanEvents.length) {
            compactionFinished = true;
            if (state.planState === "compressing") { state.planState = "executing"; renderPlan(); updatePlanBadge(); }
            drainDeferred();
          }
          return;
        }
      });
      runPayload = { ok: !streamed.some((event) => event.type === "error"), events: streamed, result: { status: streamed.some((event) => event.type === "error") ? "error" : "completed", events: streamed } };
    }
  } catch (error) {
    if (error?.name === "AbortError" || isTransportError(error)) {
      // The user stopped the run (or the SSE connection dropped mid-run).  The
      // approved plan is intact and just needs continuation, so surface it as
      // a resumable state instead of a failure.
      cancelledByUser = true;
      runPayload = null;
      state.planState = "confirmed";
      if (state.workflow) state.workflow.phase = "cancelled";
      state.plan.forEach((item) => { item.status = "todo"; });
    } else {
      throw error;
    }
  } finally {
    state.planRequestPending = false;
    updatePlanBadge();
    renderPlanWorkflowModal();
  }
  thinking.remove();
  if (cancelledByUser) {
    // Drop a compression animation that was still running when we stopped.
    const compressionAnim = state.compactionAnimation;
    if (compressionAnim?.el && compressionAnim.el.isConnected) { compressionAnim.el.remove(); compressionAnim.el = null; compressionAnim.finishing = false; }
    renderPlan();
    updatePlanBadge();
    appendMessage("assistant", "已停止执行。计划已保留，可随时点击“继续执行”接着跑。", "CodePilot · 执行中断");
    addActivity("已停止执行", "计划已保留，可点击“继续执行”", "⏸", "normal");
    notify("已停止执行，可点击“继续执行”");
    return;
  }
  if (!approval || approval.ok === false) {
    state.planState = "draft";
    state.plan.forEach((item) => { item.status = "todo"; });
    renderPlan(); updatePlanBadge();
    appendMessage("assistant", "计划暂未确认：" + (approval.error || "后端返回了错误"), "CodePilot · 计划审批");
    if (approval?.details?.error_code === "stale_plan" && approval.details.workflow) {
      syncWorkflow({ ...approval, workflow: approval.details.workflow, plan: approval.details.plan || approval.plan }, { open: true });
    }
    notify(approval?.details?.error_code === "stale_plan" ? "计划版本已更新，请检查最新版本" : "计划审批失败，请检查后端连接");
    return;
  }
  if (!runPayload || runPayload.ok === false) {
    const error = runPayload?.error || "后端未返回执行结果，请检查 API Key、模型配置和服务日志。";
    appendMessage("assistant", `计划已确认，但执行未开始：${error}`, "CodePilot · 执行错误");
    addActivity("执行未开始", error, "!", "error");
    notify(error, 5000);
    state.planState = "draft";
    state.plan.forEach((item) => { item.status = "todo"; });
    renderPlan(); updatePlanBadge();
    return;
  }
  const result = runPayload?.result || null;
  const completed = result?.status === "completed" || runPayload?.session?.status === "completed";
  const offline = !state.sessionId;
  const runUnavailable = Boolean(state.sessionId && !runPayload);
  // needs_validation/max_steps and network failures are not success.
  const failed = runUnavailable || Boolean(runPayload && (runPayload.ok === false || !completed));
  const runEvents = runPayload?.events || result?.events || [];
  await appendAssistantEvents(runEvents);
  const progressEvents = runEvents.filter((event) => event.type === "plan_progress");
  // Real-time painting already happened inside the SSE handler (each
  // progress event awaited a frame).  Only offline/demo runs lack progress
  // events entirely and need a single final paint instead of a fake replay.
  if (!progressEvents.length) {
    // Offline demo runs emit no plan_progress events. Paint the final state
    // once instead of replaying a fake step-by-step animation that drifts
    // from the real tool timeline.
    const completedSteps = runEvents.filter((event) => event.type === "tool_result" && event.result?.ok !== false).length;
    state.plan.forEach((step, index) => { step.status = index < completedSteps ? "done" : "todo"; });
    state.planState = completedSteps >= state.plan.length ? "complete" : "executing";
    renderPlan(); updatePlanBadge();
  }
  if (!runEvents.some((event) => event?.type === "assistant" && String(event.content || "").trim())) {
    appendMessage("assistant", extractAssistant(runPayload) || extractAssistant(approval) || "计划已确认。我会按步骤执行：先检查文件，再进行最小修改，最后运行 smoke test。每个本地操作都会记录在右侧运行记录中。", "CodePilot · 计划已确认");
  }
  addActivity("计划已确认", `${state.plan.length} 个步骤，开始执行`, "✓", "success");
  syncWorkflow(runPayload, { open: false });
  renderRunMetrics(runPayload);
  runEvents.forEach((event) => {
    if (event.type === "tool_start") addActivity(`调用 ${event.name}`, JSON.stringify(event.arguments || {}), "↗", "running");
    if (event.type === "approval_required") {
      const reason = event.reason || "需要确认：该操作被安全策略拦截";
      addActivity("需要确认", reason, "!", "error");
    }
    if (event.type === "tool_result") {
      const detail = event.result?.ok === false ? event.result.error : "已返回结果";
      addActivity(`${event.name} 完成`, detail, event.result?.ok === false ? "!" : "✓", event.result?.ok === false ? "error" : "success");
    }
  });
  renderChangeReview(extractChanges(runEvents));
  if (runEvents.some((event) => event.type === "tool_result" && ["write_file", "delete_file", "apply_patch", "make_directory"].includes(event.name))) await refreshWorkspaceTree();
  closePlanModal();
  setMode("execute", { persist: false });
  const finish = () => {
    // If the run ended without a confirmed compaction checkpoint, stop any
    // still-playing compression animation so the UI never stays stuck.
    finalizeCompactionFallback();
    state.plan.forEach((item) => { item.status = "done"; });
    state.planState = failed ? "draft" : "complete";
    if (failed) state.plan.forEach((item) => { item.status = "todo"; });
    renderPlan(); updatePlanBadge();
    addActivity(failed ? "执行失败" : (offline ? "离线演示完成" : "执行完成"), failed ? "请查看运行记录中的错误" : (offline ? "浏览器演示未执行本地命令；连接后端后可运行 agent" : (completed ? "模型工具循环已结束，可继续运行 smoke test" : "等待 smoke test 验证")), failed ? "!" : "✓", failed ? "error" : "success");
    if (failed) setMode("plan");
    // Surface the executed plan (with completion states) in the modal after
    // the run finishes, so the user sees results in place instead of only in
    // a chat bubble.
    setTimeout(() => { maybeAutoOpenPlanModal(); }, 150);
  };
  if (state.sessionId && runPayload) finish();
  else window.setTimeout(finish, 1000);
}
async function revisePlan() {
  if (state.planRequestPending) return;
  const feedbackInput = $("replanFeedbackInput");
  const feedback = feedbackInput?.value.trim() || "";
  const planPayload = state.plan
    .map(({ id, text, description }) => ({ id, title: String(text || "").trim(), description: description || "" }))
    .filter((step) => step.title);
  // A user may express the entire revision by editing the step list. Prose is
  // optional; only reject a submission when both channels are empty.
  if (!feedback && !planPayload.length) {
    notify("请填写重新规划意见，或至少保留一个计划步骤");
    feedbackInput?.focus();
    return;
  }
  await ensureSession();
  if (!state.sessionId) { notify("请先连接本地后端"); return; }
  state.planRequestPending = true;
  const planTrigger = document.activeElement;
  closePlanModal();
  if (feedback) appendMessage("user", feedback, "你");
  // Stream the regenerated plan into the conversation, then reopen the modal
  // with the new revision once the model finishes.
  const liveNode = appendMessage("assistant", "", "CodePilot · 重新规划");
  const liveBubble = liveNode.querySelector(".message-bubble");
  let liveText = "";
  renderPlanWorkflowModal(); updatePlanBadge();
  try {
    const streamed = [];
    await streamSessionWorkflow("revise", {
      feedback: feedback.trim(),
      plan: planPayload,
      ...modelRequestFields(),
      expected_plan_version: state.workflow?.planRevision || 1,
    }, (event) => {
      streamed.push(event);
      if (event.type === "assistant_delta") {
        liveText += event.content || event.delta || "";
        if (liveBubble) liveBubble.innerHTML = formatMessage(liveText);
        scrollConversationToBottom();
      }
      if (event.type === "clarification_requested") {
        // A revision may prompt for missing facts before it can replan.
        // Surface those questions in the dialog right away.
        const questions = event.questions || [];
        const questionText = questions.length > 0
          ? "\n\n请先补充以下信息（可逐项回答）：\n" + questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
          : "\n\n需求信息已收集完整，接下来会整理成可执行的计划。";
        liveText += questionText;
        if (liveBubble) liveBubble.innerHTML = formatMessage(liveText);
        scrollConversationToBottom();
        loadClarificationEvent(event);
      }
    }, 300000);
    const resultEvent = streamed.filter((event) => event.type === "workflow_result").at(-1);
    const payload = resultEvent
      ? { ...resultEvent, events: streamed }
      : { ok: !streamed.some((event) => event.type === "error"), events: streamed, error: streamed.find((event) => event.type === "error")?.error };
    if (!payload || payload.ok === false) {
      // A stale revision response carries the authoritative latest workflow;
      // render it immediately so the user can reconcile their edits instead
      // of submitting against an invalid version again.
      if (payload?.details?.workflow) syncWorkflow({ ...payload, workflow: payload.details.workflow, plan: payload.details.plan || payload.plan }, { open: true });
      notify(`重新规划失败：${payload?.error || "后端不可用"}`);
      return;
    }
    if (liveNode && !liveText.trim()) liveNode.remove();
    syncWorkflow(payload, { open: false });
    if (feedbackInput) feedbackInput.value = "";
    const summary = extractAssistant(payload) || "计划已按你的意见重新生成，请检查新的步骤。";
    if (!liveText.trim()) {
      await appendMessageStream("assistant", summary, "CodePilot · 重新规划");
    } else if (liveBubble && !liveBubble.textContent.trim()) {
      liveBubble.innerHTML = formatMessage(summary);
    }
    // Bring the plan dialog back with the freshly generated revision loaded.
    openPlanModal(planTrigger);
  } finally {
    state.planRequestPending = false;
    renderPlanWorkflowModal(); updatePlanBadge();
  }
}
function openReplanEditor(trigger = null) {
  openPlanModal(trigger || $("revisePlanButton"));
  renderPlanWorkflowModal();
  const input = $("replanFeedbackInput");
  setTimeout(() => input?.focus(), 0);
}
function submitReplan() {
  return revisePlan();
}
async function runSmokeTest() {
  const status = $("testStatusDot");
  const label = $("testStatusLabel");
  const duration = $("testDuration");
  const button = $("runTestButton");
  const started = performance.now();
  status.className = "test-status running"; label.textContent = "正在运行 smoke test"; duration.textContent = "…"; button.disabled = true;
  let payload = null;
  if (state.connected) payload = await api("/api/commands/run", { method: "POST", body: JSON.stringify({ root: state.workspace, command: $("testCommand")?.textContent || "", cwd: ".", timeout: 120000, confirmed: true }) });
  await new Promise((resolve) => window.setTimeout(resolve, payload ? 80 : 850));
  const elapsed = `${((performance.now() - started) / 1000).toFixed(2)}s`;
  const commandResult = payload?.result || payload;
  const ok = payload ? payload.ok !== false && commandResult?.ok !== false && (commandResult?.exit_code ?? commandResult?.returncode ?? 0) === 0 : true;
  status.className = `test-status ${ok ? "success" : "error"}`; label.textContent = ok ? "smoke test 通过" : "smoke test 失败"; duration.textContent = elapsed; button.disabled = false;
  addActivity(ok ? "测试通过" : "测试失败", `${$("testCommand")?.textContent || "命令"} · ${elapsed}`, ok ? "✓" : "!", ok ? "success" : "error");
  appendMessage("assistant", ok ? `smoke test 已通过（${elapsed}）。如果你愿意，我可以继续检查边界用例。` : `smoke test 返回了失败结果（${elapsed}），我会保留输出并协助定位。`, "CodePilot · 测试结果");
  showActivity();
}
function setMode(mode, options = {}) {
  state.mode = mode;
  // 保存模式到localStorage
  localStorage.setItem("codepilot.mode", mode);
  $("planModeButton").classList.toggle("active", mode === "plan"); $("executeModeButton").classList.toggle("active", mode === "execute");
  $("planModeButton").setAttribute("aria-selected", mode === "plan"); $("executeModeButton").setAttribute("aria-selected", mode === "execute");
  updateComposerContext();
  $("sendButtonLabel").textContent = mode === "plan" ? "发送" : "执行";
  // The stdlib server currently treats mode as a session-creation option;
  // keep this call optional for richer API implementations.
  if (state.sessionId && options.persist !== false) api(`/api/sessions/${encodeURIComponent(state.sessionId)}`, { method: "PATCH", body: JSON.stringify({ mode }), quiet: true }).then((payload) => {
    if (payload?.ok === false) {
      // The backend may refuse execute while a plan is pending. Keep the UI
      // aligned with the enforced workflow rather than suggesting a bypass.
      const current = payload?.details?.workflow?.phase || state.workflow?.phase;
      if (["clarifying", "planning", "awaiting_approval"].includes(current)) setMode("plan", { persist: false });
      notify(payload.error || "当前计划尚未确认");
    } else if (payload) syncWorkflow(payload, { open: false });
  });
}
function showCode() { $("codePanel").classList.remove("hidden"); $("planPanel").classList.remove("hidden"); $("activityPanel").classList.add("hidden"); $("terminalResizer").classList.add("hidden"); $("codeTabButton").classList.add("active"); $("activityTabButton").classList.remove("active"); }
function showActivity() { $("codePanel").classList.remove("hidden"); $("planPanel").classList.add("hidden"); $("activityPanel").classList.remove("hidden"); $("terminalResizer").classList.remove("hidden"); $("codeTabButton").classList.remove("active"); $("activityTabButton").classList.add("active"); const output = $("terminalOutput"); if (output && !output.textContent) output.textContent = `CodePilot local terminal\n${state.workspace || "workspace"}> `; $("terminalInput")?.focus(); }
async function runTerminalCommand(command) {
  const output = $("terminalOutput");
  state.terminalHistory.push(command); state.terminalHistoryIndex = state.terminalHistory.length;
  output.textContent += `${output.textContent ? "\n" : ""}$ ${command}\n`;
  const payload = state.connected ? await api("/api/commands/run", { method: "POST", body: JSON.stringify({ root: state.workspace, command, cwd: ".", timeout: 120000, confirmed: true }) }) : null;
  const result = payload?.result || payload;
  output.textContent += payload ? `${result?.stdout || ""}${result?.stderr || ""}\n[exit ${result?.exit_code ?? 0}]\n` : "终端需要先连接工作区。\n";
  output.scrollTop = output.scrollHeight;
}
async function collectDirectoryFiles(directoryHandle, prefix = "", output = []) {
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") await collectDirectoryFiles(handle, path, output);
    else output.push({ file: await handle.getFile(), path, handle });
  }
  return output;
}
async function importWorkspaceFiles(entries, rootName) {
  const progress = $("folderProgress"), bar = $("folderProgressBar"), label = $("folderProgressLabel");
  progress.hidden = false;
  bar.style.width = "0%";
  label.textContent = "正在准备工作区…";
  try {
    // A browser File/DirectoryHandle cannot expose an absolute path to the
    // local server. Keep this compatibility path strictly in memory instead
    // of uploading into a hidden temporary backend workspace. Real edits and
    // agent tool execution require the backend-owned native picker.
    state.workspace = "";
    state.workspaceName = rootName;
    state.connected = false;
    state.previewOnly = true;
    state.sessionId = null;
    state.localFiles.clear();
    state.localHandles.clear();
    state.drafts.clear();
    state.savedFiles.clear();
    state.files = {};
    const root = { name: rootName, type: "directory", children: [] };
    let completed = 0;
    for (const entry of entries) {
      const path = String(entry.path || entry.file?.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const bits = path.split("/").filter(Boolean);
      if (!bits.length) continue;
      let children = root.children; let parentPath = "";
      bits.forEach((part, index) => {
        const isFile = index === bits.length - 1;
        const childPath = parentPath ? `${parentPath}/${part}` : part;
        if (isFile) { children.push({ name: part, type: "file", path: childPath }); return; }
        let folder = children.find((item) => item.name === part && item.type === "directory");
        if (!folder) { folder = { name: part, type: "directory", children: [] }; children.push(folder); }
        children = folder.children; parentPath = childPath;
      });
      const content = await entry.file.arrayBuffer();
      state.localFiles.set(path, new TextDecoder().decode(content));
      if (entry.handle) state.localHandles.set(path, entry.handle);
      completed += 1;
      bar.style.width = `${Math.round(completed / Math.max(entries.length, 1) * 100)}%`;
      label.textContent = `正在读取 ${completed}/${entries.length}`;
    }
    state.tree = root;
    state.collapsedPaths = new Set();
    const collapseFolders = (node, parent = "") => (node.children || []).forEach((child) => {
      if (child.type !== "directory") return;
      const path = parent ? `${parent}/${child.name}` : child.name;
      state.collapsedPaths.add(path); collapseFolders(child, path);
    });
    collapseFolders(root);
    renderTree(); setConnection(false, `本地只读预览 · ${rootName}`);
    const firstCode = [...state.localFiles.keys()].find((path) => /\.(py|js|ts|md|json|toml)$/.test(path)) || [...state.localFiles.keys()][0];
    if (firstCode) await selectFile(firstCode);
    notify(`已打开 ${rootName}（浏览器内存预览），共 ${entries.length} 个文件；要直接修改原目录，请使用后端原生选择器`);
  } finally {
    progress.hidden = true;
  }
}
async function handleFolderSelection(event) {
  const input = event.currentTarget || event.target;
  const files = [...input.files];
  input.value = "";
  if (!files.length) return;
  const first = files[0].webkitRelativePath || files[0].name;
  const rootName = first.includes("/") ? first.split("/")[0] : "local-folder";
  const entries = files.map((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    const parts = relativePath.split("/");
    if (parts[0] === rootName) parts.shift();
    return { file, path: parts.join("/") || file.name, handle: null };
  });
  try { await importWorkspaceFiles(entries, rootName); }
  catch (error) { notify(`打开文件夹失败：${error.message || "未知错误"}`); }
}
function resetWorkspaceClientState() {
  if (state.activeRequestController) state.activeRequestController.abort("user");
  state.activeRequestController = null;
  state.sessionId = null;
  state.selectedSessionIds.clear();
  state.sessionCreatePayload = null;
  state.lastTask = "";
  state.editingUserOrdinal = null;
  state.userMessageCount = 0;
  state.localFiles.clear();
  state.localHandles.clear();
  state.drafts.clear();
  state.savedFiles.clear();
  state.files = {};
  state.selectedPath = "";
  state.selectedFolderPath = "";
  state.editorSavedContent = "";
  state.editorDirty = false;
  state.activities = [];
  state.changeReview = { changes: [], expanded: false };
  $("activityList")?.replaceChildren();
  if ($("activityBadge")) $("activityBadge").textContent = "0";
  renderChangeReview([]);
  renderWelcome();
}
async function adoptBackendWorkspace(payload) {
  const root = String(payload?.root || "").trim();
  if (!root) throw new Error("后端没有返回有效的本地工作区路径");
  resetWorkspaceClientState();
  state.previewOnly = false;
  state.workspace = root;
  try { localStorage.setItem("codepilot.workspace", root); } catch {}
  state.workspaceName = shortPath(root);
  state.connected = true;
  state.tree = normaliseTree({ ...payload, root });
  state.collapsedPaths = new Set();
  const collapseFolders = (node, parent = "") => (node?.children || []).forEach((child) => {
    if (child.type !== "directory") return;
    const path = parent ? `${parent}/${child.name}` : child.name;
    state.collapsedPaths.add(path);
    collapseFolders(child, path);
  });
  collapseFolders(state.tree);
  renderTree();
  setConnection(true, `已连接 ${state.workspaceName}`);
  const paths = collectPaths(state.tree);
  if ($("testCommand")) $("testCommand").textContent = chooseSmokeCommand(state.tree);
  const firstCode = paths.find((path) => /\.(py|js|ts|tsx|jsx|md|json|toml|go|rs|java|cs|html|css)$/.test(path)) || paths[0];
  if (firstCode) await selectFile(firstCode);
  else {
    state.selectedPath = "";
    renderCode("", "");
  }
  notify(`已打开真实工作区 ${state.workspaceName}，Agent 将直接修改该目录`);
}
async function openFolder() {
  // Prefer the backend-owned native picker whenever this page can reach an
  // API. Connection probing happens asynchronously during boot; an unsettled
  // connection flag must not send the user into the browser-copy
  // fallback and make the agent edit a temporary import instead.
  // A browser FileSystemDirectoryHandle cannot reveal its absolute path to the
  // server; importing those files would silently create a temporary copy and
  // make the agent edit the wrong project.  The backend picker returns the
  // selected absolute root, so all subsequent reads/writes target the folder
  // the user actually chose (for example AgentPlay).
  // `state.connected` may still be false during boot, but HTTP pages remain
  // eligible; the flag is included only as an optimization, never a gate.
  const canTryBackendPicker = Boolean(state.connected || API_BASE || location.protocol !== "file:");
  // state.connected clients can use backend endpoint /api/workspace/select as
  // the primary path. Chromium's showDirectoryPicker cannot expose an absolute
  // filesystem root to the local agent, so it stays a read-only preview fallback.
  if (canTryBackendPicker) {
    notify("正在打开系统文件夹选择器…", 2500);
    const selected = await api("/api/workspace/select", {
      method: "POST",
      body: JSON.stringify({}),
      timeout: 180000,
      quiet: false,
    });
    if (selected?.pending && selected.job_id) {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await api(`/api/workspace/select?job=${encodeURIComponent(selected.job_id)}`, { quiet: true, timeout: 5000 });
        if (result?.pending) continue;
        if (result?.cancelled) { notify("已取消选择文件夹"); return; }
        if (result?.ok && result.root) { await adoptBackendWorkspace(result); return; }
        notify(result?.error || "打开文件夹失败", 5000); return;
      }
      notify("文件夹选择器等待超时", 5000); return;
    }
    if (selected?.ok && selected.root) {
      try {
        await adoptBackendWorkspace(selected);
      } catch (error) {
        notify(`连接工作区失败：${error.message || "未知错误"}`);
      }
      return;
    }
    // A deliberate cancel should not unexpectedly open a second picker.  If
    // the endpoint is unavailable (null) or unsupported, use the browser
    // upload fallback below.
    if (selected?.cancelled) { notify("已取消选择文件夹"); return; }
    if (selected?.ok === false) {
      notify(selected?.error || "无法连接工作区选择器，请确认后端正在运行", 5000);
      return;
    }
    if (selected == null && state.connected) {
      notify("无法连接工作区选择器，请确认后端正在运行", 5000);
      return;
    }
  }
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const directoryHandle = await window.showDirectoryPicker({ id: "codepilot-workspace", mode: "read" });
      const entries = await collectDirectoryFiles(directoryHandle);
      await importWorkspaceFiles(entries, directoryHandle.name || "local-folder");
      notify("当前为浏览器预览（只读）。要让 Agent 真实改文件，请先启动本地后端并用系统文件夹选择器打开目录。", 7000);
    } catch (error) {
      if (error?.name !== "AbortError") notify(`打开文件夹失败：${error.message || "未知错误"}`);
    }
    return;
  }
  const folderInput = $("folderInput");
  folderInput.value = "";
  folderInput.click();
}
function bytesToBase64(bytes) { let binary = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(binary); }
function explorerDirectory() {
  const menu = $("treeContextMenu");
  if (contextIsFolder && contextPath && menu && !menu.hidden) return contextPath.replace(/[\\/]$/, "");
  if (state.selectedFolderPath) return state.selectedFolderPath;
  const selected = String(state.selectedPath || "").replace(/\\/g, "/");
  const slash = selected.lastIndexOf("/");
  return slash > 0 ? selected.slice(0, slash) : ".";
}
async function newFile() {
  if (state.previewOnly) { notify("当前是只读预览，不能创建文件"); return; }
  const name = window.prompt("新建文件名", "untitled.py");
  if (!name || !name.trim()) return;
  const cleanName = name.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!cleanName || cleanName.includes("..") || /[<>:"|?*]/.test(cleanName)) { notify("文件名无效"); return; }
  const directory = explorerDirectory();
  const path = directory === "." ? cleanName : `${directory}/${cleanName}`;
  const content = "";
  if (state.connected && state.workspace) {
    const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ root: state.workspace, path, content }), timeout: 30000 });
    if (!result || result.ok === false) { notify(`新建文件失败：${result?.error || "请求失败"}`); return; }
    await refreshWorkspaceTree();
  } else {
    state.files[path] = content;
    const root = state.tree || mockTree;
    (root.children || (root.children = [])).push({ name: cleanName, type: "file", path });
    renderTree();
  }
  await selectFile(path);
  notify(`已创建 ${path}`);
}
async function newFolder() {
  if (state.previewOnly) { notify("当前是只读预览，不能创建文件夹"); return; }
  const name = window.prompt("新建文件夹名", "new-folder");
  if (!name || !name.trim()) return;
  const cleanName = name.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!cleanName || cleanName.includes("..") || /[\\/<>:"|?*]/.test(cleanName)) { notify("文件夹名无效"); return; }
  const directory = explorerDirectory();
  const path = directory === "." ? cleanName : `${directory}/${cleanName}`;
  if (state.connected && state.workspace) {
    const result = await api("/api/files/mkdir", { method: "POST", body: JSON.stringify({ root: state.workspace, path }), timeout: 30000 });
    if (!result || result.ok === false) { notify(`新建文件夹失败：${result?.error || "请求失败"}`); return; }
    await refreshWorkspaceTree();
  } else {
    const root = state.tree || mockTree;
    (root.children || (root.children = [])).push({ name: cleanName, type: "directory", path, children: [] });
    renderTree();
  }
  notify(`已创建文件夹 ${path}`);
}
async function copyCode() {
  const content = $("codeEditor")?.value ?? state.drafts.get(state.selectedPath) ?? state.localFiles.get(state.selectedPath) ?? state.files[state.selectedPath] ?? "";
  try { await navigator.clipboard.writeText(content); notify("代码已复制到剪贴板"); } catch { notify("当前浏览器不允许访问剪贴板"); }
}
function setLayoutPreference(codeFirst, announce = true) {
  const grid = document.querySelector(".content-grid");
  if (!grid) return;
  grid.classList.toggle("code-first", codeFirst);
  grid.classList.toggle("chat-first", !codeFirst);
  // A previous drag may have docked a pane. Switching layout starts from a
  // stable two-pane view so stale collapse classes cannot hide the editor.
  grid.classList.remove("chat-collapsed", "code-collapsed");
  grid.style.removeProperty("--chat-width");
  const button = $("layoutSwapButton");
  if (button) {
    button.setAttribute("aria-pressed", String(codeFirst));
    button.setAttribute("aria-label", codeFirst ? "切换为对话优先布局" : "切换为代码优先布局");
    button.title = codeFirst ? "切换为对话优先布局" : "切换为代码优先布局";
    $("layoutSwapLabel").textContent = codeFirst ? "对话优先" : "代码优先";
  }
  try { localStorage.setItem("codepilot.layout", codeFirst ? "code-first" : "chat-first"); } catch { /* private browsing */ }
  if (announce) notify(codeFirst ? "已切换为代码优先布局" : "已切换为对话优先布局");
}
function toggleLayout() {
  const grid = document.querySelector(".content-grid");
  setLayoutPreference(!grid?.classList.contains("code-first"));
}
function handleEditorKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && (event.code === "KeyS" || event.key.toLowerCase() === "s")) {
    event.preventDefault();
    saveCode();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText("  ", start, end, "end");
    markEditorDirty(editor.value);
  }
}
function handleEditorInput(event) {
  markEditorDirty(event.currentTarget.value);
}
function syncEditorScroll(event) {
  $("editorGutter").scrollTop = event.currentTarget.scrollTop;
  const highlightNode = $("codeHighlight");
  if (highlightNode) { highlightNode.scrollTop = event.currentTarget.scrollTop; highlightNode.scrollLeft = event.currentTarget.scrollLeft; }
}
// Idempotent auto-open: bring the plan modal to the front whenever the
// workflow has reached a plan-phase state (clarifying, planning, or waiting
// for approval) and the modal is not already visible.  Called after plan
// generation, revision, and after an approved plan finishes executing, so the
// modal reliably follows wherever the plan state lands.
function maybeAutoOpenPlanModal(trigger = null) {
  const modal = $("planModal");
  const wf = state.workflow || {};
  if (!modal) return false;
  if (["clarifying", "planning", "awaiting_approval"].includes(wf.phase)) {
    if (modal.hidden) {
      openPlanModal(trigger);
      return true;
    }
    // The dialog is already open (e.g. left on the clarification questions).
    // If a plan is now ready, switch it to the plan-review view in place so
    // the finished plan surfaces even though there was nothing left to "open".
    if (wf.phase === "awaiting_approval" || wf.phase === "planning") {
      renderPlanWorkflowModal();
      renderPlan();
    }
    return true;
  }
  return false;
}
function openPlanModal(trigger = null) {
  const modal = $("planModal"); const slot = $("planModalSlot");
  if (!modal || !slot) return;
  // Plan review is the primary workflow surface; never leave history,
  // settings, or a diff dialog visible behind it.
  closeOtherModals("planModal");
  if (modal.hidden) state.planReturnFocus = trigger || document.activeElement;
  slot.replaceChildren($("planPanel"));
  modal.hidden = false;
  syncModalBodyLock();
  // Re-render the step list so an already-open dialog never shows a stale
  // placeholder template when the plan is still generating.
  renderPlan();
  renderPlanWorkflowModal();
  const target = ["clarifying", "intake"].includes(state.workflow?.phase)
    ? $("clarificationAnswerInput")
    : slot.querySelector(".plan-input");
  setTimeout(() => target?.focus(), 0);
}
function closePlanModal() {
  const modal = $("planModal"); if (!modal) return;
  const panel = $("planPanel"); const inspector = document.querySelector(".inspector");
  if (panel && inspector && !inspector.contains(panel)) inspector.append(panel);
  if (modal.querySelector(".plan-modal-card")) modal.querySelector(".plan-modal-card").scrollTop = state.planScrollTop || 0;
  modal.hidden = true; syncModalBodyLock();
  const returnFocus = state.planReturnFocus;
  state.planReturnFocus = null;
  if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) setTimeout(() => returnFocus.focus(), 0);
}
function submitClarification() {
  if (state.planRequestPending) { notify("正在处理上一轮信息，请稍等片刻再提交。"); return; }
  const freeform = $("clarificationAnswerInput")?.value.trim() || "";
  const answers = {};
  document.querySelectorAll(".clarification-question").forEach((card) => {
    const hidden = card.querySelector(".clarification-selected");
    if (!hidden || hidden.dataset.questionId === undefined) return;
    const questionId = hidden.dataset.questionId;
    const other = card.querySelector(".clarification-other");
    const custom = card.querySelector(".clarification-custom-answer");
    if (other && !other.hidden && custom && custom.value.trim()) {
      answers[questionId] = custom.value.trim();
    } else if (hidden.value.trim()) {
      answers[questionId] = hidden.value.trim();
    }
  });
  if (!freeform && !Object.keys(answers).length) { notify("请至少回答一个问题"); $("clarificationAnswerInput")?.focus(); return; }
  if (freeform) answers._freeform = freeform;
  sendClarification(answers, freeform);
}
async function sendClarification(answers, freeform = "") {
  const readableAnswers = Object.entries(answers).filter(([key, value]) => key !== "_freeform" && String(value || "").trim()).map(([key, value]) => `${key}: ${String(value).trim()}`);
  const visibleAnswer = freeform || readableAnswers.join("；");
  if (visibleAnswer) appendMessage("user", visibleAnswer, "你");
  const planTrigger = document.activeElement;
  closePlanModal();
  // Stream the model's re-analysis into the conversation; the next question
  // batch (or the plan) arrives as follow-up events.
  const liveNode = appendMessage("assistant", "", "CodePilot · 需求明确");
  const liveBubble = liveNode.querySelector(".message-bubble");
  let liveText = "";
  await ensureSession();
  if (!state.sessionId) { notify("请先连接本地后端"); return; }
  state.planRequestPending = true;
  renderPlan(); updatePlanBadge();
  let payload = null;
  let lastError = null;
  const streamed = [];
  const handleStreamEvent = async (event) => {
    if (event.type === "assistant_delta") {
      liveText += event.content || event.delta || "";
      if (liveBubble) liveBubble.innerHTML = formatMessage(liveText);
      scrollConversationToBottom();
    }
    if (event.type === "clarification_requested") {
      const questions = event.questions || [];
      const questionText = questions.length > 0
        ? "\n\n请先补充以下信息（可逐项回答）：\n" + questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")
        : "\n\n需求信息已收集完整，接下来会整理成可执行的计划。";
      liveText += questionText;
      if (liveBubble) liveBubble.innerHTML = formatMessage(liveText);
      scrollConversationToBottom();
      loadClarificationEvent(event);
    }
    if (event.type === "plan_progress") await applyPlanProgress(event);
    if (event.type === "error") { lastError = event.error || event.message || "后端执行失败"; }
    // Finished plan arrives inside workflow_result.  Pop the plan dialog the
    // moment it finishes streaming, independent of the tail processing below.
    if (event.type === "workflow_result") loadPlanEvent(event, planTrigger);
  };
  try {
    await streamSessionWorkflow("turn", {
      message: freeform || "",
      answers: Object.fromEntries(Object.entries(answers).filter(([key]) => key !== "_freeform")),
      ...modelRequestFields(),
    }, async (event) => {
      streamed.push(event);
      await handleStreamEvent(event);
    }, 300000);
    const resultEvent = streamed.filter((event) => event.type === "workflow_result").at(-1);
    payload = resultEvent
      ? { ...resultEvent, events: streamed }
      : { ok: !streamed.some((event) => event.type === "error"), events: streamed, error: streamed.find((event) => event.type === "error")?.error };
    // Intake is satisfied.  Generate the plan on a SEPARATE short request so
    // a dev-reload or a transient network blip cannot abort the intake
    // analysis and the plan generation together; the answers are already
    // persisted on the session, so this call is idempotent and retryable.
    const nextAction = String(payload?.result?.next_action || payload?.next_action || "");
    if (nextAction === "plan") {
      // The plan request is idempotent (answers are persisted on the session),
      // so a transport-level drop (e.g. a dev-reload mid-flight) can be
      // retried once before surfacing an error.
      let planResult = null;
      let planEvents = [];
      let planErrorEvent = null;
      for (let attempt = 1; attempt <= 2 && !planResult; attempt++) {
        planEvents = [];
        planErrorEvent = null;
        try {
          await streamSessionWorkflow("plan", {
            ...modelRequestFields(),
          }, async (event) => {
            planEvents.push(event);
            if (event.type === "error") planErrorEvent = event.error || event.message || "计划生成失败";
            await handleStreamEvent(event);
          }, 300000);
        } catch (planError) {
          planErrorEvent = planErrorEvent || describeTransportError(planError);
        }
        planResult = planEvents.filter((event) => event.type === "workflow_result").at(-1);
        if (!planResult && attempt === 1 && !planEvents.some((event) => event.type === "error")) {
          continue; // transport drop, not a backend error: retry once
        }
      }
      if (planResult) {
        payload = { ...planResult, events: [...streamed, ...planEvents] };
      } else {
        // The plan stream closed without a result (or only an error event).
        // Mark the turn failed so the dialog reopens with a retry path
        // instead of showing a blank plan view.
        payload = {
          ok: false,
          events: [...streamed, ...planEvents],
          error: planErrorEvent || "计划生成失败，请重试",
          next_action: undefined,
        };
      }
    }
  } catch (error) {
    if (streamHadUsefulProgress(streamed)) {
      // The analysis was already streaming into the live bubble.  Keep that
      // partial reply on screen and let the user continue from the plan
      // dialog instead of replacing it with an error bubble.
      payload = { ok: false, stream_interrupted: true, error: describeTransportError(error) };
    } else {
      payload = { ok: false, error: isTransportError(error) ? describeTransportError(error) : (error?.message || "请求失败") };
    }
  } finally {
    state.planRequestPending = false;
    renderPlanWorkflowModal(); updatePlanBadge();
  }
  if (!payload || payload.ok === false) {
    if (payload?.stream_interrupted && liveText.trim()) {
      notify("实时连接中断，已保留当前回复。若已进入问答/计划，可直接在计划对话框继续回答。", 5000);
      maybeAutoOpenPlanModal(planTrigger);
      return;
    }
    // Remove the empty "需求明确" placeholder so it never leaves a
    // misleading "模型未返回可显示内容" bubble behind after a failure.
    if (liveNode && !liveText.trim()) liveNode.remove();
    const errorMsg = payload?.error || lastError || "后端未能完成需求明确分析，请检查后端运行状态与模型配置。";
    await appendMessageStream("assistant", `需求明确处理失败：${errorMsg}`, "CodePilot · 需求明确");
    notify(`需求明确提交失败：${errorMsg}`, 5000);
    // Keep the plan dialog reachable so the user can retry from the UI
    // instead of typing into the chat box.
    maybeAutoOpenPlanModal(planTrigger);
    return;
  }
  if (liveNode && !liveText.trim()) liveNode.remove();
  syncWorkflow(payload, { open: false });
  const message = extractAssistant(payload);
  if (!liveText.trim() && message) await appendMessageStream("assistant", message, "CodePilot · 需求明确");
  maybeAutoOpenPlanModal(planTrigger);
  if (state.workflow.phase !== "clarifying") $("clarificationAnswerInput").value = "";
}
let contextPath = "";
let contextIsFolder = false;
let fileClipboard = null;
function showTreeContextMenu(event, path, isFolder = false) {
  event.preventDefault(); contextPath = path; contextIsFolder = isFolder;
  const menu = $("treeContextMenu"); if (!menu) return;
  $("contextMenuPath").textContent = path;
  menu.querySelector('[data-context-action="open"]').hidden = isFolder;
  menu.querySelector('[data-context-action="copy-file"]').hidden = isFolder;
  menu.querySelector('[data-context-action="paste"]').disabled = !fileClipboard;
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 205)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 155)}px`;
}
function hideTreeContextMenu() { const menu = $("treeContextMenu"); if (menu) menu.hidden = true; }
async function refreshWorkspaceTree() {
  if (!state.connected || !state.workspace) { renderTree(); return; }
  const payload = await api(`/api/workspace/tree?root=${encodeURIComponent(state.workspace)}`);
  if (payload) state.tree = normaliseTree(payload);
  renderTree();
}
function applySavedTheme() {
  let saved = "light";
  try { saved = localStorage.getItem("codepilot.theme") || "light"; } catch { /* private browsing */ }
  document.documentElement.dataset.theme = saved === "dim" ? "dim" : "";
}
function toggleTheme() {
  const dim = document.documentElement.dataset.theme === "dim";
  document.documentElement.dataset.theme = dim ? "" : "dim";
  try { localStorage.setItem("codepilot.theme", dim ? "light" : "dim"); } catch { /* private browsing */ }
  notify(dim ? "已切换到浅色主题" : "已切换到深色主题（夜间模式）");
}
function resetSession() {
  if (state.activeRequestController) state.activeRequestController.abort("user");
  state.activeRequestController = null;
  state.sessionId = null;
  clearCompactionState();
  state.selectedSessionIds.clear();
  state.lastTask = "";
  state.editingUserOrdinal = null;
  state.userMessageCount = 0;
  state.activities = [];
  renderChangeReview([]);
  state.plan = [
    { id: uid(), text: "检查项目结构与现有测试入口", status: "todo" },
    { id: uid(), text: "实现任务所需的最小代码改动", status: "todo" },
    { id: uid(), text: "运行 smoke test，汇报结果并指出风险", status: "todo" },
  ];
  state.planState = "draft";
  state.workflow = { phase: "intake", route: "direct_execute", nextAction: "execute", clarificationRound: 0, questions: [], answers: {}, assumptions: [], planRevision: 1 };
  state.planRequestPending = false;
  $("activityList")?.replaceChildren();
  if ($("activityBadge")) $("activityBadge").textContent = "0";
  $("messageInput").value = "";
  $("messageInput").placeholder = "描述你想完成的编程任务…（Enter 发送，Shift + Enter 换行）";
  renderWelcome();
  renderPlan();
  updatePlanBadge();
  setMode("execute");
  notify("已创建新的计划会话");
}
function closeSessionHistory() {
  const modal = $("sessionHistoryModal");
  if (modal) { modal.hidden = true; syncModalBodyLock(); }
}
function closeSettings() { $("settingsModal").hidden = true; syncModalBodyLock(); }
function openSettings() {
  const effortSelect = $("reasoningEffortInput");
  if (effortSelect && !effortSelect.querySelector('option[value="xhigh"]')) {
    effortSelect.insertAdjacentHTML("beforeend", '<option value="xhigh">极高（xhigh）</option><option value="max">最大（max）</option>');
  }
  // sessionStorage holds the copy that includes the api key for this tab;
  // localStorage deliberately keeps only non-secret fields.  Read the richer
  // copy first so a saved key is not clobbered by the sanitized one.
  try { state.settings = { ...state.settings, ...JSON.parse(sessionStorage.getItem("codepilot.settings") || localStorage.getItem("codepilot.settings") || "{}") }; } catch { /* ignore malformed session data */ }
  if (state.settings.reasoningEffort === "ultra") state.settings.reasoningEffort = "max";
  $("apiBaseInput").value = state.settings.baseUrl; $("settingsModelInput").value = state.settings.model; $("wireApiInput").value = state.settings.wireApi || "auto"; $("reasoningEffortInput").value = state.settings.reasoningEffort || "medium";
  // The API key is never rendered: credentials live only in the backend .env /
  // account settings, so nothing secret can leak onto the screen (recording).
  closeOtherModals("settingsModal");
  $("settingsModal").hidden = false; syncModalBodyLock();
}
function saveSettings() {
  state.settings = { baseUrl: $("apiBaseInput").value.trim() || "https://xcpcai.com/v1", model: $("settingsModelInput").value.trim() || "gpt-5.6-sol", wireApi: $("wireApiInput").value || "auto", reasoningEffort: $("reasoningEffortInput").value || "medium" };
  setSelectedModel(state.settings.model);
  // Persist only non-secret settings; the key is never stored or sent here.
  sessionStorage.setItem("codepilot.settings", JSON.stringify(state.settings));
  localStorage.setItem("codepilot.settings", JSON.stringify(state.settings));
  const payload = { base_url: state.settings.baseUrl, model: state.settings.model, wire_api: state.settings.wireApi, reasoning_effort: state.settings.reasoningEffort };
  api("/api/settings", { method: "PUT", body: JSON.stringify(payload), quiet: true }).then((result) => {
    if (!result || result.ok === false) { notify(`默认配置保存失败：${result?.error || "后端不可用"}`, 5000); return; }
    closeSettings(); notify("已保存为本机默认配置");
  });
}
function setSelectedModel(value) {
  const select = $("modelSelect");
  const option = [...(select?.options || [])].find((item) => item.value === value);
  if (!select || !option) return;
  select.value = option.value;
  const pickerButton = $("modelPickerButton");
  if (pickerButton) {
    const label = [...pickerButton.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (label) label.nodeValue = `${option.textContent} `;
    pickerButton.setAttribute("aria-expanded", "false");
  }
  document.querySelectorAll(".model-menu-option").forEach((item) => item.setAttribute("aria-selected", String(item.dataset.model === option.value)));
}
function bindModelPicker() {
  const button = $("modelPickerButton");
  const menu = $("modelMenu");
  if (!button || !menu) return;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
  menu.querySelectorAll(".model-menu-option").forEach((item) => item.addEventListener("click", () => {
    setSelectedModel(item.dataset.model);
    menu.hidden = true;
  }));
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#modelPicker")) { menu.hidden = true; button.setAttribute("aria-expanded", "false"); }
  });
}
const beijingDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function formatSessionTimestamp(value) {
  if (!value) return "时间未知";
  const raw = String(value).trim();
  // Older snapshots may omit an offset.  Session timestamps are authored by
  // the UTC backend, so interpret those legacy values as UTC before converting
  // to the explicitly requested Beijing timezone.
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(date.getTime())) return "时间未知";
  // Avoid a malformed slash regex here: in the browser it was parsed as a
  // division expression and raised `ReferenceError: g is not defined` while
  // rendering session history.
  return beijingDateFormatter.format(date).replaceAll("/", "-");
}
function updateSessionSelectionUi(total = document.querySelectorAll(".session-select-checkbox[data-session-id]").length) {
  const selectAll = $("session-select-all");
  const bulkDelete = $("session-bulk-delete");
  const count = $("sessionSelectionCount");
  const selected = state.selectedSessionIds.size;
  if (count) count.textContent = `已选 ${selected} 个`;
  if (bulkDelete) {
    bulkDelete.disabled = selected === 0 || state.sessionDeletePending;
    bulkDelete.textContent = state.sessionDeletePending ? "删除中…" : `删除已选${selected ? `（${selected}）` : ""}`;
  }
  if (selectAll) {
    selectAll.disabled = total === 0 || state.sessionDeletePending;
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
  }
  document.querySelectorAll(".session-select-checkbox[data-session-id]").forEach((checkbox) => {
    checkbox.checked = state.selectedSessionIds.has(checkbox.dataset.sessionId);
    checkbox.disabled = state.sessionDeletePending;
  });
  document.querySelectorAll(".session-delete-button, .session-open-button").forEach((button) => {
    button.disabled = state.sessionDeletePending;
  });
}
function markSessionRowDeleted(sessionId) {
  state.selectedSessionIds.delete(sessionId);
  const row = [...document.querySelectorAll(".session-row[data-session-id]")].find((item) => item.dataset.sessionId === sessionId);
  row?.remove();
}
async function deleteSession(sessionId) {
  const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: JSON.stringify({}) });
  if (!result || result.ok === false) throw new Error(result?.error || "请求失败");
  if (state.sessionId === sessionId) resetSession();
  markSessionRowDeleted(sessionId);
}
async function deleteSelectedSessions() {
  if (state.sessionDeletePending || state.selectedSessionIds.size === 0) return;
  const ids = [...state.selectedSessionIds];
  if (!window.confirm(`确认删除选中的 ${ids.length} 个历史会话？此操作不可撤销。`)) return;
  state.sessionDeletePending = true;
  updateSessionSelectionUi();
  const results = await Promise.allSettled(ids.map((id) => deleteSession(id)));
  state.sessionDeletePending = false;
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`删除会话失败（${ids[index]}）`, result.reason);
  });
  if (failed.length) notify(`${failed.length} 个会话删除失败，请重试`, 5000);
  else notify(`已删除 ${ids.length} 个历史会话`);
  updateSessionSelectionUi();
  const list = $("sessionList");
  if (list && !list.querySelector(".session-row")) list.innerHTML = '<div class="session-empty">暂无历史会话</div>';
}
async function testModelConnection() {
  const button = $("testConnectionButton");
  const payload = {
    base_url: $("apiBaseInput").value.trim() || "https://xcpcai.com/v1",
    model: $("settingsModelInput").value.trim() || "gpt-5.6-sol",
    wire_api: $("wireApiInput").value || "auto",
    reasoning_effort: $("reasoningEffortInput").value || "medium",
    api_key: $("apiKeyInput").value.trim(),
  };
  if (!payload.api_key) { notify("请先填写 API Key"); return; }
  if (button) { button.disabled = true; button.textContent = "测试中…"; }
  const result = await api("/api/model/test", { method: "POST", body: JSON.stringify(payload), timeout: 180000 });
  if (button) { button.disabled = false; button.textContent = "测试连接"; }
  if (result?.ok) notify(`连接成功：${result.message || "模型已响应"}`); else notify(`连接失败：${result?.error || "无法连接模型"}`, 5000);
}
async function openSessionHistory() {
  const modal = $("sessionHistoryModal");
  const list = $("sessionList");
  closeOtherModals("sessionHistoryModal");
  modal.hidden = false; syncModalBodyLock();
  state.selectedSessionIds.clear();
  state.sessionDeletePending = false;
  updateSessionSelectionUi(0);
  list.replaceChildren();
  const payload = await api("/api/sessions", { quiet: true });
  const sessions = payload?.sessions || [];
  if (!sessions.length) { list.innerHTML = '<div class="session-empty">暂无历史会话</div>'; updateSessionSelectionUi(0); return; }
  sessions.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  sessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.sessionId = session.id;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "session-select-checkbox";
    checkbox.dataset.sessionId = session.id;
    checkbox.setAttribute("aria-label", `选择会话 ${session.task || "未命名会话"}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedSessionIds.add(session.id);
      else state.selectedSessionIds.delete(session.id);
      updateSessionSelectionUi(sessions.length);
    });
    const open = document.createElement("button");
    open.type = "button"; open.className = "session-open-button";
    open.innerHTML = `<span class="session-row-title">${escapeHtml(session.task || "未命名会话")}</span><span class="session-row-meta">${escapeHtml(session.status || "planning")} · ${escapeHtml(formatSessionTimestamp(session.updated_at || session.created_at))}</span>`;
    open.addEventListener("click", async () => {
        const detail = await api(`/api/sessions/${encodeURIComponent(session.id)}`, { quiet: true });
        if (!detail || detail.ok === false) {
          notify(`恢复会话失败：${detail?.error || "无法读取会话快照"}`);
          return;
        }
        const restored = detail?.session || detail;
        try {
          state.sessionId = restored.id || session.id;
          state.lastTask = restored.task || session.task || "";
          if (restored.workspace) {
            state.workspace = restored.workspace;
            state.workspaceName = shortPath(restored.workspace);
            await refreshWorkspaceTree();
          }
          const workflow = syncWorkflow(detail, { open: false });
          const planPhases = ["clarifying", "planning", "awaiting_approval", "replanning"];
          if (workflow.phase === "clarifying") state.planState = "draft";
          // Restore the persisted context-compaction checkpoint: if this
          // session already compressed at the approve->execute seam, keep the
          // "查看压缩" button visible so a reload never forgets the summary.
          const restoredCompaction = restored.context_compaction || detail?.session?.context_compaction;
          if (restoredCompaction && restoredCompaction.summary) {
            clearCompactionState();
            state.lastCompaction = restoredCompaction;
            showCompactionButton();
          }
          if (restored.mode === "plan" || planPhases.includes(workflow.phase)) setMode("plan", { persist: false });
          else setMode("execute", { persist: false });
          // Only adopt a real persisted plan.  An empty/static session must
          // not silently fall back to a default step list in this panel.
          const restoredPlan = extractPlan(detail);
          if (restoredPlan && restoredPlan.length) {
            state.plan = restoredPlan;
            renderPlan();
          }
          const messages = restored.messages || detail?.messages || [];
          $("conversation").replaceChildren();
          state.userMessageCount = 0;
          messages.filter((message) => ["user", "assistant"].includes(message.role)).forEach((message) => appendMessage(message.role, message.content || "", undefined, message.role === "user" ? { userOrdinal: state.userMessageCount } : {}));
          if (!messages.some((message) => ["user", "assistant"].includes(message.role)) && restored.last_message) appendMessage("assistant", restored.last_message, "CodePilot · 历史记录");
          if (planPhases.includes(workflow.phase)) openPlanModal($("sessionHistoryButton"));
          else closePlanModal();
          notify("已恢复历史会话");
        } catch (error) {
          console.error("恢复会话失败", error);
          updatePlanBadge(); renderPlanWorkflowModal();
          notify(`恢复会话失败：${error?.message || "未知错误"}`, 5000);
        } finally {
          closeSessionHistory();
        }
      });
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "session-delete-button";
    remove.title = "删除会话"; remove.setAttribute("aria-label", "删除会话");
    remove.innerHTML = '<svg class="toolbar-icon" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 5.5h10M7 5.5V3.8h4v1.7M6 7.5v6.2h6V7.5M8 9.2v2.8M10 9.2v2.8"/></svg>';
    remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!window.confirm("确认删除这个历史会话？")) return;
        try {
          await deleteSession(session.id);
          if (!list.querySelector(".session-row")) list.innerHTML = '<div class="session-empty">暂无历史会话</div>';
          updateSessionSelectionUi();
          notify("历史会话已删除");
        } catch (error) { notify(`删除失败：${error.message || "请求失败"}`); }
      });
    row.append(checkbox, open, remove);
    list.append(row);
  });
  updateSessionSelectionUi(sessions.length);
}
function bindEvents() {
  // Prefer the modern backend-owned directory picker.  The hidden input is a
  // compatibility fallback for browsers without the File System Access API.
  // `openFolder` may be unavailable in legacy/cached bundles. Resolve it
  // defensively so one stale handler cannot abort the entire boot sequence
  // and leave every control unresponsive.
  const openFolderHandler = typeof openFolder === "function"
    ? openFolder
    : async () => {
        notify("正在打开系统文件夹选择器…", 2500);
        const selected = await api("/api/workspace/select", {
          method: "POST",
          body: JSON.stringify({}),
          timeout: 180000,
          quiet: false,
        });
        if (selected?.pending && selected.job_id) {
          for (let attempt = 0; attempt < 240; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const result = await api(`/api/workspace/select?job=${encodeURIComponent(selected.job_id)}`, { quiet: true, timeout: 5000 });
            if (result?.pending) continue;
            if (result?.cancelled) return;
            if (result?.ok && result.root) { await adoptBackendWorkspace(result); return; }
            notify(result?.error || "打开文件夹失败", 5000); return;
          }
          notify("文件夹选择器等待超时", 5000); return;
        }
        if (selected?.ok && selected.root) await adoptBackendWorkspace(selected);
        else if (!selected?.cancelled) notify(selected?.error || "无法打开文件夹选择器，请确认后端正在运行", 5000);
      };
  $("openFolderButton").addEventListener("click", openFolderHandler);
  $("folderInput").addEventListener("change", handleFolderSelection);
  $("refreshTreeButton").addEventListener("click", refreshWorkspaceTree);
  $("newFileButton").addEventListener("click", newFile);
  $("newFolderButton").addEventListener("click", newFolder);
  $("sendButton").addEventListener("click", sendMessage);
  $("messageInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
  $("planModeButton").addEventListener("click", () => setMode("plan")); $("executeModeButton").addEventListener("click", () => setMode("execute"));
  $("addStepButton").addEventListener("click", () => {
    // Adding steps is only allowed while the plan is editable (draft/review,
    // or after the original plan has completed).  While executing (or during
    // the pre-run context compression) the plan is frozen.
    if (["executing", "compressing"].includes(state.planState) || state.planRequestPending) return;
    state.plan.push({ id: uid(), text: "补充一个待确认步骤", status: "todo" });
    renderPlan();
    setTimeout(() => listLastPlanInput()?.focus(), 0);
  });
  $("codeTabButton").addEventListener("click", showCode); $("activityTabButton").addEventListener("click", showActivity); $("clearActivityButton").addEventListener("click", () => { $("terminalOutput").textContent = ""; });
  $("terminalForm").addEventListener("submit", (event) => { event.preventDefault(); const input = $("terminalInput"); const command = input.value.trim(); if (command) { input.value = ""; runTerminalCommand(command); } });
  $("terminalInput").addEventListener("keydown", (event) => { if (!["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const next = event.key === "ArrowUp" ? Math.max(0, state.terminalHistoryIndex - 1) : Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1); state.terminalHistoryIndex = next; event.target.value = state.terminalHistory[next] || ""; });
  const terminalResizer = $("terminalResizer"); let terminalDragging = false;
  terminalResizer.addEventListener("pointerdown", (event) => { terminalDragging = true; terminalResizer.setPointerCapture(event.pointerId); document.body.classList.add("resizing-vertical"); });
  terminalResizer.addEventListener("pointermove", (event) => { if (!terminalDragging) return; const inspector = $("terminalResizer").parentElement; const rect = inspector.getBoundingClientRect(); const terminalHeight = Math.max(150, Math.min(rect.height - 180, rect.bottom - event.clientY)); inspector.style.setProperty("--terminal-height", `${terminalHeight}px`); });
  terminalResizer.addEventListener("pointerup", () => { terminalDragging = false; document.body.classList.remove("resizing-vertical"); });
  $("copyCodeButton").addEventListener("click", copyCode); $("themeButton").addEventListener("click", toggleTheme);
  $("reviewChangesButton").addEventListener("click", () => {
    const first = state.changeReview.changes[0];
    if (first) openChangeDiff(first);
  });
  $("undoChangesButton").addEventListener("click", undoChanges);
  $("changeReviewMore").addEventListener("click", () => renderChangeReview(state.changeReview.changes, !state.changeReview.expanded));
  $("closeChangeDiff").addEventListener("click", closeChangeDiff);
  $("changeReviewModal").addEventListener("click", (event) => { if (event.target.matches("[data-close-change-modal]")) closeChangeDiff(); });
  $("layoutSwapButton").addEventListener("click", toggleLayout);
  $("codeEditor").addEventListener("input", handleEditorInput);
  $("codeEditor").addEventListener("keydown", handleEditorKeydown);
  $("codeEditor").addEventListener("scroll", syncEditorScroll);
  $("newSessionButton").addEventListener("click", resetSession);
  $("scrollToBottomButton").addEventListener("click", () => {
    const el = $("conversation");
    if (!el) return;
    scrollFollow.pendingNewContent = false;
    el.scrollTop = el.scrollHeight;
    updateScrollToBottomButton();
  });
  $("conversation").addEventListener("scroll", () => updateScrollToBottomButton());
  window.addEventListener("resize", () => updateScrollToBottomButton());
  $("sessionHistoryButton").addEventListener("click", openSessionHistory);
  $("closeSessionHistory").addEventListener("click", closeSessionHistory);
  $("session-select-all").addEventListener("change", (event) => {
    const checked = event.target.checked;
    document.querySelectorAll(".session-select-checkbox[data-session-id]").forEach((checkbox) => {
      checkbox.checked = checked;
      if (checked) state.selectedSessionIds.add(checkbox.dataset.sessionId);
      else state.selectedSessionIds.delete(checkbox.dataset.sessionId);
    });
    updateSessionSelectionUi();
  });
  $("session-bulk-delete").addEventListener("click", deleteSelectedSessions);
  $("sessionHistoryModal").addEventListener("click", (event) => { if (event.target.matches("[data-close-session-modal]")) closeSessionHistory(); });
  $("settingsButton").addEventListener("click", openSettings); $("closeSettings").addEventListener("click", closeSettings); $("saveSettingsButton").addEventListener("click", saveSettings);
  $("testConnectionButton").addEventListener("click", testModelConnection);
  bindModelPicker();
  $("settingsModal").addEventListener("click", (event) => { if (event.target.matches("[data-close-settings]")) closeSettings(); });
      $("revisePlanButton").addEventListener("click", () => openReplanEditor($("revisePlanButton")));
  // 需求问答 / 执行计划 视图切换（含多轮来回跳转）。
  $("clarificationTabButton").addEventListener("click", () => switchPlanView("clarify", $("clarificationTabButton")));
  $("planReviewTabButton").addEventListener("click", () => switchPlanView("plan", $("planReviewTabButton")));
  $("backToClarificationButton").addEventListener("click", () => switchPlanView("clarify", $("backToClarificationButton")));
  $("openPlanButton").addEventListener("click", () => openPlanModal($("openPlanButton")));
  $("openCompactionButton").addEventListener("click", openCompactionModal);
  $("closeCompactionModal").addEventListener("click", closeCompactionModal);
  $("compactionModal").addEventListener("click", (event) => { if (event.target.matches("[data-close-compaction]")) closeCompactionModal(); });
  $("approvePlanButton").addEventListener("click", () => approvePlan());
  $("submitClarificationButton").addEventListener("click", submitClarification);
  $("clarificationAnswerInput").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submitClarification(); } });
      $("submitReplanButton").addEventListener("click", submitReplan);
      $("replanFeedbackInput").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submitReplan(); } });
  $("cancelPlanButton").addEventListener("click", async () => {
    if (state.sessionId) await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/cancel`, { method: "POST", body: JSON.stringify({}), quiet: true });
    closePlanModal();
  });
  $("closePlanModal").addEventListener("click", closePlanModal);
  $("planModal").addEventListener("click", (event) => { if (event.target.matches("[data-close-plan-modal]")) closePlanModal(); });
  $("planModal").addEventListener("keydown", (event) => {
    const modal = $("planModal");
    if (event.key === "Escape") { event.preventDefault(); closePlanModal(); return; }
    const focusable = [...modal.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])")].filter((node) => !node.hidden && node.offsetParent !== null);
    if (event.key !== "Tab") return;
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $("planModal").addEventListener("scroll", (event) => { state.planScrollTop = event.currentTarget.scrollTop; });
  document.addEventListener("click", (event) => { if (!event.target.closest("#treeContextMenu")) hideTreeContextMenu(); });
  document.querySelectorAll("#treeContextMenu [data-context-action]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.contextAction; hideTreeContextMenu();
    if (state.previewOnly && ["paste", "delete"].includes(action)) {
      notify("当前是只读预览，不能修改文件");
      return;
    }
    if (action === "open") await selectFile(contextPath);
    if (action === "mention") { $("messageInput").value += `${$("messageInput").value ? " " : ""}@${contextPath}`; $("messageInput").focus(); }
    if (action === "copy-file") { const content = state.drafts.get(contextPath) ?? state.localFiles.get(contextPath) ?? state.files[contextPath] ?? ""; fileClipboard = { path: contextPath, content }; try { await navigator.clipboard.writeText(content); notify("文件内容已复制"); } catch { notify("文件内容已暂存"); } }
    if (action === "paste") { if (!contextIsFolder || !fileClipboard) { notify("请先右键文件夹，再复制文件后粘贴"); return; } const destination = `${contextPath.replace(/[\\/]$/, "")}/${fileClipboard.path.split(/[\\/]/).pop()}`; if (state.connected && state.workspace) { const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ root: state.workspace, path: destination, content: fileClipboard.content }) }); if (!result || result.ok === false) { notify(`粘贴失败：${result?.error || "请求失败"}`); return; } } state.files[destination] = fileClipboard.content; await refreshWorkspaceTree(); notify("文件已粘贴"); }
        if (action === "delete") {
          if (!window.confirm(`确认删除 ${contextPath}？此操作不可撤销。`)) return;
          if (state.connected && state.workspace) {
            const result = await api("/api/files/delete", { method: "DELETE", body: JSON.stringify({ root: state.workspace, path: contextPath, recursive: contextIsFolder, confirmed: contextIsFolder }) });
            if (!result || result.ok === false) { notify(`删除失败：${result?.error || "请求失败"}`); return; }
          }
          delete state.files[contextPath]; state.localFiles.delete(contextPath); state.drafts.delete(contextPath); state.savedFiles.delete(contextPath);
          if (state.selectedFolderPath === contextPath || state.selectedFolderPath.startsWith(`${contextPath}/`)) state.selectedFolderPath = "";
          if (state.selectedPath === contextPath) {
            state.selectedPath = "";
            state.editorSavedContent = "";
            state.editorDirty = false;
            $("codeEditor").value = "";
            renderCode("", "");
            updateEditorState();
          }
          if (state.connected && state.workspace) {
            await refreshWorkspaceTree();
            if (!state.selectedPath) {
              const nextPath = collectPaths(state.tree || mockTree)[0];
              if (nextPath) await selectFile(nextPath);
            }
          }
          else {
            const removeNode = (node, parentPath = "") => {
              const children = node.children || [];
              node.children = children.filter((child) => {
                const childPath = child.path || (parentPath ? `${parentPath}/${child.name}` : child.name);
                return childPath !== contextPath;
              });
              node.children.forEach((child) => removeNode(child, child.path || (parentPath ? `${parentPath}/${child.name}` : child.name)));
            };
            removeNode(state.tree || mockTree);
            renderTree();
          }
          notify("文件已删除");
    }
  }));
  $("fileTree").addEventListener("contextmenu", (event) => { const row = event.target.closest(".tree-node"); if (row) showTreeContextMenu(event, row.dataset.path || row.querySelector(".node-label")?.textContent || "", row.dataset.kind === "directory"); });
      const divider = $("paneDivider"); let dragging = false;
      divider.addEventListener("pointerdown", (event) => { dragging = true; divider.setPointerCapture(event.pointerId); document.body.classList.add("resizing"); });
      divider.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const grid = document.querySelector(".content-grid");
        const rect = grid.getBoundingClientRect();
        const explorer = grid.querySelector(".sidebar").getBoundingClientRect().width;
        const available = Math.max(0, rect.width - explorer - 8);
        const codeFirst = grid.classList.contains("code-first");
        const collapseThreshold = 120;
        if (codeFirst && event.clientX >= rect.right - collapseThreshold) {
          grid.classList.add("chat-collapsed");
          grid.classList.remove("code-collapsed");
          grid.style.removeProperty("--chat-width");
          divider.setAttribute("aria-valuenow", "0");
          return;
        }
        let chat = codeFirst ? rect.right - event.clientX : event.clientX - rect.left - explorer;
        const minChat = codeFirst ? 380 : 320;
        const minCode = codeFirst ? 320 : 420;
        const maxChat = Math.max(minChat, available - minCode);
        chat = Math.max(minChat, Math.min(maxChat, chat));
        // Dragging only resizes panes; it must never make the code pane
        // disappear. Explicit collapse controls remain available separately.
        grid.classList.remove("chat-collapsed", "code-collapsed");
        if (chat > 0 && available - chat > 0) {
          // Keep the opposite pane above its declared minimum.  The old
          // `available - 360` clamp could leave the code pane narrower than
          // its 420px grid minimum, especially in chat-first mode, causing
          // the editor to disappear off-screen after dragging right.
          grid.style.setProperty("--chat-width", `${chat}px`);
        }
        divider.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(available, chat)))));
      });
      const stopDragging = () => { dragging = false; document.body.classList.remove("resizing"); };
      divider.addEventListener("pointerup", stopDragging);
      divider.addEventListener("pointercancel", stopDragging);
      divider.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const grid = document.querySelector(".content-grid");
        const step = event.key === "Home" ? -9999 : event.key === "End" ? 9999 : (event.key === "ArrowLeft" ? -48 : 48);
        const current = Number.parseFloat(getComputedStyle(grid).getPropertyValue("--chat-width")) || 520;
        const next = current + step;
        const rect = grid.getBoundingClientRect();
        const explorer = grid.querySelector(".sidebar").getBoundingClientRect().width;
        const available = Math.max(0, rect.width - explorer - 8);
        grid.classList.toggle("chat-collapsed", next <= 120);
        grid.classList.toggle("code-collapsed", available - next <= 120);
        if (next > 120 && available - next > 120) {
          const codeFirst = grid.classList.contains("code-first");
          const minChat = codeFirst ? 380 : 320;
          const minCode = codeFirst ? 320 : 420;
          grid.style.setProperty("--chat-width", `${Math.max(minChat, Math.min(Math.max(minChat, available - minCode), next))}px`);
        }
      });
  $("codeEditor").addEventListener("wheel", (event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); const root = document.documentElement; const current = Number.parseFloat(getComputedStyle(root).getPropertyValue("--editor-font-size")) || 13; const next = Math.max(10, Math.min(24, current + (event.deltaY < 0 ? 1 : -1))); root.style.setProperty("--editor-font-size", `${next}px`); document.querySelectorAll(".code-editor-wrap .code-editor, .code-highlight, .editor-gutter").forEach((node) => { node.style.fontSize = `${next}px`; }); notify(`代码字号 ${next}px`, 900); }, { passive: false });
}
function listLastPlanInput() { return $("planList").querySelector(".plan-item:last-child .plan-input"); }
let agentBooted = false;
// Load model/API defaults from the backend's .env (via GET /api/settings).
// Both a fresh page load (startApplication) and a brand-new login (bootAgent)
// must run this so state.apiKeyConfigured is always truthful — otherwise the
// send guard below thinks no key exists and prompts for one even when .env is
// already configured.  User-level overrides saved to .env are picked up here;
// the local-storage copy is only a layout mirror, never a settings source.
async function loadBackendSettings() {
  const accountSettings = await api("/api/settings", { quiet: true });
  if (!accountSettings?.settings) return;
  // The backend reports snake_case keys (base_url, wire_api, reasoning_effort)
  // while state.settings uses camelCase (baseUrl, wireApi, reasoningEffort),
  // so map explicitly.  The .env value IS the source of truth for defaults.
  const backend = accountSettings.settings || {};
  state.settings = {
    ...state.settings,
    baseUrl: String(backend.base_url || backend.baseUrl || state.settings.baseUrl || "").trim(),
    model: String(backend.model || state.settings.model || "").trim(),
    wireApi: String(backend.wire_api || backend.wireApi || state.settings.wireApi || "auto").trim(),
    reasoningEffort: String(backend.reasoning_effort || backend.reasoningEffort || state.settings.reasoningEffort || "medium").trim(),
  };
  // The backend never echoes the secret back; it only reports whether one
  // is configured.  Keep that flag so a reload does not force the user to
  // re-enter the key before every task.
  state.apiKeyConfigured = String(backend.api_key_configured || backend.apiKeyConfigured || "") === "true";
  sessionStorage.setItem("codepilot.settings", JSON.stringify(state.settings));
  // Only save non-sensitive settings to localStorage for layout persistence
  try {
    const safeSettings = { ...state.settings };
    delete safeSettings.apiKey;
    localStorage.setItem("codepilot.settings", JSON.stringify(safeSettings));
  } catch {}
}
function showAuthenticatedApp() {
  $("authPage")?.setAttribute("hidden", "true");
  const shell = $("appShell");
  if (shell) shell.hidden = false;
  document.body.classList.remove("auth-screen");
}
function setPersonalCenterUser(user) {
  const avatar = $("personalCenterButton");
  if (avatar) avatar.textContent = (user?.username || "N").trim().slice(0, 1).toUpperCase() || "N";
  const name = $("personalName");
  const email = $("personalEmail");
  if (name) name.textContent = user?.username || "CodePilot 用户";
  if (email) email.textContent = user?.email ? `邮箱：${user.email}` : "未绑定邮箱";
  const profileAvatar = $("personalAvatar");
  if (profileAvatar) profileAvatar.textContent = (user?.username || "N").trim().slice(0, 1).toUpperCase() || "N";
}
async function openPersonalCenter() {
  const modal = $("personalCenterModal");
  if (!modal) return;
  closeOtherModals("personalCenterModal");
  modal.hidden = false;
  syncModalBodyLock();
  await renderPersonalCenter();
}
function closePersonalCenter() {
  const modal = $("personalCenterModal");
  if (modal) modal.hidden = true;
  syncModalBodyLock();
}
async function logoutAccount() {
  await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}), quiet: true });
  clearAuthState();
  window.location.reload();
}
async function savePersonalProfile() {
  const usernameInput = $("profileUsername");
  const emailInput = $("profileEmail");
  const username = usernameInput?.value.trim() || "";
  if (!username) { notify("用户名不能为空"); usernameInput?.focus(); return; }
  const button = $("saveProfileButton");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/auth/me", { method: "PUT", body: JSON.stringify({ username, email: emailInput?.value.trim() || "" }) });
    if (!result || result.ok === false) { notify(`保存失败：${result?.error || "请求失败"}`, 5000); return; }
    setPersonalCenterUser(result.user);
    notify(result.message || "资料已更新");
  } finally {
    button.disabled = false;
  }
}
async function savePersonalPassword() {
  const current = $("currentPassword")?.value || "";
  const fresh = $("newPassword")?.value || "";
  const confirm = $("confirmPassword")?.value || "";
  if (!current) { notify("请填写当前密码"); $("currentPassword")?.focus(); return; }
  if (fresh.length < 6) { notify("新密码至少 6 个字符"); $("newPassword")?.focus(); return; }
  if (fresh !== confirm) { notify("两次输入的新密码不一致"); $("confirmPassword")?.focus(); return; }
  const button = $("savePasswordButton");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/auth/password", { method: "PUT", body: JSON.stringify({ current_password: current, new_password: fresh }) });
    if (!result || result.ok === false) { notify(`密码修改失败：${result?.error || "请求失败"}`, 5000); return; }
    if ($("currentPassword")) $("currentPassword").value = "";
    if ($("newPassword")) $("newPassword").value = "";
    if ($("confirmPassword")) $("confirmPassword").value = "";
    notify(result.message || "密码已更新");
  } finally {
    button.disabled = false;
  }
}
async function renderPersonalCenter() {
  const profile = await api("/api/auth/me", { quiet: true });
  const user = profile?.ok ? profile.user : null;
  setPersonalCenterUser(user);
  const profileInput = $("profileUsername");
  if (profileInput) profileInput.value = user?.username || "";
  const emailInput = $("profileEmail");
  if (emailInput) emailInput.value = user?.email || "";
  const sessionsPayload = await api("/api/sessions", { quiet: true });
  const sessions = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
  const sessionsCount = sessionsPayload?.ok === false ? "–" : String(sessions.length);
  if ($("statSessions")) $("statSessions").textContent = sessionsCount;
  if ($("statWorkspace")) $("statWorkspace").textContent = state.workspaceName || state.workspace || "未选择";
  const registered = $("statRegistered");
  if (registered) {
    const created = user?.created_at;
    if (!created) registered.textContent = "–";
    else if (typeof created === "number") registered.textContent = formatSessionTimestamp(new Date(created * 1000).toISOString()).slice(0, 10);
    else registered.textContent = formatSessionTimestamp(created).slice(0, 10);
  }
  const line = $("personalSessionLine");
  if (line) {
    line.innerHTML = state.sessionId
      ? `<span class="personal-session-status online"></span>当前会话活跃中 · ${escapeHtml(state.workspaceName || state.workspace || "工作区未选择")}`
      : `<span class="personal-session-status"></span>尚未创建会话，发送任务后自动开始`;
  }
}
function clearAuthState() {
  sessionStorage.removeItem("codepilot.authenticated");
  sessionStorage.removeItem("codepilot.auth.token");
  localStorage.removeItem("codepilot.auth.token");
  localStorage.removeItem("codepilot.remembered");
}
function bindAuthentication() {
  const form = $("loginForm");
  if (!form) return;
  const hint = $("loginHint");
  const setHint = (message = "") => { if (hint) hint.textContent = message; };
  let mode = "login";
  const heading = document.querySelector(".login-header h2");
  const subtitle = document.querySelector(".login-header p:last-child");
  const brandTitle = $("authBrandTitle");
  const brandSlogan = $("authBrandSlogan");
  const usernameLabel = $("loginUsernameLabel");
  const usernameInput = $("loginUsername");
  const authContainer = document.querySelector(".auth-container");
  const submit = form.querySelector(".login-btn");
  const registerLink = $("registerButton");
  const forgotLink = $("forgotPasswordButton");
  const formOptions = form.querySelector(".form-options");
  const setSubmitLabel = (label) => {
    if (!submit) return;
    const text = submit.querySelector(".login-btn-text");
    if (text) text.textContent = label;
    else submit.textContent = label;
  };
  const setSubmitState = (loading) => {
    if (!submit) return;
    submit.disabled = loading;
    submit.classList.toggle("is-loading", loading);
    if (loading) {
      submit.setAttribute("aria-busy", "true");
      setSubmitLabel(mode === "register" ? "注册中…" : "登录中…");
    } else {
      submit.setAttribute("aria-busy", "false");
      setSubmitLabel(mode === "register" ? "注册并登录" : "登录");
    }
  };
  const ensureConfirmField = () => {
    let field = $("loginPasswordConfirmField");
    if (!field) {
      field = document.createElement("label");
      field.className = "login-field register-only-field";
      field.id = "loginPasswordConfirmField";
      field.innerHTML = '<span>确认密码</span><div class="login-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><input id="loginPasswordConfirm" type="password" autocomplete="new-password" placeholder="请再次输入密码" /></div>';
      form.insertBefore(field, form.querySelector(".form-options"));
    }
    return field;
  };
  const switchMode = (next) => {
    mode = next;
    const registering = mode === "register";
    [brandTitle, brandSlogan, heading, subtitle].forEach((element) => {
      if (!element) return;
      element.classList.remove("auth-mode-animate");
      void element.offsetWidth;
      element.classList.add("auth-mode-animate");
    });
    if (heading) heading.textContent = registering ? "创建账号" : "欢迎回来";
    if (subtitle) subtitle.textContent = registering ? "注册你的账号，开始使用 NJU CodePilot" : "登录你的账号，继续构建精彩项目";
    if (brandTitle) brandTitle.textContent = registering ? "加入 NJU CodePilot" : "NJU CodePilot";
    if (brandSlogan) brandSlogan.textContent = registering ? "开启智能编程新篇章" : "让每一次编码，都有清晰的路径";
    authContainer?.classList.toggle("register-mode", registering);
    if (usernameLabel) usernameLabel.textContent = registering ? "用户名" : "用户名 / 邮箱";
    if (usernameInput) usernameInput.placeholder = registering ? "请输入用户名" : "请输入用户名或邮箱";
    setSubmitLabel(registering ? "注册并登录" : "登录");
    if (registerLink) registerLink.textContent = registering ? "返回登录" : "立即注册";
    if (forgotLink) forgotLink.hidden = registering;
    if (formOptions) formOptions.hidden = registering;
    const confirm = ensureConfirmField();
    confirm.hidden = !registering;
    $("loginPasswordConfirmField")?.toggleAttribute("hidden", !registering);
    $("loginEmailField")?.toggleAttribute("hidden", !registering);
    const confirmInput = $("loginPasswordConfirm");
    if (confirmInput) confirmInput.required = registering;
    const passwordInput = $("loginPassword");
    if (passwordInput) passwordInput.autocomplete = registering ? "new-password" : "current-password";
    setHint("");
  };
  $("passwordToggle")?.addEventListener("click", (event) => {
    const input = $("loginPassword");
    if (!input) return;
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    event.currentTarget.textContent = visible ? "显示" : "隐藏";
    event.currentTarget.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
  });
  $("forgotPasswordButton")?.addEventListener("click", () => setHint("密码找回请联系系统管理员。"));
  $("registerButton")?.addEventListener("click", () => {
    const next = mode === "register" ? "login" : "register";
    history.pushState({}, "", `/${next}`);
    switchMode(next);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = $("loginUsername")?.value.trim();
    const password = $("loginPassword")?.value || "";
    if (!username || !password) { setHint("请输入用户名和密码。"); return; }
    if (mode === "register" && password !== $("loginPasswordConfirm")?.value) { setHint("两次输入的密码不一致。"); return; }
    setSubmitState(true);
    let result = mode === "register"
      ? await api("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password, email: $("loginEmail")?.value.trim() }), timeout: 15000 })
      : await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }), timeout: 15000 });
    if (result?.ok && mode === "register") result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }), timeout: 15000 });
    if (!result?.ok || !result?.token) {
      setSubmitState(false);
      setHint(result?.error || "无法连接认证服务，请确认后端已启动。");
      return;
    }
    const remember = Boolean($("rememberLogin")?.checked);
    sessionStorage.setItem("codepilot.authenticated", "true");
    sessionStorage.setItem("codepilot.auth.token", result.token);
    // Keep the bearer token across refreshes so account settings and history
    // can be restored. The server token is short-lived and revocable.
    localStorage.setItem("codepilot.auth.token", result.token);
    setSubmitState(false);
    setPersonalCenterUser(result.user);
    history.pushState({}, "", "/agent");
    showAuthenticatedApp();
    if (!agentBooted) { agentBooted = true; bootAgent(); }
  });
  $("personalCenterButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openPersonalCenter();
  });
  $("personalLogoutButton")?.addEventListener("click", logoutAccount);
  $("personalDoneButton")?.addEventListener("click", closePersonalCenter);
  $("closePersonalCenter")?.addEventListener("click", closePersonalCenter);
  $("saveProfileButton")?.addEventListener("click", savePersonalProfile);
  $("savePasswordButton")?.addEventListener("click", savePersonalPassword);
  $("personalCenterModal")?.addEventListener("click", (event) => { if (event.target.matches("[data-close-personal-center]")) closePersonalCenter(); });
  globalThis.__codepilotSwitchAuthMode = switchMode;
  switchMode(location.pathname.toLowerCase() === "/register" ? "register" : "login");
}
async function bootAgent() {
  applySavedTheme();
  // Settings come from the backend .env (loadBackendSettings) and are only
  // mirrored in local storage for layout; never let a stale local copy
  // override the .env defaults on a fresh login or reload.
  await loadBackendSettings();
  // Load persisted workspace
  try {
    const savedWorkspace = localStorage.getItem("codepilot.workspace");
    if (savedWorkspace) {
      state.workspace = savedWorkspace;
    }
  } catch { /* ignore */ }
  
  // 加载持久化的mode
  try {
    const savedMode = localStorage.getItem("codepilot.mode");
    if (savedMode && (savedMode === "plan" || savedMode === "execute")) {
      state.mode = savedMode;
      // 更新UI状态
      $("planModeButton").classList.toggle("active", state.mode === "plan"); 
      $("executeModeButton").classList.toggle("active", state.mode === "execute");
      $("planModeButton").setAttribute("aria-selected", state.mode === "plan"); 
      $("executeModeButton").setAttribute("aria-selected", state.mode === "execute");
      updateComposerContext();
      $("sendButtonLabel").textContent = state.mode === "plan" ? "发送" : "执行";
    }
  } catch { /* ignore */ }
  
  // Always start on a fresh conversation. Persisted sessions remain available
  // through the History button, where the user explicitly chooses one to open.
  state.sessionId = null;
  state.sessionCreatePayload = null;
  bindEvents(); renderWelcome(); state.tree = mockTree; renderTree(); renderPlan(); updatePlanBadge(); setConnection(false); // 移除setMode调用，因为已经从localStorage加载了持久化的mode
  if (state.settings.model && [...$("modelSelect").options].some((option) => option.value === state.settings.model)) setSelectedModel(state.settings.model);
  // The editor is the primary work surface, matching the familiar VS Code
  // arrangement; users can still swap panes with the title-bar control.
  let codeFirst = true;
  try { codeFirst = localStorage.getItem("codepilot.layout") === "code-first"; } catch { /* private browsing */ }
  setLayoutPreference(codeFirst, false);
  await selectFile(state.selectedPath);
  const defaultWorkspace = new URLSearchParams(location.search).get("workspace") || localStorage.getItem("codepilot.workspace") || "";
  const payload = await api(defaultWorkspace
    ? `/api/workspace/tree?root=${encodeURIComponent(defaultWorkspace)}`
    : "/api/workspace/tree");
  if (payload) {
    state.workspace = payload.root || defaultWorkspace || state.workspace;
    state.workspaceName = state.workspaceName || shortPath(state.workspace);
    state.connected = true;
    state.tree = normaliseTree(payload);
    state.collapsedPaths = new Set((state.tree.children || []).filter((entry) => entry.type === "directory").map((entry) => entry.name));
        if ($("testCommand")) $("testCommand").textContent = chooseSmokeCommand(state.tree);
    renderTree();
    setConnection(true);
    // Keep the backend's default workspace in sync with the one the user
    // actually works in, so a later backend restart (dev-runner hot reload)
    // comes back with the same workspace instead of the checkout path.
    if (state.workspace) api("/api/workspace", { method: "PUT", body: JSON.stringify({ workspace: state.workspace }), quiet: true }).catch(() => {});
    const firstCode = collectPaths(state.tree).find((path) => /\.(py|js|ts|jsx|tsx|java|go|rs|c|cpp|h|html|css|md|json|toml)$/i.test(path));
    await selectFile(firstCode || collectPaths(state.tree)[0] || state.selectedPath);
  } else {
    await selectFile(state.selectedPath);
  }
  // Backend is authoritative: periodically pull tree/file changes made by
  // Agent tools or external editors into the browser view.
  if (!window.__codepilotSyncTimer) window.__codepilotSyncTimer = window.setInterval(async () => {
    if (!state.connected || state.previewOnly || state.editorDirty) return;
    await refreshWorkspaceTree();
    if (state.selectedPath) {
      const result = await api(`/api/files/read?root=${encodeURIComponent(state.workspace)}&path=${encodeURIComponent(state.selectedPath)}`, { quiet: true, timeout: 10000 });
      if (result?.content != null && result.content !== state.editorSavedContent) { state.files[state.selectedPath] = result.content; state.savedFiles.set(state.selectedPath, result.content); renderCode(result.content, state.selectedPath); }
    }
  }, 3000);
}
// Backwards-compatible entry point retained for integrations that used the
// original boot() symbol before authentication was introduced.
async function boot() {
  try { state.settings = { ...state.settings, ...JSON.parse(sessionStorage.getItem("codepilot.settings") || localStorage.getItem("codepilot.settings") || "{}") }; } catch { /* ignore malformed session data */ }
  return bootAgent();
}
function renderRoute() {
  const path = (location.pathname || "/login").replace(/\/+$/, "") || "/login";
  const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token");
  const wantsAgent = path === "/agent";
  if (wantsAgent && !token) {
    history.replaceState({}, "", "/login");
    $("authPage")?.removeAttribute("hidden");
    $("appShell")?.setAttribute("hidden", "true");
    document.body.classList.add("auth-screen");
    globalThis.__codepilotSwitchAuthMode?.("login");
    return false;
  }
  if (wantsAgent) {
    showAuthenticatedApp();
    return true;
  }
  if (path !== "/login" && path !== "/register") history.replaceState({}, "", "/login");
  $("authPage")?.removeAttribute("hidden");
  $("appShell")?.setAttribute("hidden", "true");
  document.body.classList.add("auth-screen");
  globalThis.__codepilotSwitchAuthMode?.(location.pathname.toLowerCase() === "/register" ? "register" : "login");
  return false;
}
async function startApplication() {
  bindAuthentication();
  const token = sessionStorage.getItem("codepilot.auth.token") || localStorage.getItem("codepilot.auth.token");
  if (!token) { renderRoute(); return; }
  sessionStorage.setItem("codepilot.auth.token", token);
  const profile = await api("/api/auth/me", { quiet: true });
  if (!profile?.ok) { clearAuthState(); renderRoute(); return; }
  sessionStorage.setItem("codepilot.authenticated", "true");
  setPersonalCenterUser(profile.user);
  await loadBackendSettings();
  if (renderRoute() && !agentBooted) { agentBooted = true; await bootAgent(); }
}
window.addEventListener("popstate", () => { if (renderRoute() && !agentBooted) { agentBooted = true; bootAgent(); } });
startApplication();
