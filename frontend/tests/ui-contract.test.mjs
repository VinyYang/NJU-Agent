import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "..");
const source = async (name) => readFile(resolve(frontend, name), "utf8");

// Return the contents of a CSS block while accounting for nested braces.
// The authentication rules are intentionally kept in plain CSS, but this
// helper makes the contracts resilient to either one-line or pretty-printed
// style declarations.
const cssBlock = (text, selector) => {
  const match = text.match(selector);
  if (!match || match.index === undefined) return "";
  const open = text.indexOf("{", match.index);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return "";
};

const credentialInputIds = new Set([
  "loginUsername",
  "loginEmail",
  "loginPassword",
  "loginPasswordConfirm",
]);

// Inspect the labels in the server-rendered form.  Registration-only labels
// are present in the DOM so the client can switch routes without rebuilding
// the page, but must not count as visible login controls while hidden.
const visibleCredentialIds = (markup) => {
  const ids = [];
  for (const [, attrs = "", body = ""] of markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    if (/\bhidden\b/i.test(attrs) || /\bregister-only-field\b/i.test(attrs)) continue;
    const input = body.match(/<input\b[^>]*\bid=["']([^"']+)["']/i);
    if (input && credentialInputIds.has(input[1])) ids.push(input[1]);
  }
  return ids;
};

