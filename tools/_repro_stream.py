"""Temporary repro: streamed session creation against an unreachable gateway."""
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

server = create_server("127.0.0.1", 8138)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
time.sleep(0.3)

body = json.dumps({
    "workspace": ROOT,
    "task": "Add a health check endpoint and give me an editable plan",
    "mode": "plan",
    "api_key": "test-only-invalid",
    "base_url": "https://127.0.0.1:1/v1",
    "model": "gpt-5.6-sol",
}).encode("utf-8")
req = urllib.request.Request(
    "http://127.0.0.1:8138/api/sessions/stream",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
started = time.monotonic()
try:
    with urllib.request.urlopen(req, timeout=25) as response:
        raw = response.read().decode("utf-8")
    print("elapsed %.1fs" % (time.monotonic() - started))
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
            print(ev, str(data)[:160])
except Exception as exc:
    print("CLIENT ERROR %.1fs: %r" % (time.monotonic() - started, exc))
finally:
    server.shutdown()
