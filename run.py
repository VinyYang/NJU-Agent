"""Cross-platform development runner with backend hot reload.

Run with `python run.py`. It watches the current checkout and restarts
the backend when Python files change. The frontend is served by that backend,
so a normal browser refresh picks up HTML/CSS/JS changes immediately.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.getenv("AGENT_PORT", "8124"))
# Follow the folder the user launched the dev runner from, so opening another
# project folder and starting the agent there moves the workspace with it.
# AGENT_WORKSPACE stays the explicit override; when launched from inside this
# checkout the backend keeps its persisted/UI-picker workspace instead.
WORKSPACE = Path(os.getenv("AGENT_WORKSPACE", str(Path.cwd()))).expanduser().resolve()


def fingerprint(folder: Path, suffixes: set[str]) -> tuple[tuple[str, int, int], ...]:
    files = []
    if not folder.exists():
        return tuple()
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix in suffixes:
            try:
                stat = path.stat()
                files.append((str(path.relative_to(ROOT)), stat.st_mtime_ns, stat.st_size))
            except OSError:
                pass
    return tuple(sorted(files))


def healthy() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1) as response:
            return response.status == 200
    except Exception:
        return False


def active_streams() -> int:
    """Number of in-flight model SSE turns on the running backend.

    The backend counts bare model proxy streams and session feeds/clarify/plan
    stream actions; the dev runner uses this to avoid restarting underneath an
    active conversation turn.
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1) as response:
            data = json.loads(response.read().decode("utf-8") or "{}")
            return int(data.get("active_streams", 0) or 0)
    except Exception:
        return 0


def main() -> int:
    print(f"CodePilot dev runner: {ROOT}")
    print(f"Workspace: {WORKSPACE}")
    print("Watching backend/*.py for restarts. Frontend HTML/CSS/JS hot-reloads on browser refresh.")
    print("Press Ctrl+C to stop.")
    process = None
    # Only Python backend changes should kill the process.  Restarting on
    # frontend edits used to tear down in-flight SSE turns mid-clarify and
    # surface a cryptic browser ``network error`` in the chat UI.
    previous_backend = fingerprint(ROOT / "backend", {".py"})
    # Restart requests are deferred while a model SSE turn is in flight AND
    # for a short idle grace window afterwards, so an editing session never
    # interrupts an active clarify / plan / run — including the brief gap
    # between the intake turn finishing and the frontend issuing its separate
    # plan request.  Multiple rapid saves are also debounced into one restart.
    pending_change = False      # backend sources changed, restart needed
    last_change_seen = 0.0      # when the most recent change was observed
    restart_armed = False       # changes settled; waiting for an idle window
    idle_since = 0.0            # when the backend last had zero active turns
    stable_delay = 1.5          # seconds of no new saves before restarting
    idle_grace = 4.0            # seconds of zero active turns before restarting
    forced_timeout = 600.0      # give an active turn generous time, then restart anyway
    opened = False
    try:
        while True:
            if process is None or process.poll() is not None:
                if process is not None:
                    print("Backend exited; restarting...")
                process = subprocess.Popen([sys.executable, "-m", "backend", "--host", "127.0.0.1", "--port", str(PORT), "--workspace", str(WORKSPACE)], cwd=ROOT)
                for _ in range(40):
                    if healthy():
                        if not opened:
                            webbrowser.open(f"http://127.0.0.1:{PORT}/agent?dev={time.time_ns()}")
                            opened = True
                        break
                    time.sleep(.25)
                pending_change = False
                restart_armed = False
                idle_since = 0.0
            current_backend = fingerprint(ROOT / "backend", {".py"})
            if current_backend != previous_backend:
                previous_backend = current_backend
                last_change_seen = time.time()
                restart_armed = False
                if not pending_change:
                    pending_change = True
                    print("Backend source changed; waiting for saves to settle before restart...")
            if pending_change and process is not None and process.poll() is None:
                settled = time.time() - last_change_seen >= stable_delay
                if settled and not restart_armed:
                    restart_armed = True
                    idle_since = 0.0
                    print("Backend changes settled; waiting for model turns to finish before restart...")
                idle = False
                if restart_armed:
                    if active_streams() > 0:
                        idle_since = 0.0
                    else:
                        if idle_since == 0.0:
                            idle_since = time.time()
                        idle = time.time() - idle_since >= idle_grace
                forced = time.time() - last_change_seen >= forced_timeout
                if idle or forced:
                    if forced and not idle:
                        print(f"Active model turn still running after {int(forced_timeout)}s; forcing restart.")
                    else:
                        print("Restarting API...")
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    pending_change = False
                    restart_armed = False
                    idle_since = 0.0
            time.sleep(.4)
    except KeyboardInterrupt:
        return 0
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
