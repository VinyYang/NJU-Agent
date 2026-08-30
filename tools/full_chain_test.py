"""
Full real-model chain test for CodePilot.

Passes model credentials in every request body (as the real UI does), so the
backend builds an OpenAICompatibleModel against xcpcai.com / gpt-5.6-sol.
Workflow: create session -> clarify (if needed) -> plan -> approve -> run -> verify.
"""
import json
import time
import urllib.request
import urllib.error
import pathlib
import sys
import os

BASE = "http://127.0.0.1:8124"
WORKSPACE = os.path.join(os.environ.get("NJU_SE_ROOT", r"C:\Users\viny\Desktop\AAA-MIS\21.考核内容存档"), "DailyTasksPlay")
TASK = ("设计一个项目，实现每日任务记录，让用户可以记录当天想完成的事情，并在页面上直观看到完成进度。"
        "要求：1) 使用纯 HTML/CSS/JS，无需构建工具直接浏览器打开即可使用；"
        "2) 数据保存在本地 localStorage；3) 页面美观现代，使用南大紫 (#63065F) 主色调；"
        "4) 所有文件放在 DailyTasksPlay 目录下。")

# Load keys from the local .env (never print or persist them)
def _load_env(path):
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

_load_env(pathlib.Path(__file__).resolve().parent.parent / ".env")

API_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("MODEL_API_KEY")
BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://xcpcai.com/v1")
MODEL = os.environ.get("CODING_AGENT_MODEL", "gpt-5.6-sol")
WIRE = os.environ.get("MODEL_WIRE_API", "auto")
EFFORT = os.environ.get("MODEL_REASONING_EFFORT", "medium")

CONFIG = {
    "api_key": API_KEY,
    "base_url": BASE_URL,
    "model": MODEL,
    "wire_api": WIRE,
    "reasoning_effort": EFFORT,
}


def api(method, path, body=None, timeout=240):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            j = json.loads(raw)
        except Exception:
            j = {"raw": raw[:3000]}
        return e.code, j
    except Exception as e:
        return 0, {"error": str(e), "type": type(e).__name__}


def print_section(title):
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def fetch_session(sid, timeout=30):
    s, r = api("GET", "/api/sessions/%s" % sid, timeout=timeout)
    return r.get("session", r)


def dump_events(events):
    for ev in events:
        t = ev.get("type")
        if t in ("tool_start", "tool_result"):
            name = ev.get("name")
            res = ev.get("result", {})
            print("  [%s] %s %s ok=%s path=%s %s" % (
                ev.get("step"), t, name, res.get("ok"), res.get("path", ""),
                json.dumps(res, ensure_ascii=False)[:500] if t == "tool_result" else json.dumps(ev.get("arguments", {}), ensure_ascii=False)[:300]))
        elif t in ("assistant", "completed", "halted", "error", "validation_required", "approval_required"):
            print("  [%s] %s: %s" % (ev.get("step", "-"), t, str(ev.get("content") or ev.get("message") or ev.get("reason") or "")[:600]))
        elif t in ("phase_changed",):
            print("  %s %s -> %s (%s)" % (t, ev.get("from"), ev.get("to"), ev.get("reason")))


# ---------- 0. workspace ----------
ws = pathlib.Path(WORKSPACE)
ws.mkdir(parents=True, exist_ok=True)
print("Workspace: %s (exists=%s) files=%s" % (ws, ws.exists(), [p.name for p in ws.iterdir()][:10]))
print("Model: %s via %s wire=%s effort=%s" % (MODEL, BASE_URL, WIRE, EFFORT))

# ---------- 1. create session (WITH model config in body) ----------
print_section("STEP 1: 创建会话 (POST /api/sessions)")
payload = dict(CONFIG)
payload.update({"workspace": WORKSPACE, "task": TASK, "mode": "plan"})
status, resp = api("POST", "/api/sessions", payload, timeout=300)
print("HTTP %s" % status)
print(json.dumps(resp, ensure_ascii=False, indent=2)[:3000])
session_id = resp.get("session_id") or resp.get("session", {}).get("id")
if not session_id:
    print("No session id"); sys.exit(1)
print(">>> Session ID: %s" % session_id)
wf = resp.get("workflow", {})
print(">>> Phase: %s next_action: %s" % (wf.get("phase"), wf.get("next_action")))
print(">>> route_decision: %s" % json.dumps(wf.get("route_decision"), ensure_ascii=False))
# Check if plan was model-generated
for ev in (resp.get("session", {}).get("events", [])):
    if ev.get("type") == "plan_generated":
        print(">>> plan_generated source: %s" % ev.get("source"))
if status >= 400:
    sys.exit("FAILED create")

