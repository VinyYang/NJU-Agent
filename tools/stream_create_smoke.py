"""Smoke test for the streamed session-create SSE contract (no real key)."""
import json
import os
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.server import create_server

server = create_server("127.0.0.1", 8137)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
time.sleep(0.3)

body = json.dumps({
    "workspace": "C:/Users/viny/Desktop/AAA-MIS/21.考核内容存档/NJU-SE",
    "task": "Add a health check endpoint and give me an editable plan",
    "mode": "plan",
    "api_key": "test-only-invalid",
    "base_url": "https://127.0.0.1:1/v1",  # unreachable -> provider error path
    "model": "gpt-5.6-sol",
}).encode("utf-8")
req = urllib.request.Request(
    "http://127.0.0.1:8137/api/sessions/stream",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
events = []
with urllib.request.urlopen(req, timeout=30) as response:
    raw = response.read().decode("utf-8")
    for frame in raw.split("\n\n"):
        lines = [line for line in frame.splitlines() if line]
        if not lines:
            continue
        ev = None
        payload_lines = []
        for line in lines:
            if line.startswith("event:"):
                ev = line[len("event:"):].strip()
            elif line.startswith("data:"):
                payload_lines.append(line[len("data:"):].strip())
        if ev:
            try:
                data = json.loads("\n".join(payload_lines)) if payload_lines else {}
            except json.JSONDecodeError:
                data = {"raw": "\n".join(payload_lines)}
            events.append((ev, data))

print("SSE event types:", [ev for ev, _ in events])
assert events[0][0] == "workflow_started", events[:2]
assert any(ev == "error" for ev, _ in events), "expected provider error frame"
assert events[-1][0] == "done", "expected terminal done frame"
print("SMOKE OK: %d frames" % len(events))
server.shutdown()
