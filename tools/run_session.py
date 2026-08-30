"""Approve then run a session with the real model; print events as they stream via SSE."""
import json
import sys
import time
import urllib.request

sid = sys.argv[1] if len(sys.argv) > 1 else "18d1ba24366c4fc29f27aadeb61513ef"
env = {}
for line in open(r"C:\Users\viny\Desktop\AAA-MIS\21.考核内容存档\NJU-SE\.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

body = {
    "max_steps": 24,
    "api_key": env["OPENAI_API_KEY"],
    "base_url": env["OPENAI_BASE_URL"],
    "model": env["CODING_AGENT_MODEL"],
    "wire_api": env.get("MODEL_WIRE_API", "auto"),
    "reasoning_effort": env.get("MODEL_REASONING_EFFORT", "medium"),
}
req = urllib.request.Request(
    "http://127.0.0.1:8124/api/sessions/%s/run" % sid,
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
start = time.time()
try:
    with urllib.request.urlopen(req, timeout=1800) as r:
        data = json.loads(r.read().decode("utf-8"))
except Exception as e:
    print("ERR", e)
    if hasattr(e, "read"):
        print(e.read().decode("utf-8", errors="replace")[:3000])
    sys.exit(1)
elapsed = time.time() - start
print("elapsed %.1fs" % elapsed)
result = data.get("result", data)
print("status:", result.get("status"))
print("metrics:", json.dumps(result.get("metrics", {}), ensure_ascii=False))
print("message:\n%s" % (result.get("message") or "")[:4000])
print("\nEVENTS:")
for ev in result.get("events", []):
    t = ev["type"]
    if t == "tool_start":
        print("[%s] tool_start %s args=%s" % (ev.get("step"), ev.get("name"), json.dumps(ev.get("arguments", {}), ensure_ascii=False)[:250]))
    elif t == "tool_result":
        res = ev.get("result", {})
        print("[%s] tool_result %s ok=%s path=%s cmd=%s exit=%s err=%s" % (
            ev.get("step"), ev.get("name"), res.get("ok"), res.get("path", ""),
            str(res.get("command", ""))[:60], res.get("exit_code"), str(res.get("error", ""))[:120]))
    elif t in ("assistant", "completed", "halted", "error", "validation_required", "approval_required", "retry"):
        print("[%s] %s: %s" % (ev.get("step", "-"), t, str(ev.get("content") or ev.get("message") or ev.get("reason") or "")[:400]))
    elif t == "phase_changed":
        print("phase_changed %s -> %s" % (ev.get("from"), ev.get("to")))
# save full response
out = r"C:\Users\viny\Desktop\AAA-MIS\21.考核内容存档\DailyTasksPlay_run_result.json"
try:
    open(out, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
    print("saved:", out)
except Exception as e:
    print("save failed", e)