# ---------- 2. clarification loop ----------
max_rounds = 6
for rnd in range(max_rounds):
    s = fetch_session(session_id)
    phase = s.get("workflow", {}).get("phase")
    print("\n[clarify] round %d phase=%s" % (rnd + 1, phase))
    if phase != "clarifying":
        break
    intake = s.get("workflow", {}).get("intake", {})
    questions = intake.get("questions", [])
    print("  questions: %s" % json.dumps(questions, ensure_ascii=False)[:2000])
    answers = {}
    for q in questions:
        qid = q.get("id", "")
        text = q.get("text", "")
        if "target" in qid or "文件" in text or "模块" in text or "路径" in text:
            answers[qid] = "在 DailyTasksPlay 目录下新建独立项目：index.html + style.css + app.js"
        elif "login" in qid or "行为" in text or "登录" in text:
            answers[qid] = "单用户本地使用，不需要登录认证"
        elif "acceptance" in qid or "验收" in text or "测试" in text:
            answers[qid] = "直接打开 index.html 可增删改查任务、勾选完成、实时看到进度条和统计即可，无需额外测试命令"
        elif "safety" in qid or "环境" in text or "数据" in text:
            answers[qid] = "本地静态页面，数据只存 localStorage，不涉及数据库/生产环境"
        elif "constraints" in qid or "约束" in text:
            answers[qid] = "无额外约束，保持简洁美观现代，南大紫 #63065F 主色调，响应式"
        else:
            answers[qid] = "按最佳实践实现即可" if not q.get("required") else "按最佳实践实现每日任务记录功能"
    send = dict(CONFIG)
    send.update({"message": "补充需求信息如下", "answers": answers})
    st2, r2 = api("POST", "/api/sessions/%s/turn" % session_id, send, timeout=300)
    print("  turn HTTP %s" % st2)
    print("  -> %s" % json.dumps(r2, ensure_ascii=False)[:1200])
    if st2 >= 400:
        print("  turn failed; freeform fallback")
        send = dict(CONFIG)
        send.update({"message": "在 DailyTasksPlay 目录用纯 HTML/CSS/JS 实现每日任务记录，localStorage 存储，南大紫主题，美观现代，浏览器直接打开可用。"})
        st2b, r2b = api("POST", "/api/sessions/%s/turn" % session_id, send, timeout=300)
        print("  fallback HTTP %s -> %s" % (st2b, json.dumps(r2b, ensure_ascii=False)[:800]))
        if st2b >= 400:
            break
    time.sleep(0.5)

# ---------- 3. plan ----------
print_section("STEP 2: 检查 Plan")
s = fetch_session(session_id)
phase = s.get("workflow", {}).get("phase")
print("phase=%s plan_revision=%s" % (phase, s.get("workflow", {}).get("plan_revision")))
for ev in s.get("events", []):
    if ev.get("type") == "plan_generated":
        print("plan_generated source=%s revision=%s" % (ev.get("source"), ev.get("plan_revision")))
plan = s.get("plan", {})
print("plan status=%s" % plan.get("status"))
for i, st in enumerate(plan.get("steps", []), 1):
    print("  %d. %s [%s]" % (i, st.get("title"), st.get("status")))
if phase not in ("awaiting_approval", "approved"):
    print("WARN unexpected phase %s" % phase)
    print(json.dumps(s.get("workflow", {}), ensure_ascii=False)[:2000])
    dump_events(s.get("events", []))
    if phase in ("completed", "failed", "error", "cancelled", "needs_validation"):
        sys.exit("Session already terminal")

# ---------- 4. approve ----------
if phase == "awaiting_approval":
    print_section("STEP 3: 审批 Plan")
    rev = s.get("workflow", {}).get("plan_revision", 1)
    st3, r3 = api("POST", "/api/sessions/%s/plan/approve" % session_id, {"expected_plan_version": rev}, timeout=30)
    print("approve HTTP %s -> %s" % (st3, json.dumps(r3, ensure_ascii=False)[:1000]))
    if st3 >= 400:
        sys.exit("approve failed")
    s = fetch_session(session_id)
    print("after approve phase=%s plan.status=%s" % (s.get("workflow", {}).get("phase"), s.get("plan", {}).get("status")))

# ---------- 5. run ----------
print_section("STEP 4: 执行 Agent 循环 (POST /api/sessions/%s/run)" % session_id)
send = dict(CONFIG)
send.update({"max_steps": 24})
st4, r4 = api("POST", "/api/sessions/%s/run" % session_id, send, timeout=1800)
print("HTTP %s" % st4)
out_path = ws.parent / "DailyTasksPlay_run_result.json"
try:
    out_path.write_text(json.dumps(r4, ensure_ascii=False, indent=2), encoding="utf-8")
    print("run result saved: %s" % out_path)
except Exception as e:
    print("save failed: %s" % e)
result = r4.get("result", r4)
print("status=%s" % result.get("status"))
print("message:\n%s" % result.get("message", "")[:4000])
print("\nEVENTS:")
dump_events(result.get("events", []))
print("\nmetrics: %s" % json.dumps(result.get("metrics", {}), ensure_ascii=False))

s = fetch_session(session_id)
print("\nFINAL phase=%s plan.status=%s" % (s.get("workflow", {}).get("phase"), s.get("plan", {}).get("status")))
print("last_message=%s" % s.get("last_message", "")[:500])

# ---------- 6. verify files ----------
print_section("STEP 5: 验证生成的文件")
files = []
for p in ws.rglob("*"):
    if p.is_file():
        files.append((str(p.relative_to(ws)).replace("\\", "/"), p.stat().st_size))
files.sort()
print("workspace files (%d):" % len(files))
for rel, sz in files:
    print("  %s (%d bytes)" % (rel, sz))
if not files:
    print("!!! No files generated by agent")
else:
    idx = ws / "index.html"
    if idx.exists():
        c = idx.read_text(encoding="utf-8", errors="replace")
        print("\nindex.html begins:\n%s" % c[:1500])
print("\n{'ok': True, 'session_id': '%s', 'phase': '%s'}" % (session_id, s.get("workflow", {}).get("phase")))