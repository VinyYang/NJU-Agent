"""Dump a session's events from the running server."""
import json
import sys
import urllib.request

sid = sys.argv[1] if len(sys.argv) > 1 else "e29005705e784d8287f0e949ff248010"
req = urllib.request.Request("http://127.0.0.1:8124/api/sessions/" + sid)
with urllib.request.urlopen(req, timeout=30) as r:
    d = json.loads(r.read().decode())
sess = d["session"]
print("phase:", sess["workflow"]["phase"])
print("plan.status:", sess["plan"]["status"], "revision:", sess["plan_version"])
print("last_message:", sess["last_message"][:800])
print("--- events ---")
for ev in sess["events"]:
    t = ev["type"]
    if t in ("tool_start", "tool_result"):
        res = ev.get("result", {})
        extra = ""
        if ev.get("name") == "run_command":
            extra = "cmd=%s exit=%s blocked=%s" % (str(res.get("command", ""))[:80], res.get("exit_code"), res.get("blocked"))
        else:
            extra = "path=%s" % res.get("path", "")
        print("[%s] %s %s ok=%s %s" % (ev.get("step"), t, ev.get("name"), res.get("ok"), extra))
    elif t in ("assistant", "completed", "halted", "error", "validation_required", "approval_required"):
        print("[%s] %s: %s" % (ev.get("step", "-"), t, str(ev.get("content") or ev.get("message") or ev.get("reason") or "")[:400]))
    elif t == "run_finished":
        res = ev.get("result", {})
        print("run_finished status:", res.get("status"), "metrics:", json.dumps(res.get("metrics", {}), ensure_ascii=False))
    elif t in ("phase_changed", "plan_generated", "plan_approved", "plan_revised"):
        print("%s %s" % (t, json.dumps(ev, ensure_ascii=False)[:400]))