test("index exposes a control for swapping chat and code panes", async () => {
  const html = await source("index.html");
  assert.match(html, /id=["'](?:layoutSwapButton|swapLayoutButton)["']/);
  assert.match(html, /(?:对话优先|代码优先|chat-first|code-first)/i);
});

test("index provides an editable code editor without redundant save affordance", async () => {
  const html = await source("index.html");
  assert.match(html, /<textarea[^>]+id=["'](?:codeEditor|codeViewer)["']/i);
  assert.doesNotMatch(html, /id=["'](?:saveCodeButton|saveFileButton)["']/);
  assert.doesNotMatch(html, /class=["'][^"']*read-only-badge[^"']*["'][^>]*>\s*只读/);
});

test("styles define a wide, swappable workspace layout", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.content-grid\.(?:code-first|chat-first)/);
  assert.match(css, /\.code-editor|#codeEditor/);
  assert.match(css, /minmax\(\s*\d{3,}px\s*,\s*1fr\s*\)/);
});

test("app wires layout swapping and persists editor changes locally", async () => {
  const js = await source("app.js");
  assert.match(js, /layoutSwapButton|swapLayoutButton/);
  assert.match(js, /classList\.(?:toggle|add|remove).*\b(?:code-first|chat-first)\b/s);
  // The client deliberately keeps transport details in its small `api`
  // wrapper; accept that wrapper as well as a direct fetch/request call.
  assert.match(js, /(?:api|fetch|request)\([^)]*\/api\/files\/write/s);
  assert.match(js, /method\s*:\s*["']PUT["']/i);
  assert.match(js, /(?:dirty|isDirty)/i);
  assert.match(js, /(?:ctrlKey|metaKey).*KeyS|KeyS.*(?:ctrlKey|metaKey)/s);
});

test("workbench uses a compact VS Code-style shell", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  assert.match(html, /class=["'][^"']*editor-tab-bar/);
  assert.match(html, /class=["'][^"']*workbench-titlebar/);
  assert.match(css, /grid-template-areas:[^;]*workbench/);
  assert.match(css, /--titlebar-height\s*:\s*(?:3[0-9]|4[0-4])px/);
  assert.match(css, /--statusbar-height\s*:\s*(?:2[0-9]|3[0-2])px/);
});

test("agent toolbar and editor header reserve dedicated compact zones", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.agent-toolbar[^}]*gap\s*:/s);
  assert.match(css, /\.mode-switch[^}]*flex-shrink\s*:\s*0/s);
  assert.match(css, /\.model-select[^}]*min-width\s*:/s);
  assert.match(css, /\.editor-header[^}]*min-height\s*:/s);
  assert.match(css, /\.editor-actions[^}]*flex-shrink\s*:\s*0/s);
});

test("shell removes decorative rail and workspace metadata", async () => {
  const html = await source("index.html");
  assert.doesNotMatch(html, /class=["'][^"']*activity-rail/);
  assert.doesNotMatch(html, /class=["'][^"']*workspace-meta/);
});

test("editor chrome and tree controls use dense CSS icons", async () => {
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(css, /\.inspector-tabs[^}]*height\s*:\s*(?:3[0-9]|4[0-2])px/s);
  assert.match(css, /\.editor-header[^}]*min-height\s*:\s*38px/s);
  assert.match(css, /\.node-chevron::before[^}]*border/s);
  assert.doesNotMatch(js, /chevron\.textContent\s*=\s*isFolder/);
});

test("divider follows pointer in both pane orders and context menu supports file operations", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(js, /classList\.contains\(["']code-first["']\)/);
  assert.match(js, /rect\.right\s*-\s*event\.clientX/);
  assert.match(html, /data-context-action=["']copy-file["']/);
  assert.match(html, /data-context-action=["']paste["']/);
  assert.match(html, /data-context-action=["']delete["']/);
  assert.match(js, /\/api\/files\/delete/);
});

test("explorer exposes real create-file and create-folder actions", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']newFileButton["']/);
  assert.match(html, /id=["']newFolderButton["']/);
  assert.doesNotMatch(html, /class=["'][^"']*sidebar-footer/);
  assert.match(js, /newFileButton[\s\S]*addEventListener/);
  assert.match(js, /newFolderButton[\s\S]*addEventListener/);
  assert.match(js, /\/api\/files\/mkdir/);
});

test("context delete refreshes the authoritative workspace tree", async () => {
  const js = await source("app.js");
  assert.match(js, /\/api\/files\/delete/);
  assert.match(js, /await\s+refreshWorkspaceTree\(\)/);
  assert.match(js, /selectedPath\s*===\s*contextPath/);
});

test("empty-file changes do not masquerade as oversized diff", async () => {
  const js = await source("app.js");
  assert.match(js, /change\.diff\s*\?\s*change\.diff/);
  assert.match(js, /additions.*deletions|deletions.*additions/);
  assert.match(js, /无文本内容变更/);
});

test("workspace display name survives backend refresh", async () => {
  const js = await source("app.js");
  assert.match(js, /workspaceName/);
  assert.match(js, /workspaceName\s*\|\|\s*shortPath\(payload\.root\)/);
});

test("review card is reserved for agent mutations", async () => {
  const js = await source("app.js");
  const save = js.match(/async function saveCode[\s\S]*?\n}\n\nfunction joinWorkspace/)?.[0] || "";
  const create = js.match(/async function newFile[\s\S]*?\n}\nasync function newFolder/)?.[0] || "";
  const context = js.match(/if \(action === "delete"\)[\s\S]*?notify\("文件已删除"\)/)?.[0] || "";
  assert.doesNotMatch(save, /renderChangeReview\(/);
  assert.doesNotMatch(create, /renderChangeReview\(/);
  assert.doesNotMatch(context, /renderChangeReview\(/);
});

test("agent run exposes structured metrics in the activity stream", async () => {
  const js = await source("app.js");
  assert.match(js, /metrics/);
  assert.match(js, /tool_calls/);
  assert.match(js, /files_changed/);
  assert.match(js, /duration_ms/);
});

test("frontend surfaces approval-required events instead of hiding policy blocks", async () => {
  const js = await source("app.js");
  assert.match(js, /approval_required/);
  assert.match(js, /需要确认|approval/i);
});

test("shell opens the configured workspace without redundant connection chrome", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.doesNotMatch(html, /class=["'][^"']*workspace-strip/);
  assert.doesNotMatch(html, /id=["']connectionState["']/);
  assert.doesNotMatch(html, /class=["'][^"']*app-statusbar/);
  assert.match(css, /grid-template-areas\s*:\s*["']titlebar["']\s+["']workbench["']/);
  assert.match(js, /api\([`"']\/api\/workspace\/tree/);
});

test("folder picker lives beside the explorer refresh action", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.doesNotMatch(html, /id=["']workspaceChip["']/);
  assert.doesNotMatch(html, /id=["']workspaceLabel["']/);
  assert.match(html, /class=["'][^"']*sidebar-heading[^"']*["'][\s\S]*?id=["']openFolderButton["'][\s\S]*?id=["']refreshTreeButton["']/);
  assert.match(js, /\$\(["']openFolderButton["']\)\.addEventListener\(["']click["']/);
});

test("session history is available and uses the GPT-5 model choices", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.doesNotMatch(html, /id=["']saveCodeButton["']/);
  assert.match(html, /id=["']sessionHistoryButton["']/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.match(html, /GPT-5\.6 Terra/);
  assert.match(html, /GPT-5\.6 Luna/);
  assert.match(html, /GPT-5\.5/);
  assert.match(html, /GPT-5\.2/);
  assert.match(js, /api\(["']\/api\/sessions["']/);
});

test("activity tab is a functional terminal", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']activityTabButton["'][^>]*>终端/);
  assert.match(html, /id=["']terminalInput["']/);
  assert.match(html, /id=["']terminalOutput["']/);
  assert.match(js, /api\(["']\/api\/commands\/run["']/);
  assert.match(js, /terminalInput/);
});

test("editor omits redundant footer", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.doesNotMatch(html, /class=["'][^"']*editor-footer/);
});

test("folder upload shows progress while reading selected files", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']folderProgress["']/);
  assert.match(js, /folderProgress/);
  assert.match(js, /files\.length/);
});

test("folder opening prefers the backend native picker so edits target the real workspace", async () => {
  const js = await source("app.js");
  const openFolder = js.match(/async function openFolder\(\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(openFolder, /state\.connected[\s\S]*\/api\/workspace\/select/);
  assert.match(openFolder, /selected\?\.root|selected\.root/);
  assert.ok(
    openFolder.indexOf("/api/workspace/select") < openFolder.indexOf("showDirectoryPicker"),
    "the real local workspace picker must run before the browser-copy fallback",
  );
  assert.match(openFolder, /window\.showDirectoryPicker/);
  assert.match(js, /folderInput[\s\S]{0,120}\.value\s*=\s*["']["']/);
  assert.match(js, /AbortError/);
  const uploadHandler = js.match(/async function handleFolderSelection[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(uploadHandler, /window\.confirm|confirm\(/);
});

test("native folder picker reopens at the last selected project folder", async () => {
  const js = await source("app.js");
  assert.match(js, /showDirectoryPicker\(\{[^}]*id\s*:\s*["']codepilot-workspace["'][^}]*mode\s*:\s*["']read["']/s);
});

test("folder upload progress uses a visual purple progress bar", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.folder-progress-track[^}]*background/);
  assert.match(css, /\.folder-progress-track span[^}]*linear-gradient/);
  assert.match(css, /\.folder-progress-label[^}]*position/);
});

test("agent toolbar controls keep responsive buttons and normalized icons", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.agent-toolbar-actions \.new-session-button[^}]*clamp\(/s);
  assert.match(css, /\.agent-toolbar-actions \.new-session-button[^}]*clamp\(/s);
  assert.match(css, /\.toolbar-icon[^}]*width:\s*18px/);
});

test("agent toolbar uses one normalized svg icon system", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  assert.match(html, /class=["']toolbar-icon["']/);
  assert.ok((html.match(/class=["']toolbar-icon["']/g) || []).length >= 5);
  assert.match(css, /\.toolbar-icon[^}]*width:\s*18px/);
  assert.match(css, /\.toolbar-icon[^}]*height:\s*18px/);
});

test("toolbar icons share the execute icon's fixed 18px size", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.toolbar-icon[^}]*width:\s*18px[^}]*height:\s*18px/s);
  assert.match(css, /\.agent-toolbar-actions \.new-session-button \.toolbar-icon[^}]*width:\s*18px[^}]*height:\s*18px/s);
});

test("model selector lives in the conversation composer", async () => {
  const html = await source("index.html");
  const composer = html.match(/<div class=["']composer-actions["']>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/section>/)?.[1] || "";
  const toolbar = html.match(/<div class=["']agent-toolbar["']>([\s\S]*?)<\/div>\s*<div class=["']conversation["']/)?.[1] || "";
  assert.match(composer, /id=["']modelSelect["']/);
  assert.doesNotMatch(toolbar, /id=["']modelSelect["']/);
});

test("uploaded workspace folders start collapsed", async () => {
  const js = await source("app.js");
  assert.match(js, /state\.collapsedPaths\s*=\s*new Set/);
  assert.match(js, /type === "directory"/);
});

test("coding task starts in executable mode", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /class=["'][^"']*active[^"']*["'][^>]*id=["']executeModeButton["']/);
  assert.match(js, /mode:\s*["']execute["']/);
  assert.match(js, /streamSessionWorkflow\(\s*["']run["']|sessions\/.*\/run|_run_session/);
});

test("execute turns render model and tool events", async () => {
  const js = await source("app.js");
  assert.match(js, /payload\?\.events|result\?\.events/);
  assert.match(js, /tool_start/);
  assert.match(js, /tool_result/);
});

test("toolbar exposes runtime model settings without embedding credentials", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']settingsButton["']/);
  assert.match(html, /id=["']settingsModal["']/);
  assert.match(html, /id=["']apiKeyInput["']/);
  assert.match(js, /sessionStorage/);
  assert.match(js, /async function boot\(\)[\s\S]*sessionStorage\.getItem\(["']codepilot\.settings["']\)/);
  assert.doesNotMatch(html, /sk-[A-Za-z0-9]{20,}/);
});

test("settings expose an automatic OpenAI wire-protocol fallback", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']wireApiInput["']/);
  assert.match(html, /value=["']auto["']/);
  assert.match(js, /wire_api:\s*state\.settings\.wireApi/);
});

test("API errors are rendered instead of replaced by a demo reply", async () => {
  const js = await source("app.js");
  assert.match(js, /async function api[\s\S]*response\.ok[\s\S]*payload/);
  assert.match(js, /Agent 执行失败/);
  assert.doesNotMatch(js, /extractAssistant\(payload\)[\s\S]{0,160}mockReply\(message\)/);
});

test("SSE transport drops keep streamed clarify progress and avoid double failure banners", async () => {
  const js = await source("app.js");
  assert.match(js, /function isTransportError/);
  assert.match(js, /function describeTransportError/);
  assert.match(js, /streamHadUsefulProgress/);
  assert.match(js, /stream_interrupted/);
  // Failure text is rendered once after the try/catch, not also inside catch.
  assert.doesNotMatch(js, /catch \(error\) \{[\s\S]{0,500}appendMessage\(["']assistant["'],\s*`Agent 执行失败/);
  assert.match(js, /if \(payload\?\.ok === false[\s\S]{0,180}Agent 执行失败/);
});

test("workflow_result ends the SSE reader so clarify turns do not stick on Stop", async () => {
  const js = await source("app.js");
  assert.match(js, /workflow_complete/);
  assert.match(js, /event\?\.type === ["']workflow_result["'][\s\S]{0,180}abort\(["']workflow_complete["']\)/);
  assert.match(js, /stage === ["']intake["'][\s\S]{0,220}"kind"/);
});

test("connected workspaces can intentionally use the backend offline demo", async () => {
  const js = await source("app.js");
  assert.doesNotMatch(js, /if \(!health\?\.model_configured\) \{ notify\("请先在设置中填写 API Key"\); openSettings\(\); return; \}/);
  assert.match(js, /未配置模型密钥[\s\S]{0,180}DemoModel|离线演示/);
});

test("missing account API configuration opens settings before sending a task", async () => {
  const js = await source("app.js");
  assert.match(js, /if \(!state\.settings\.apiKey\) \{[\s\S]{0,220}openSettings\(\);[\s\S]{0,120}return;/);
});

test("clarification other choices provide a required custom input", async () => {
  const js = await source("app.js");
  assert.match(js, /clarification-custom-answer/);
  // The "其他" pill toggles an inline free-text input that submits its value.
  assert.match(js, /otherWrap\.hidden\s*=\s*!isOther/);
  assert.match(js, /custom\.value\.trim\(\)/);
});

test("agent turns allow enough time for reasoning and local tool loops", async () => {
  const js = await source("app.js");
  // Turns are streamed over the SSE endpoint with a 5-minute cap so model
  // reasoning and local tool loops are never cut short mid-stream.
  assert.match(js, /streamSessionWorkflow\(\s*endpoint,[\s\S]{0,900}300000/);
  assert.match(js, /timeout:\s*300000/);
});

test("reasoning effort is configurable and defaults to medium", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']reasoningEffortInput["']/);
  assert.match(html, /option value=["']medium["'][^>]*selected/);
  assert.match(js, /reasoningEffort:\s*["']medium["']/);
  assert.match(js, /reasoning_effort:\s*state\.settings\.reasoningEffort/);
  assert.doesNotMatch(js, /reasoning_effort:\s*["']ultra["']/);
});

test("composer removes hint copy and uses a dedicated model picker without send arrow", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  assert.doesNotMatch(html, /⌘K 建议|本地执行需确认|class=["']send-arrow["']/);
  assert.match(html, /class=["']model-picker["'][\s\S]*id=["']modelSelect["']/);
  assert.match(css, /\.model-picker[^}]*border-radius/);
  assert.match(css, /\.model-select[^}]*appearance:\s*none/);
});

test("model picker is compact and uses a matching custom menu", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']modelPickerButton["']/);
  assert.match(html, /id=["']modelMenu["'][^>]*role=["']listbox["']/);
  assert.ok((html.match(/class=["']model-menu-option["']/g) || []).length >= 5);
  assert.match(css, /\.model-picker[^}]*width:\s*max-content[^}]*min-width:\s*0/s);
  assert.match(css, /\.model-picker-button[^}]*width:\s*auto[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.model-menu[^}]*width:\s*100%/);
  assert.doesNotMatch(css, /\.model-picker\s*\{[^}]*grid-template-columns/);
  assert.match(css, /\.model-menu-option[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.model-menu[^}]*border-radius[^}]*box-shadow/s);
  assert.match(css, /\.model-menu-option\[aria-selected=["']true["']\]/);
  assert.match(html, /class=["']model-picker-icon["']/);
  assert.doesNotMatch(html, /class=["']model-picker-chevron["']/);
  assert.match(js, /function setSelectedModel/);
  assert.match(js, /modelPickerButton/);
});

test("settings provide a direct model connection test", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']testConnectionButton["']/);
  assert.match(js, /async function testModelConnection/);
  assert.match(js, /\/api\/model\/test/);
  assert.match(js, /testConnectionButton.*addEventListener/);
});

test("settings save to the local ignored env file as the default", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  const css = await source("styles.css");
  assert.match(js, /\/api\/settings/);
  assert.match(js, /保存为默认|默认配置/);
  assert.match(html, /settings-section|settings-form/);
  assert.match(css, /\.settings-section[^}]*grid-template-columns/);
  assert.doesNotMatch(js, /OPENAI_API_KEY\s*[:=]\s*["']sk-/);
});

test("settings keep the API key field full width and omit redundant storage note", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  assert.doesNotMatch(html, /class=["'][^"']*settings-note/);
  assert.match(html, /class=["'][^"']*api-key-field[^"']*["'][^>]*>[\s\S]*id=["']apiKeyInput["']/);
  assert.match(css, /\.api-key-field[^}]*grid-column\s*:\s*1\s*\/\s*-1/);
});

test("composer context uses the shared colored 18px svg icon system", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']composerContext["'][\s\S]*<svg[^>]*class=["'][^"']*context-icon[^"']*toolbar-icon/);
  assert.match(css, /\.context-icon[^}]*width:\s*18px[^}]*height:\s*18px[^}]*color:\s*var\(--nj-purple\)/s);
  assert.match(js, /contextIconSvg/);
  assert.doesNotMatch(js, /class=["']context-icon["']>\$\{mode === ["']plan["'] \? ["']◇["'] : ["']▶["']\}/);
});

test("active agent turns can be stopped from the send button", async () => {
  const js = await source("app.js");
  const css = await source("styles.css");
  assert.match(js, /activeRequestController/);
  assert.match(js, /function stopGeneration/);
  assert.match(js, /\/cancel/);
  assert.match(js, /sendButton[\s\S]*is-generating/);
  assert.match(css, /\.send-button\.is-generating/);
});

test("user prompts can be edited and retried as a conversation branch", async () => {
  const js = await source("app.js");
  assert.match(js, /data-message-action/);
  assert.match(js, /edit-user-message/);
  assert.match(js, /editingUserOrdinal/);
  assert.match(js, /const endpoint = editingOrdinal === null \? "turn" : "retry"/);
});

test("session history exposes a dedicated delete action", async () => {
  const js = await source("app.js");
  const css = await source("styles.css");
  assert.match(js, /session-delete-button/);
  assert.match(js, /method:\s*["']DELETE["']/);
  assert.match(css, /\.session-delete-button/);
});

test("session history uses Beijing time and supports select-all bulk deletion", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  const css = await source("styles.css");
  assert.match(html, /session-select-all/);
  assert.match(html, /session-bulk-delete/);
  assert.match(js, /timeZone:\s*["']Asia\/Shanghai["']/);
  assert.match(js, /selectedSessionIds/);
  assert.match(js, /Promise\.allSettled|bulk.*delete|deleteSelectedSessions/i);
  assert.match(js, /session-select-checkbox/);
  assert.match(css, /\.session-history-toolbar|\.session-select-checkbox/);
});

test("agent runs expose a reviewable file-change card with undo", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']changeReviewCard["']/);
  assert.match(html, /id=["']changeReviewFiles["']/);
  assert.match(html, /id=["']reviewChangesButton["']/);
  assert.match(html, /id=["']undoChangesButton["']/);
  assert.match(js, /function renderChangeReview/);
  assert.match(js, /changeReviewCard/);
  assert.match(js, /\/api\/files\/delete/);
  assert.match(js, /before_content/);
  assert.match(js, /renderChangeReview\(extractChanges\(events\)\)/);
  assert.match(js, /renderChangeReview\(extractChanges\(runEvents\)\)/);
  assert.match(js, /delete_file/);
  assert.match(css, /\.change-review-card/);
});

test("two-stage plan workflow uses one scrollable accessible dialog", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']planModal["'][\s\S]*role=["']dialog["'][\s\S]*aria-modal=["']true["']/);
  assert.match(html, /id=["']planClarificationView["']/);
  assert.match(html, /id=["']clarificationQuestions["']/);
  assert.match(html, /id=["']planReviewView["']/);
  assert.match(html, /id=["']submitClarificationButton["']/);
  assert.match(html, /id=["']cancelPlanButton["']/);
  assert.match(html, /aria-busy=["']false["']/);
  assert.match(css, /\.plan-clarification-view, \.plan-review-view[^}]*overflow:\s*auto/s);
  assert.match(css, /\.plan-modal-card[^}]*overflow:\s*hidden/s);
  assert.match(js, /function syncWorkflow/);
  assert.match(js, /function submitClarification/);
  assert.match(js, /expected_plan_version/);
  assert.match(js, /event\.key === ["']Escape["']/);
  assert.match(js, /focusable[\s\S]*event\.key\s*!==\s*["']Tab["']/);
  const opener = js.match(/function openPlanModal\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(opener, /clarifying[\s\S]*intake|intake[\s\S]*clarifying/);
});

test("plan intake is model-driven JSON and renders model-provided choices", async () => {
  const backend = await readFile(resolve(frontend, "..", "backend", "agent_core.py"), "utf8");
  const server = await readFile(resolve(frontend, "..", "backend", "server.py"), "utf8");
  const js = await source("app.js");
  assert.match(backend, /def generate_intake_with_model[\s\S]*parse_intake_response/);
  assert.match(server, /generate_intake_with_model\(task, planner(?:, on_delta=on_delta)?\)/);
  assert.match(js, /question\.choices[\s\S]*clarification-option/);
  assert.match(js, /dataset\.value\s*=\s*["']__other__["']/);
  assert.match(backend, /最多 10 个[\s\S]*只问真正影响实现、相互独立的问题，绝不凑数/);
  assert.match(backend, /用户已经回答过的信息不要重复问/);
  assert.match(backend, /信息足够就直接 kind=plan、ready=true、questions 为空数组/);
});

test("authenticated sessions and settings are restored from the account", async () => {
  const backend = await readFile(resolve(frontend, "..", "backend", "agent_core.py"), "utf8");
  const server = await readFile(resolve(frontend, "..", "backend", "server.py"), "utf8");
  const auth = await readFile(resolve(frontend, "..", "backend", "auth.py"), "utf8");
  const js = await source("app.js");
  assert.match(backend, /owner_id/);
  assert.match(server, /_session_for_user/);
  assert.match(server, /user_settings\(|save_user_settings\(/);
  assert.match(auth, /CREATE TABLE IF NOT EXISTS user_settings/);
  assert.match(js, /api\(["']\/api\/settings["'][\s\S]*state\.settings/);
});

test("execute responses can promote an ambiguous request into the plan dialog", async () => {
  const js = await source("app.js");
  assert.match(js, /createdWorkflow\.phase !== ["']intake["']/);
  assert.match(js, /\["clarifying", "planning", "awaiting_approval"\]/);
  assert.match(js, /setMode\(["']plan["'], \{ persist: false \}\)/);
});

test("replan opener only opens the review modal and modal has an explicit submit action", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']submitReplanButton["']/);
  assert.match(js, /function openReplanEditor\(/);
  assert.match(js, /function submitReplan\(/);
  const binding = js.match(/revisePlanButton[\s\S]{0,260}?addEventListener\([\s\S]*?\);/)?.[0] || "";
  assert.match(binding, /openReplanEditor/);
  assert.doesNotMatch(binding, /\brevisePlan\(\)/);
  const submit = js.match(/async function revisePlan\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(submit, /expected_plan_version/);
  assert.match(submit, /state\.plan[\s\S]*\.map/);
  assert.match(js, /submitReplanButton[\s\S]*addEventListener[\s\S]*submitReplan/);
  const modalRender = js.match(/function renderPlanWorkflowModal\([\s\S]*?\n}/)?.[0] || "";
  assert.match(modalRender, /submitReplanButton/);
  assert.match(modalRender, /disabled\s*=\s*Boolean\(state\.planRequestPending\)/);
});

test("restoring a historical session restores workflow and plan before closing history", async () => {
  const js = await source("app.js");
  const handler = js.match(/open\.addEventListener\(["']click["'][\s\S]*?\n\s*}\);/)?.[0] || "";
  assert.match(handler, /syncWorkflow\(detail/);
  assert.match(handler, /extractPlan\(detail/);
  assert.match(handler, /workflow\.phase|state\.workflow\.phase/);
  assert.match(handler, /setMode\(["']plan["']|state\.mode\s*=\s*["']plan["']/);
  assert.match(handler, /closeSessionHistory\(\)/);
});

test("workspace picker attempts the backend native endpoint even before connected state settles", async () => {
  const js = await source("app.js");
  const openFolder = js.match(/async function openFolder\(\)[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(openFolder, /if\s*\(state\.connected\)\s*\{/);
  assert.match(openFolder, /api\(["']\/api\/workspace\/select["']/);
  assert.match(openFolder, /location\.protocol\s*!==\s*["']file:["']|!location\.protocol\.startsWith\(["']file/);
  assert.match(openFolder, /showDirectoryPicker/);
});

test("opening the plan dialog closes every other application dialog", async () => {
  const js = await source("app.js");
  assert.match(js, /function closeOtherModals\(/);
  const opener = js.match(/function openPlanModal\([\s\S]*?\n}/)?.[0] || "";
  assert.match(opener, /closeOtherModals\(["']planModal["']\)/);
  assert.match(js, /sessionHistoryModal[\s\S]*hidden\s*=\s*true/);
  assert.match(js, /settingsModal[\s\S]*hidden\s*=\s*true/);
  assert.match(js, /changeReviewModal[\s\S]*hidden\s*=\s*true/);
});

test("replanning can be submitted after editing steps even without extra prose feedback", async () => {
  const js = await source("app.js");
  const submit = js.match(/async function revisePlan\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(submit, /feedback[\s\S]*state\.plan[\s\S]*\.map/);
  assert.match(submit, /!feedback[\s\S]*!planPayload|feedback\s*&&\s*!planPayload|planPayload\s*\.length/);
});

test("workflow restoration accepts flat answers and questions from older session snapshots", async () => {
  const js = await source("app.js");
  const extract = js.match(/function extractWorkflow\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(extract, /raw\.answers|session\.answers/);
  assert.match(extract, /raw\.questions|session\.questions/);
  assert.match(extract, /raw\.assumptions|session\.assumptions/);
  assert.match(extract, /questionSources[\s\S]*find\(\(value\) => Array\.isArray\(value\) && value\.length/);
});

test("clarification restoration repopulates the free-form answer draft", async () => {
  const js = await source("app.js");
  const render = js.match(/function renderClarificationView\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(render, /_freeform/);
  assert.match(render, /clarificationAnswerInput[\s\S]*value/);
});

test("browser folder fallback stays in-memory and never creates a hidden backend copy", async () => {
  const js = await source("app.js");
  const importer = js.match(/async function importWorkspaceFiles\([\s\S]*?\n}\n/)?.[0] || "";
  assert.doesNotMatch(importer, /\/api\/workspace\/import/);
  assert.match(importer, /state\.connected\s*=\s*false/);
  assert.match(importer, /只读|预览/);
});

test("workspace chrome keeps browser previews visibly marked as read-only", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.match(html, /id=["']workspaceAccessBadge["']/);
  assert.match(js, /workspaceAccessBadge/);
  assert.match(js, /readonly|只读|预览/i);
});

test("browser preview disables persistence actions instead of pretending edits reach disk", async () => {
  const js = await source("app.js");
  assert.match(js, /previewOnly/);
  const importer = js.match(/async function importWorkspaceFiles\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(importer, /state\.previewOnly\s*=\s*true/);
  const save = js.match(/async function saveCode[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(save, /previewOnly/);
  const create = js.match(/async function newFile[\s\S]*?\n}\nasync function newFolder/)?.[0] || "";
  assert.match(create, /previewOnly/);
  const connection = js.match(/function setConnection\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(connection, /dataset\.defaultTitle/);
});

test("model progress reads like a live work conversation while the request is pending", async () => {
  const js = await source("app.js");
  assert.match(js, /function addThinking\([\s\S]*thinking-live-log/);
  assert.match(js, /aria-live["']?\s*,\s*["']polite["']/);
  assert.match(js, /先看一下项目结构|我先确认入口|接下来我会把改动落到/);
  assert.match(js, /describeAgentEvent[\s\S]*change\.summary|change\.path/);
  assert.match(js, /我已经\$\{operation\}[\s\S]*\$\{path\}/);
  assert.match(js, /增加 \$\{additions\} 行/);
});

test("pane divider can collapse either panel while keeping a draggable rail", async () => {
  const js = await source("app.js");
  const css = await source("styles.css");
  assert.match(js, /chat-collapsed/);
  assert.match(js, /code-collapsed/);
  assert.match(js, /classList\.toggle\(["'](?:chat|code)-collapsed/);
  assert.match(css, /\.content-grid\.chat-first\.code-collapsed/);
  assert.match(css, /\.content-grid\.code-first\.chat-collapsed/);
  assert.match(css, /grid-template-columns:\s*270px[^;]*8px\s+0/);
});

test("code editor keeps one scrollbar and divider never hides it while dragging", async () => {
  const css = await source("styles.css");
  const js = await source("app.js");
  const editorRule = css.match(/\.code-highlight, \.code-editor-wrap \.code-editor\s*\{[^}]*\}/)?.[0] || "";
  assert.match(editorRule, /\.code-highlight|overflow:\s*hidden/);
  assert.match(js, /chat\s*=\s*Math\.max\(minChat,\s*Math\.min\(maxChat,\s*chat\)\)/);
  assert.doesNotMatch(js.match(/divider\.addEventListener\(["']pointermove[\s\S]*?\}\);/)?.[0] || "", /toggle\(["']code-collapsed/);
});

test("code-first divider can dock at the right edge with chat collapsed", async () => {
  const js = await source("app.js");
  assert.match(js, /codeFirst[\s\S]*collapseThreshold[\s\S]*chat-collapsed/);
});

test("historical session restore refreshes workspace and renders persisted transcript", async () => {
  const js = await source("app.js");
  const restore = js.match(/open\.addEventListener\(["']click["'][\s\S]*?closeSessionHistory\(\);/)?.[0] || "";
  assert.match(restore, /restored\.messages|detail\?\.messages/);
  assert.match(restore, /refreshWorkspaceTree/);
  assert.match(restore, /restored\.id\s*\|\|\s*session\.id/);
});

test("agent startup always opens a fresh session instead of restoring persisted history", async () => {
  const js = await source("app.js");
  const startup = js.match(/Always start on a fresh conversation[\s\S]*?bindEvents\(\)/)?.[0] || "";
  assert.match(startup, /state\.sessionId\s*=\s*null/);
  assert.doesNotMatch(startup, /localStorage\.getItem\(["']codepilot\.sessionId["']\)/);
  assert.match(js, /openSessionHistory[\s\S]*api\([`"']\/api\/sessions\//);
});

test("switching layout clears stale collapse state", async () => {
  const js = await source("app.js");
  const setter = js.match(/function setLayoutPreference\([\s\S]*?\n}/)?.[0] || "";
  assert.match(setter, /classList\.remove\(["']chat-collapsed["']\s*,\s*["']code-collapsed["']\)/);
});

test("empty model responses render an actionable visible fallback", async () => {
  const js = await source("app.js");
  assert.match(js, /模型未返回|未返回可显示内容/);
  assert.match(js, /visibleContent\s*=\s*String\(content/);
});

test("agent starts behind a branded NJU purple login page", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']authPage["']/);
  assert.match(html, /id=["']loginForm["']/);
  assert.match(html, /id=["']loginUsername["']/);
  assert.match(html, /id=["']loginPassword["']/);
  assert.match(html, /id=["']appShell["'][^>]*hidden/);
  assert.match(css, /\.auth-page/);
  assert.match(css, /var\(--nj-purple\)|#63065f/);
  assert.match(js, /sessionStorage[\s\S]*codepilot\.authenticated/);
  assert.match(js, /function bootAgent|showAuthenticatedApp/);
  assert.match(js, /loginForm[\s\S]*preventDefault/);
});

test("login page uses real auth endpoints and the avatar opens a personal center", async () => {
  const html = await source("index.html");
  const js = await source("app.js");
  assert.doesNotMatch(html, /<p class=["']branding-footer["'][^>]*>本地优先/);
  assert.match(html, /id=["']personalCenterButton["']/);
  assert.match(html, /id=["']personalCenterModal["']/);
  assert.match(html, /id=["']personalLogoutButton["']/);
  assert.match(html, /id=["']personalAvatar["']/);
  assert.match(js, /\/api\/auth\/(?:login|register)/);
  assert.match(js, /\/api\/auth\/me/);
  assert.match(js, /Authorization[\s\S]*Bearer/);
  assert.match(js, /logout|退出登录/);
});

test("registration mode mirrors the reference layout with optional contact fields and motion", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']loginEmail["']/);
  assert.doesNotMatch(html, /loginPhone/);
  assert.match(html, /id=["']authBrandTitle["']/);
  assert.match(html, /id=["']authBrandSlogan["']/);
  assert.match(css, /@keyframes auth-fade/);
  assert.match(css, /\.auth-container/);
  assert.match(js, /register-mode/);
  assert.match(js, /loginEmail|loginPhone/);
});

test("authentication is split into login, register, and agent routes", async () => {
  const js = await source("app.js");
  assert.match(js, /location\.pathname/);
  assert.match(js, /history\.pushState/);
  assert.match(js, /["']\/login["']/);
  assert.match(js, /["']\/register["']/);
  assert.match(js, /["']\/agent["']/);
  assert.match(js, /popstate/);
});

test("login and registration expose the intended field counts and centered card", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(html, /id=["']loginUsername["'][^>]*placeholder=["'][^"']*(用户名|邮箱)/);
  assert.match(html, /id=["']loginPassword["']/);
  assert.match(html, /register-only-field[\s\S]*id=["']loginEmail["']/);
  assert.match(js, /loginEmailField[\s\S]*toggleAttribute\(["']hidden["'][\s\S]*registering/);
  assert.match(js, /loginPasswordConfirmField[\s\S]*hidden\s*=\s*!registering/);
  assert.match(css, /\.auth-page\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.auth-page\s*\{[^}]*place-items:\s*center/);
});

test("authentication card stays inside the viewport without a nested auth scrollbar", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.auth-container\s*\{[^}]*height:\s*min\([^;]*100vh/);
  assert.match(css, /\.auth-container\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.auth-page\s*\{[^}]*overflow:\s*hidden/);
  const right = cssBlock(css, /\.auth-right\s*\{/i);
  assert.ok(right, "the authentication form pane must be styled");
  assert.doesNotMatch(right, /overflow\s*:\s*auto/i);
});

test("login renders exactly two visible credentials while registration exposes four", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  const form = html.match(/<form\b[^>]*id=["']loginForm["'][\s\S]*?<\/form>/i)?.[0] || "";
  assert.ok(form, "the authentication form must be present");

  // The login route is deliberately limited to account and password.  The
  // optional email label may remain in the DOM, but is hidden until register
  // mode is selected.
  const loginVisible = visibleCredentialIds(form);
  assert.equal(loginVisible.length, 2, `expected 2 visible login fields, got ${loginVisible.join(", ")}`);
  assert.deepEqual(new Set(loginVisible), new Set(["loginUsername", "loginPassword"]));
  assert.match(form, /id=["']loginEmailField["'][^>]*\bhidden\b/i);
  // Author CSS such as `.login-field { display: grid; }` outranks the
  // browser's user-agent `[hidden]` rule.  Keep an explicit override so the
  // optional registration controls do not leak into the login view.
  assert.match(css, /(?:\.login-field|\.register-only-field)\s*\[hidden\][^}]*\{[^}]*display\s*:\s*none(?:\s*!important)?/i);
  assert.doesNotMatch(`${html}\n${js}`, /\bloginPhone\b/i);

  // Registration contributes exactly email (optional) and confirm-password
  // in addition to the two login credentials.  Keep the assertion tied to
  // the logical controls so either server-rendered or lazily-created confirm
  // markup is accepted.
  const confirmFactory = js.match(/ensureConfirmField[\s\S]*?return field;/i)?.[0] || "";
  const authMarkup = `${form}\n${confirmFactory}`;
  const registrationIds = ["loginUsername", "loginEmail", "loginPassword", "loginPasswordConfirm"]
    .filter((id) => new RegExp(`\\bid=["']${id}["']`, "i").test(authMarkup));
  assert.equal(registrationIds.length, 4, `expected 4 registration fields, got ${registrationIds.join(", ")}`);
  assert.match(authMarkup, /loginPasswordConfirm/);
  const emailInput = form.match(/<input\b[^>]*id=["']loginEmail["'][^>]*>/i)?.[0] || "";
  assert.ok(emailInput, "registration email control must exist");
  assert.doesNotMatch(emailInput, /\brequired\b/i, "registration email must stay optional");
  assert.match(js, /loginEmailField[\s\S]{0,220}toggleAttribute\(["']hidden["'][\s\S]*registering/i);
  assert.match(js, /loginPasswordConfirmField[\s\S]{0,220}toggleAttribute\(["']hidden["'][\s\S]*registering/i);
});

test("login and register actions share one full-width button anchor", async () => {
  const css = await source("styles.css");
  const js = await source("app.js");
  assert.match(css, /\.login-btn[^}]*width\s*:\s*100%/i);
  assert.match(css, /\.login-btn[^}]*min-height\s*:\s*48px/si);
  assert.match(css, /@keyframes\s+auth-field-in/);
  assert.match(css, /\.auth-container[^}]*height:\s*min\(620px\s*,\s*calc\(100vh\s*-\s*28px\)/i);
  assert.match(css, /\.auth-mode-animate[^}]*auth-mode-change/);
  assert.match(js, /classList\.remove\(["']auth-mode-animate["']\)[\s\S]*offsetWidth[\s\S]*classList\.add\(["']auth-mode-animate["']\)/);
});

test("small authentication screens hide branding and keep the card width and height adaptive", async () => {
  const css = await source("styles.css");
  const media = cssBlock(css, /@media\s*\(\s*max-width\s*:\s*850px\s*\)\s*\{/i);
  assert.ok(media, "authentication needs an explicit <=850px responsive rule");

  const left = cssBlock(media, /\.auth-left\s*\{/i);
  assert.match(left, /display\s*:\s*none/i);

  const container = cssBlock(media, /\.auth-container\s*\{/i);
  assert.match(container, /height\s*:\s*(?:auto|min\(620px\s*,\s*calc\(100vh\s*-\s*28px\)\))/i);
  assert.match(container, /max-height\s*:\s*none/i);
  assert.match(container, /width\s*:\s*min\(\s*420px\s*,\s*100%\s*\)/i);

  // A fixed-height card plus an auto-scrolling right pane produced a second
  // scrollbar on short registration pages.  The compact card must grow with
  // its form and let the page remain scrollbar-free.
  const right = cssBlock(css, /\.auth-right\s*\{/i);
  assert.ok(right, "the authentication form pane must be styled");
  assert.doesNotMatch(right, /overflow\s*:\s*auto/i);
  const mediaRight = cssBlock(media, /\.auth-right\s*\{/i);
  assert.doesNotMatch(mediaRight, /overflow\s*:\s*auto/i);
});

test("authentication submit exposes an accessible loading state with motion", async () => {
  const html = await source("index.html");
  const css = await source("styles.css");
  const js = await source("app.js");
  const submit = html.match(/<button\b[^>]*class=["'][^"']*\blogin-btn\b[^"']*["'][^>]*>/i)?.[0] || "";
  assert.ok(submit, "the login/register submit button must be present");
  assert.match(submit, /aria-busy=["']false["']/i);

  // Both routes share one submit handler; mark the control busy while the
  // request is pending and always restore it after success or failure.
  assert.match(js, /submit[\s\S]{0,220}classList\.(?:add|toggle)\(["'](?:is-loading|loading)["']/i);
  assert.match(js, /submit[\s\S]{0,260}setAttribute\(["']aria-busy["']\s*,\s*["']true["']\)/i);
  assert.match(js, /submit[\s\S]{0,500}setAttribute\(["']aria-busy["']\s*,\s*["']false["']\)/i);
  assert.match(css, /\.login-btn\.(?:is-loading|loading)[^}]*animation\s*:/i);

  // The branded copy should retain the reference's entrance motion as well;
  // this catches regressions where a responsive refactor strips the animated
  // heading/slogan while adding the loading indicator.
  assert.match(css, /\.branding-content\s+h1[^}]*animation\s*:/i);
  assert.match(css, /\.slogan[^}]*animation\s*:/i);
  assert.match(css, /@keyframes\s+auth-(?:fade|float)/i);
});
