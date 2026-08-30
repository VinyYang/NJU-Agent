"""Dependency-free HTTP API for the coding-agent UI.

Run with ``python -m backend``.  The server intentionally uses only the
standard library so the project can be demonstrated on a fresh machine.  It
serves JSON under ``/api`` and leaves presentation to the frontend app.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import queue
import re
import sys
import threading
import time
import traceback
import uuid
import urllib.parse
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .agent_core import (
    LocalTools,
    OpenAICompatibleModel,
    PlanConflictError,
    PlanState,
    RunResult,
    _wf_log,
    generate_intake_with_model,
    generate_plan_with_model,
)
from .session import Session, SessionManager
from .intake import classify_request, clarification_questions, local_reply, RouteDecision
from .auth import AuthError, AuthStore
from .config import load_local_env, get_current_settings, write_local_settings, _settings_env_path, resolve_api_key
_load_local_env = load_local_env
from .utils import json_bytes, user_text, path_parts, nested_tree, plan_value_to_markdown

# Load local environment on module import
load_local_env()

# Browser / DevTools probes that are not part of the product surface.
_QUIET_PROBE_ROUTES = {
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/.well-known/appspecific/com.chrome.devtools.json",
}

# Track in-flight model/proxy SSE streams so the dev runner can avoid
# restarting the backend underneath an active clarify / plan / run turn.
_stream_lock = threading.Lock()
_active_streams = 0


def _stream_opened() -> None:
    global _active_streams
    with _stream_lock:
        _active_streams += 1


def _stream_closed() -> None:
    global _active_streams
    with _stream_lock:
        _active_streams = max(0, _active_streams - 1)


def _active_stream_count() -> int:
    with _stream_lock:
        return _active_streams


# Persisted "last selected workspace".  Stored next to the checkout so both
# the dev runner and the server agree on a single default even after a frontend
# workspace pick that the server would otherwise never learn about.  This keeps
# the backend default aligned with the workspace the user actually works in.
_WORKSPACE_FILE = Path(__file__).resolve().parent.parent / ".codepilot-workspace"


def _valid_workspace(path: str) -> Optional[str]:
    try:
        candidate = Path(path).expanduser().resolve()
        if candidate.is_dir():
            return str(candidate)
    except OSError:
        pass
    return None


def _persist_workspace(path: str) -> str:
    resolved = _valid_workspace(path) or str(Path(path).expanduser().resolve())
    try:
        _WORKSPACE_FILE.write_text(resolved, encoding="utf-8")
    except OSError:
        pass
    return resolved


def _persisted_workspace() -> Optional[str]:
    try:
        if _WORKSPACE_FILE.exists():
            text = _WORKSPACE_FILE.read_text(encoding="utf-8").strip()
            if text:
                return _valid_workspace(text)
    except OSError:
        pass
    return None


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """Threading HTTP server that stays quiet on routine client disconnects."""

    def handle_error(self, request: Any, client_address: Any) -> None:
        err = sys.exc_info()[1]
        if isinstance(err, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        if isinstance(err, OSError) and getattr(err, "winerror", None) in {10053, 10054}:
            return
        super().handle_error(request, client_address)


class AgentRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    """HTTP request handler.  ``manager`` is attached by ``create_server``."""

    server_version = "NJU-Coding-Agent/0.1"
    manager: SessionManager
    auth_store: AuthStore
    frontend_root: Optional[Path] = None
    picker_jobs: Dict[str, Dict[str, Any]] = {}
    picker_lock = threading.RLock()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003 - BaseHTTPRequestHandler API
        """Only print failed HTTP requests unless verbose access logging is enabled."""
        message = format % args
        # Favicon / DevTools probes are answered with 204; keep them out of
        # the console even if an older client still receives a 404.
        if any(token in message for token in ("favicon.ico", ".well-known/", "apple-touch-icon")):
            return
        match = re.search(r"\s(\d{3})\s", message)
        status = int(match.group(1)) if match else 0
        if status < 400 and os.getenv("AGENT_VERBOSE_HTTP", "").lower() not in {"1", "true", "yes"}:
            return
        prefix = "HTTP ERROR" if status >= 400 else "HTTP"
        print("[%s] %s: %s" % (self.log_date_time_string(), prefix, message), flush=True)

    @staticmethod
    def _console_model_message(message: Any) -> None:
        """Write user-facing model text to the terminal without dumping payloads."""
        text = str(message or "").strip()
        if text:
            print("[模型] " + text, flush=True)

    def _send(self, status: int, payload: Any, content_type: str = "application/json; charset=utf-8") -> None:
        body = payload if isinstance(payload, bytes) else json_bytes(payload)
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", os.getenv("AGENT_CORS_ORIGIN", "*"))
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            # Clients may cancel while a native folder picker is open.
            # There is no response left to send, but the server must remain
            # healthy for subsequent requests.
            return

    def _error(self, status: int, message: str, details: Optional[Any] = None) -> None:
        payload: Dict[str, Any] = {"ok": False, "error": user_text(message)}
        if details is not None:
            if isinstance(details, dict):
                details = {key: (user_text(value) if key in {"message", "error", "reason"} else value) for key, value in details.items()}
            payload["details"] = details
        self._send(status, payload)

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > 16 * 1024 * 1024:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("body must be valid JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def _query(self) -> Dict[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        return {key: (items[-1] if items else "") for key, items in values.items()}

    def _auth_token(self) -> str:
        value = self.headers.get("Authorization", "")
        return value[7:].strip() if value.lower().startswith("bearer ") else ""

    def _current_user(self) -> Optional[Dict[str, object]]:
        return self.auth_store.user_for_token(self._auth_token())

    def _session_for_user(self, session_id: str) -> Session:
        session = self.manager.get(session_id)
        user = self._current_user()
        if user and session.owner_id != int(user["id"]):
            raise KeyError(session_id)
        return session

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send(HTTPStatus.NO_CONTENT, b"")

    def _serve_frontend(self, route: str) -> bool:
        """Serve bundled static UI files without allowing path traversal."""
        root = self.frontend_root
        if root is None:
            return False
        relative = route.lstrip("/") or "index.html"
        candidate = (root / relative).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            self._error(HTTPStatus.NOT_FOUND, "resource not found")
            return True
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.exists() or not candidate.is_file():
            # This is a single-page UI; unknown non-API routes fall back to the
            # shell so refreshing a client-side link remains useful.
            if "." not in Path(relative).name:
                candidate = (root / "index.html").resolve()
            else:
                return False
        try:
            body = candidate.read_bytes()
        except OSError:
            return False
        if len(body) > 16 * 1024 * 1024:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "resource is too large")
            return True
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json", "image/svg+xml"}:
            content_type += "; charset=utf-8"
        self._send(HTTPStatus.OK, body, content_type)
        return True

    def do_PATCH(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        """Update lightweight session preferences (currently mode only)."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            body = self._read_json()
            parts = path_parts(route)
            if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
                session = self._session_for_user(parts[2])
                mode = body.get("mode")
                if mode is not None:
                    # A session that is still collecting requirements or
                    # showing a draft plan cannot be re-labelled through the
                    # legacy mode toggle.  Otherwise PATCH(plan/clarify ->
                    # execute) would provide a direct path around approval.
                    if session.phase in {"clarifying", "planning", "replanning", "awaiting_approval"}:
                        self._error(
                            HTTPStatus.CONFLICT,
                            "finish clarification and approve the plan before changing mode",
                            {"error_code": "workflow_gate", "workflow": session.workflow()},
                        )
                        return
                    mode = str(mode).lower()
                    if mode not in {"plan", "execute"}:
                        self._error(HTTPStatus.BAD_REQUEST, "mode must be plan or execute")
                        return
                    # A plan-created session may not be converted into an
                    # execution session before the user approves its plan.
                    # Checking the transition at the API boundary closes the
                    # previous bypass where PATCH(plan -> execute) followed by
                    # /run skipped the approval guard in _run_session.
                    if (
                        mode == "execute"
                        and session.mode == "plan"
                        and session.plan.status != "approved"
                    ):
                        self._error(HTTPStatus.CONFLICT, "approve the plan before switching to execute mode")
                        return
                    previous_mode = session.mode
                    session.mode = mode
                    # Switching back to plan invalidates any prior approval;
                    # the next run must be tied to a new visible revision.
                    if mode == "plan":
                        # Entering (or re-entering) Plan mode invalidates the
                        # previous approval even when the requested mode is
                        # already ``plan``.  A fresh revision is essential
                        # after an approved/completed run; otherwise the
                        # idempotency guard could mistake the draft for the
                        # already-executed revision.
                        session.plan_version += 1
                        session.last_run_plan_version = None
                        for step in session.plan.steps:
                            step["status"] = "pending"
                        session.plan.status = "proposed"
                        session.route = "plan"
                        session.route_decision["route"] = "plan"
                        session.route_decision["requires_approval"] = True
                        session.transition("awaiting_approval", reason="mode_switched_to_plan" if previous_mode != "plan" else "plan_revision_requested")
                    elif session.plan.status == "approved":
                        session.route = "plan" if session.route == "plan" else session.route
                        session.transition("approved", reason="mode_execute_after_approval")
                    else:
                        session.route = "direct_execute"
                        session.route_decision["route"] = "direct_execute"
                        session.route_decision["requires_approval"] = False
                        session.transition("intake", reason="mode_switched_to_execute")
                session.updated_at = datetime.now(timezone.utc).isoformat()
                self.manager._save(session)
                self._send(HTTPStatus.OK, {"ok": True, "id": session.id, "session": session.to_dict(), "workflow": session.workflow()})
                return
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        except KeyError:
            self._error(HTTPStatus.NOT_FOUND, "session not found")
        except (ValueError, TypeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "%s: %s" % (type(exc).__name__, exc))

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            query = self._query()
            # Chrome DevTools and browsers probe these paths on every reload.
            # Answering with an empty 204 keeps the console free of false alarms.
            if route in _QUIET_PROBE_ROUTES or route.startswith("/.well-known/"):
                self._send(HTTPStatus.NO_CONTENT, b"")
                return
            if route == "/api/auth/me":
                user = self.auth_store.user_for_token(self._auth_token())
                if not user:
                    self._error(HTTPStatus.UNAUTHORIZED, "authentication required")
                    return
                self._send(HTTPStatus.OK, {"ok": True, "user": user})
                return
            if route == "/health":
                source = Path(__file__).resolve()
                self._send(HTTPStatus.OK, {"ok": True, "service": "nju-coding-agent", "model_configured": bool(os.getenv("OPENAI_API_KEY") or os.getenv("MODEL_API_KEY")), "backend_source": str(source), "backend_mtime": source.stat().st_mtime_ns, "active_streams": _active_stream_count()})
                return
            if route == "/api/settings":
                user = self._current_user()
                settings = self.auth_store.user_settings(int(user["id"])) if user else get_current_settings()
                if user:
                    settings = {**get_current_settings(), **settings}
                self._send(HTTPStatus.OK, {"ok": True, "settings": settings})
                return
            if route in {"/api/projects/tree", "/api/workspace/tree"}:
                root = query.get("root") or self.manager.default_workspace
                tools = LocalTools(root)
                items = tools.list_tree(query.get("path", "."))
                tree = nested_tree(items, tools.workspace.name)
                self._send(HTTPStatus.OK, {"ok": True, "root": str(tools.workspace), "workspace": str(tools.workspace), "items": items, "tree": tree})
                return
            if route == "/api/workspace/select":
                job_id = query.get("job")
                if job_id:
                    with self.picker_lock:
                        job = dict(self.picker_jobs.get(job_id) or {})
                    if not job:
                        self._error(HTTPStatus.NOT_FOUND, "workspace picker job not found")
                    else:
                        self._send(HTTPStatus.OK, job)
                else:
                    self._send(HTTPStatus.OK, {"ok": True, "available": True})
                return
            if route == "/api/files/read":
                root = query.get("root") or self.manager.default_workspace
                path = query.get("path")
                if not path:
                    self._error(HTTPStatus.BAD_REQUEST, "path query parameter is required")
                    return
                tools = LocalTools(root)
                target = tools.resolve(path)
                if not target.exists() or not target.is_file():
                    self._error(HTTPStatus.NOT_FOUND, "file not found: %s" % path)
                    return
                content = tools.read_file(path)
                self._send(HTTPStatus.OK, {"ok": True, "root": str(tools.workspace), "path": str(target.relative_to(tools.workspace)).replace("\\", "/"), "content": content})
                return
            if route.startswith("/api/sessions/"):
                parts = path_parts(route)
                if len(parts) == 3:
                    session = self._session_for_user(parts[2])
                    self._send(HTTPStatus.OK, {"ok": True, "session": session.to_dict()})
                    return
                self._error(HTTPStatus.NOT_FOUND, "route not found")
                return
            if route == "/api/sessions":
                user = self._current_user()
                # Older local journals predate account ownership and have a
                # null owner_id. Keep those sessions visible to the current
                # local user so history does not appear empty after login.
                sessions = [s for s in self.manager.sessions.values() if (s.owner_id in {None, int(user["id"])} if user else True)]
                self._send(HTTPStatus.OK, {"ok": True, "sessions": [s.to_dict(include_messages=False) for s in sessions]})
                return
            if not route.startswith("/api/") and route != "/health" and self._serve_frontend(route):
                return
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        except KeyError:
            self._error(HTTPStatus.NOT_FOUND, "session not found")
        except (ValueError, FileNotFoundError, NotADirectoryError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "%s: %s" % (type(exc).__name__, exc))

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            route = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
            if route == "/api/auth/me":
                user = self._current_user()
                if not user:
                    self._error(HTTPStatus.UNAUTHORIZED, "authentication required")
                    return
                body = self._read_json()
                updated = self.auth_store.update_profile(int(user["id"]), username=body.get("username"), email=body.get("email"), phone=body.get("phone"))
                self._send(HTTPStatus.OK, {"ok": True, "user": updated, "message": "资料已更新"})
                return
            if route == "/api/auth/password":
                user = self._current_user()
                if not user:
                    self._error(HTTPStatus.UNAUTHORIZED, "authentication required")
                    return
                body = self._read_json()
                self.auth_store.change_password(int(user["id"]), body.get("current_password"), body.get("new_password"))
                self._send(HTTPStatus.OK, {"ok": True, "message": "密码已更新"})
                return
            if route == "/api/workspace":
                body = self._read_json()
                chosen = _valid_workspace(str(body.get("workspace") or ""))
                if not chosen:
                    self._error(HTTPStatus.BAD_REQUEST, "workspace directory does not exist")
                    return
                self.manager.default_workspace = chosen
                _persist_workspace(chosen)
                self._send(HTTPStatus.OK, {"ok": True, "root": chosen})
                return
            if route == "/api/settings":
                body = self._read_json()
                api_key = str(body.get("api_key") or "").strip()
                if not api_key:
                    # The browser only keeps non-secret fields after a reload,
                    # so a user editing just the model must neither wipe nor
                    # fail on the key already saved locally.  Only reject when
                    # no key exists anywhere yet.
                    existing = os.getenv("OPENAI_API_KEY") or os.getenv("MODEL_API_KEY")
                    if existing:
                        body = {**body, "api_key": existing}
                    else:
                        self._error(HTTPStatus.BAD_REQUEST, "API key is required")
                        return
                user = self._current_user()
                if user:
                    self.auth_store.save_user_settings(int(user["id"]), {"base_url": body.get("base_url"), "model": body.get("model"), "wire_api": body.get("wire_api"), "reasoning_effort": body.get("reasoning_effort")})
                    import backend.config as _config
                    _orig = _config._settings_env_path
                    _config._settings_env_path = _settings_env_path
                    try:
                        write_local_settings(body)
                    finally:
                        _config._settings_env_path = _orig
                    self._send(HTTPStatus.OK, {"ok": True, "settings": {**get_current_settings(), **self.auth_store.user_settings(int(user["id"]))}, "message": "配置已保存到当前账号"})
                else:
                    import backend.config as _config
                    _orig = _config._settings_env_path
                    _config._settings_env_path = _settings_env_path
                    try:
                        write_local_settings(body)
                    finally:
                        _config._settings_env_path = _orig
                    self._send(HTTPStatus.OK, {"ok": True, "settings": get_current_settings(), "message": "默认配置已保存到本机 .env"})
                return
            self._handle_write_file()
        except AuthError as exc:
            self._error(exc.status, str(exc))
        except (ValueError, FileNotFoundError, NotADirectoryError, TypeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "%s: %s" % (type(exc).__name__, exc))

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            route = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
            body = self._read_json()
            parts = path_parts(route)
            if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
                session = self.manager.delete(parts[2])
                self._send(HTTPStatus.OK, {"ok": True, "id": session.id, "message": "Session deleted"})
                return
            if route != "/api/files/delete":
                self._error(HTTPStatus.NOT_FOUND, "route not found")
                return
            path = body.get("path")
            if not isinstance(path, str) or not path.strip():
                self._error(HTTPStatus.BAD_REQUEST, "path is required")
                return
            tools = LocalTools(body.get("root") or self.manager.default_workspace)
            target = tools.resolve(path)
            if target.is_dir() and not target.is_symlink():
                # Recursive deletion is intentionally outside the model-facing
                # delete_file contract.  Keep it available only as an explicit
                # user action with two independent signals.
                if not (body.get("recursive") is True and body.get("confirmed") is True):
                    self._error(HTTPStatus.CONFLICT, "directory deletion requires recursive=true and confirmed=true")
                    return
                result = tools.delete_path(path)
            else:
                result = tools.delete_file(path)
            self._send(HTTPStatus.OK, {"ok": True, "result": result})
        except (ValueError, FileNotFoundError, NotADirectoryError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "%s: %s" % (type(exc).__name__, exc))

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            body = self._read_json()
            if route == "/api/auth/register":
                user = self.auth_store.register(body.get("username"), body.get("password"), body.get("email"), body.get("phone"))
                token, _ = self.auth_store.login(body.get("username"), body.get("password"))
                self._send(HTTPStatus.CREATED, {"ok": True, "token": token, "user": user})
                return
            if route == "/api/auth/login":
                token, user = self.auth_store.login(body.get("username"), body.get("password"))
                self._send(HTTPStatus.OK, {"ok": True, "token": token, "user": user})
                return
            if route == "/api/auth/logout":
                self.auth_store.logout(self._auth_token())
                self._send(HTTPStatus.OK, {"ok": True})
                return
            if route == "/api/model/test":
                model = self._model_for_body(body)
                if model is None or not model.available:
                    self._error(HTTPStatus.BAD_REQUEST, "API key is required")
                    return
                try:
                    response = model.complete([{"role": "user", "content": "Reply with exactly: CodePilot API OK"}], [])
                    self._console_model_message(response.content or "Model connected")
                    self._send(HTTPStatus.OK, {"ok": True, "message": response.content or "Model connected"})
                except Exception as exc:
                    self._error(HTTPStatus.BAD_GATEWAY, str(exc))
                return
            if route == "/api/model/stream":
                model = self._model_for_body(body)
                if model is None or not model.available:
                    self._error(HTTPStatus.BAD_REQUEST, "璇峰厛閰嶇疆 API key锛堝瘑閽ワ級")
                    return
                messages = body.get("messages") if isinstance(body.get("messages"), list) else [{"role": "user", "content": str(body.get("prompt") or "") }]
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-store")
                self.send_header("Connection", "keep-alive")
                self.send_header("Access-Control-Allow-Origin", os.getenv("AGENT_CORS_ORIGIN", "*"))
                self.end_headers()
                _stream_opened()
                try:
                    streamed_text = []
                    for delta in model.stream_text(messages):
                        streamed_text.append(delta)
                        self.wfile.write(("data: " + json.dumps({"delta": delta}, ensure_ascii=False) + "\n\n").encode("utf-8"))
                        self.wfile.flush()
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    self._console_model_message("".join(streamed_text))
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return
                finally:
                    _stream_closed()
                return
            if route == "/api/workspace/select":
                job_id = uuid.uuid4().hex
                with self.picker_lock:
                    self.picker_jobs[job_id] = {"ok": True, "pending": True, "job_id": job_id}

                def pick() -> None:
                    result: Dict[str, Any]
                    try:
                        from pathlib import Path as _Path

                        from .folder_picker import pick_folder

                        initial = ""
                        try:
                            candidate = _Path(self.manager.default_workspace).expanduser().resolve()
                            if candidate.is_dir():
                                initial = str(candidate)
                        except OSError:
                            initial = ""
                        selected = pick_folder(title="选择 CodePilot 工作区", initial_directory=initial or None) or ""
                        if not selected:
                            result = {"ok": False, "cancelled": True, "pending": False, "job_id": job_id}
                        else:
                            tools = LocalTools(selected)
                            items = tools.list_tree(".")
                            root = _persist_workspace(str(tools.workspace))
                            self.manager.default_workspace = root
                            result = {
                                "ok": True,
                                "pending": False,
                                "root": root,
                                "items": items,
                                "job_id": job_id,
                            }
                    except Exception as exc:
                        result = {"ok": False, "pending": False, "error": str(exc), "job_id": job_id}
                    with self.picker_lock:
                        self.picker_jobs[job_id] = result

                # Return immediately so the browser can poll while the native
                # dialog stays open; a blocking response made the UI look hung
                # and encouraged a manual path prompt workaround.
                threading.Thread(target=pick, daemon=True).start()
                self._send(HTTPStatus.OK, {"ok": True, "pending": True, "job_id": job_id})
                return
            if route == "/api/files/write":
                self._handle_write_file(body)
                return
            if route == "/api/files/mkdir":
                root = body.get("root") or self.manager.default_workspace
                path = body.get("path")
                tools = LocalTools(root)
                result = tools.make_directory(str(path or ""))
                self._send(HTTPStatus.CREATED, {"ok": True, "root": str(tools.workspace), "result": result})
                return
            if route == "/api/workspace/import":
                action = body.get("action")
                if action == "init":
                    # Never create an implicit temporary project: a browser
                    # upload cannot expose its absolute directory to this
                    # process, and silently editing a copy violates the
                    # real-workspace contract.  Use the native picker instead.
                    self._error(
                        HTTPStatus.CONFLICT,
                        "select an existing directory with the native workspace picker",
                        {"error_code": "native_picker_required"},
                    )
                    return
                root = body.get("root")
                path = body.get("path")
                if action != "file" or not root or not path:
                    self._error(HTTPStatus.BAD_REQUEST, "root and path are required")
                    return
                tools = LocalTools(root)
                target = tools.resolve(path); target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(body.get("content_base64", "")))
                self._send(HTTPStatus.OK, {"ok": True, "path": path})
                return
            if route == "/api/commands/run":
                root = body.get("root")
                # The bundled UI historically sent an absolute ``cwd`` but no
                # separate root.  Treat that directory as the requested
                # workspace (the command still cannot escape it via ``cwd``).
                if not root and isinstance(body.get("cwd"), str) and Path(body["cwd"]).is_absolute():
                    root = body["cwd"]
                root = root or self.manager.default_workspace
                tools = LocalTools(root)
                result = tools.run_command(
                    body.get("command", ""),
                    cwd=body.get("cwd"),
                    timeout=body.get("timeout", LocalTools.DEFAULT_TIMEOUT),
                    confirmed=bool(body.get("confirmed", False)),
                )
                self._send(HTTPStatus.OK, {"ok": not result.get("blocked", False), "result": result})
                return
            if route == "/api/sessions/stream":
                _stream_opened()
                try:
                    self._stream_create_session(body)
                finally:
                    _stream_closed()
                return
            if route == "/api/sessions":
                self._create_session(body)
                return
            if route.startswith("/api/sessions/"):
                parts = path_parts(route)
                if len(parts) < 3:
                    self._error(HTTPStatus.NOT_FOUND, "route not found")
                    return
                session = self._session_for_user(parts[2])
                action = parts[3] if len(parts) > 3 else "turn"
                if action == "stream":
                    _stream_opened()
                    try:
                        self._stream_session(session, body)
                    finally:
                        _stream_closed()
                    return
                if action == "turn":
                    self._session_turn(session, body)
                elif action == "cancel":
                    self.manager.cancel(session)
                    self._send(HTTPStatus.OK, {"ok": True, "id": session.id, "session": session.to_dict(), "workflow": session.workflow(), "message": "Generation stopped"})
                elif action == "retry":
                    # Branching changes the conversation context and therefore
                    # invalidates any prior plan approval.  Route the edited
                    # prompt through the normal intake coordinator instead of
                    # calling /run directly; an ambiguous edit must clarify
                    # and a plan-mode edit must wait for a fresh approval.
                    retry_message = str(body.get("message") or "")
                    self.manager.branch_from_user_turn(
                        session,
                        int(body.get("user_ordinal", -1)),
                        retry_message,
                    )
                    result = self.manager.handle_turn(
                        session,
                        retry_message,
                        model=self._model_for_body(body),
                        max_steps=int(body.get("max_steps", 24)),
                        planner_fn=generate_plan_with_model,
                        intake_fn=generate_intake_with_model,
                        event_callback=None,
                    )
                    data = session.to_dict()
                    self._send(
                        HTTPStatus.OK,
                        {
                            "ok": result.status not in {"error", "failed"},
                            "id": session.id,
                            "session_id": session.id,
                            "session": data,
                            "workflow": session.workflow(),
                            "message": result.message,
                            "content": result.message,
                            "result": result.to_dict(),
                            "events": result.events,
                            "plan": data["plan"]["steps"],
                            "plan_state": data["plan"],
                        },
                    )
                elif action == "plan" and len(parts) > 4:
                    if parts[4] == "approve":
                        self._approve_plan(session, body)
                    elif parts[4] in {"revise", "update"}:
                        self._revise_plan(session, body)
                    else:
                        self._error(HTTPStatus.NOT_FOUND, "unknown plan action")
                elif action == "run":
                    self._run_session(session, body)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "unknown session action")
                return
            self._error(HTTPStatus.NOT_FOUND, "route not found")
        except KeyError:
            self._error(HTTPStatus.NOT_FOUND, "session not found")
        except FileExistsError as exc:
            self._error(HTTPStatus.CONFLICT, str(exc))
        except PlanConflictError as exc:
            self._error(getattr(exc, "status_code", HTTPStatus.CONFLICT), str(exc), {"error_code": getattr(exc, "error_code", "stale_plan")})
        except AuthError as exc:
            self._error(exc.status, str(exc))
        except (ValueError, FileNotFoundError, NotADirectoryError, TypeError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "%s: %s" % (type(exc).__name__, exc))

    def _handle_write_file(self, body: Optional[Dict[str, Any]] = None) -> None:
        if body is None:
            body = self._read_json()
        root = body.get("root") or self.manager.default_workspace
        path = body.get("path")
        if not path:
            self._error(HTTPStatus.BAD_REQUEST, "path is required")
            return
        if "content" not in body:
            self._error(HTTPStatus.BAD_REQUEST, "content is required")
            return
        tools = LocalTools(root)
        result = tools.write_file(str(path), str(body["content"]))
        self._send(HTTPStatus.OK, {"ok": True, "root": str(tools.workspace), "result": result})

    def _create_session(self, body: Dict[str, Any], publish: Optional[Callable[[Dict[str, Any]], None]] = None, on_delta: Optional[Callable[[str], None]] = None) -> None:
        workspace = body.get("workspace") or body.get("root") or self.manager.default_workspace
        task = str(body.get("task") or body.get("message") or "")
        mode = str(body.get("mode") or "plan").lower()
        user = self._current_user()
        session = self.manager.create(workspace=workspace, task=task, mode=mode, owner_id=int(user["id"]) if user else None)

        def emit_error(message: str, details: Optional[Any] = None, status: int = HTTPStatus.BAD_GATEWAY) -> None:
            if publish is not None:
                event: Dict[str, Any] = {"type": "error", "ok": False, "error": message}
                if details is not None:
                    event["details"] = details
                publish(event)
                return
            self._error(status, message, details)

        decision = classify_request(task, requested_mode=mode)
        planner = self._model_for_body(body)
        result = None
        model_intake = None

        # The local classifier is only a deterministic safety floor.  When a
        # provider is available, let the model decide whether the request is
        # genuinely ready to execute, needs clarification, or should become an
        # approval-gated plan.  Rules still prevent a model from downgrading a
        # high-risk request to direct execution.
        if task.strip() and planner is not None and planner.available and decision.route == "direct_execute":
            try:
                intake = generate_intake_with_model(task, planner, on_delta=on_delta)
            except Exception:
                # Provider failures fall back to the deterministic safety
                # floor; they must not turn session creation into a 500.
                intake = None
            if intake is None:
                model_intake = None
            else:
                model_intake = intake
            if intake is None:
                model_route = None
            else:
                model_route = intake.route
            if model_route is None:
                # Keep the local decision when the provider is unavailable.
                pass
            elif decision.high_risk and model_route == "direct_execute":
                model_route = "clarify"
                intake.ready = False
            if model_route is not None:
              decision = RouteDecision(
                route=model_route,
                requires_model=True,
                requires_approval=(model_route == "plan") or decision.high_risk,
                high_risk=decision.high_risk or intake.high_risk,
                ambiguity=intake.ambiguity,
                confidence=intake.confidence,
                complexity=intake.complexity,
                reasons=intake.reasons or decision.reasons,
                delegated=intake.delegated,
              )
            if model_route is not None:
              session.route = decision.route
              session.route_decision = decision.to_dict()
            if model_route == "clarify":
                session.intake.questions = intake.questions or clarification_questions(task, decision)
                session.intake.assumptions = intake.assumptions
                session.transition("clarifying", reason="model_requested_clarification")
            elif model_route == "plan":
                session.transition("awaiting_approval", reason="model_requested_plan")
            elif model_route == "direct_execute":
                session.transition("intake", reason="model_ready_for_execution")
                self._record_intake_narrative(session, intake)

        # Intake is deliberately local and side-effect free.  In particular,
        # an ambiguous execute request must stop in clarification rather than
        # silently generating a plan or dispatching tools.
        if decision.route == "local_chat" and task.strip():
            result = self.manager.handle_turn(session, task, model=None, event_callback=None)
        elif decision.route == "plan" and task.strip():
            # Explicit Plan mode and concrete high-risk work both get a
            # proposed revision before the user can approve it.  The planner
            # receives no local tool definitions.
            try:
                # Let the model make the generic clarify-vs-plan decision
                # whenever a provider is configured.  The local classifier is
                # only a safety floor for offline mode.
                intake = model_intake or (generate_intake_with_model(task, planner, on_delta=on_delta) if planner is not None and planner.available else None)
                if intake is not None:
                    self._record_intake_narrative(session, intake)
                if intake is not None and intake.route == "clarify":
                    session.intake.questions = intake.questions
                    session.intake.assumptions = intake.assumptions
                    session.route = "clarify"
                    session.route_decision.update({"route": "clarify", "confidence": intake.confidence, "ambiguity": intake.ambiguity, "complexity": intake.complexity, "reasons": intake.reasons, "requires_approval": False})
                    session.transition("clarifying", reason="model_requested_clarification")
                    result = self.manager._clarification_result(session, event_callback=publish)
                else:
                    self.manager.prepare_plan(session, model=planner, planner_fn=generate_plan_with_model, on_delta=on_delta)
            except Exception as exc:
                # The session was already journaled with its deterministic
                # baseline.  Keep that snapshot available for a retry, but do
                # not return a successful-looking plan-generation response.
                emit_error(
                    "planner failed; retry plan generation",
                    {
                        "error_code": "planner_failed",
                        "retryable": True,
                        "reason": "%s: %s" % (type(exc).__name__, str(exc)[:300]),
                        "session_id": session.id,
                        "workflow": session.workflow(),
                    },
                )
                return
        elif decision.route == "clarify" and task.strip():
            if planner is not None and planner.available:
                try:
                    intake = model_intake or generate_intake_with_model(task, planner, on_delta=on_delta)
                except Exception as exc:
                    # Keep the deterministic safety floor available when the
                    # provider is temporarily unreachable.
                    emit_error(
                        "intake model unavailable; retry the request",
                        {"error_code": "intake_failed", "reason": str(exc)[:240]},
                    )
                    return
                # The local policy is the safety floor: a model may add
                # questions or refine a plan, but it cannot downgrade an
                # ambiguous product request into direct execution.
                if decision.route == "clarify" and intake.route == "direct_execute":
                    intake.route = "clarify"
                    intake.ready = False
                    if not intake.questions:
                        intake.questions = clarification_questions(task, decision)
                session.intake.questions = intake.questions
                session.intake.assumptions = intake.assumptions
                session.route = intake.route
                session.route_decision.update({"route": intake.route, "confidence": intake.confidence, "ambiguity": intake.ambiguity, "complexity": intake.complexity, "reasons": intake.reasons, "requires_approval": intake.route == "plan"})
                # A locally classified clarification gate cannot be bypassed
                # by a model that prematurely returns kind=plan.  Collect the
                # user's answers first, then generate the plan on the next
                # turn.
                if decision.route != "clarify" and intake.route == "plan" and intake.ready:
                    self.manager.prepare_plan(session, model=planner, planner_fn=generate_plan_with_model, on_delta=on_delta)
                    data = session.to_dict()
                    payload = {"ok": True, "id": session.id, "session_id": session.id, "session": data, "plan": data["plan"]["steps"], "plan_state": data["plan"], "workflow": session.workflow(), "message": "Model returned a structured plan."}
                    if publish is not None:
                        publish({"type": "workflow_result", **payload})
                    else:
                        self._send(HTTPStatus.CREATED, payload)
                    return
            # Session.create already populated bounded questions; persist an
            # explicit clarification event so a freshly-created session has a
            # useful transcript without invoking a coding model.
            result = self.manager._clarification_result(session, event_callback=publish)
            if planner is not None and planner.available and intake is not None:
                self._record_intake_narrative(session, intake)
        data = session.to_dict()
        # Include both a nested canonical representation and flat aliases for
        # lightweight clients (the bundled UI accepts either shape).
        payload: Dict[str, Any] = {
            "ok": True,
            "id": session.id,
            "session_id": session.id,
            "session": data,
            "plan": data["plan"]["steps"],
            "plan_state": data["plan"],
            "workflow": session.workflow(),
            # Every session response must contain user-facing natural
            # language.  A bare transport status such as "Session created"
            # makes the agent appear silent and is especially confusing when
            # the next turn is still being prepared.
            "message": result.message if result is not None else (
                "会话已创建，等待你的下一步指令。"
            ),
        }
        if result is not None:
            payload["result"] = result.to_dict()
            payload["events"] = result.events
        if publish is not None:
            publish({"type": "workflow_result", **payload})
        else:
            self._send(HTTPStatus.CREATED, payload)

    def _record_intake_narrative(self, session: Session, intake: Any) -> None:
        """Persist the model's analysis as an assistant turn.

        The narrative was already streamed to the UI via ``assistant_delta``,
        so no duplicate ``assistant`` event is emitted here; this records it
        in the conversation so later elicitation rounds (and restored
        snapshots) keep the agent's reasoning in context.  Idempotent: the
        same narrative is never appended twice.
        """
        narrative = str(getattr(intake, "narrative", "") or "").strip()
        if not narrative:
            return
        messages = getattr(session.conversation, "messages", None) or []
        if messages and messages[-1].get("role") == "assistant" and str(messages[-1].get("content") or "") == narrative:
            return
        session.conversation.add("assistant", narrative)
        session.last_message = narrative
        session.updated_at = datetime.now(timezone.utc).isoformat()
        self.manager._save(session)

    def _stream_session(self, session: Session, body: Dict[str, Any]) -> None:
        """Run a session operation while forwarding agent events as SSE."""
        events_queue: queue.Queue = queue.Queue()
        action = str(body.get("action") or "run").lower()
        result_box: Dict[str, Any] = {}

        def publish(event: Dict[str, Any]) -> None:
            events_queue.put(event)

        def worker() -> None:
            started = time.monotonic()
            try:
                selected = self._model_for_body(body)
                provider = "provider" if selected is not None and selected.available else "demo"
                try:
                    sid = str(getattr(session, "id", "") or "")[:10]
                except Exception:
                    sid = "?"
                print("[stream] %s action=%s session=%s phase=%s provider=%s task=%r" % (
                    datetime.now().strftime("%H:%M:%S"),
                    action,
                    sid,
                    getattr(session, "phase", "?"),
                    provider,
                    str(getattr(session, "task", "") or "")[:80],
                ), flush=True)
                publish({"type": "workflow_started", "provider": provider, "action": action, "model": getattr(selected, "model", "DemoModel"), "created_at": datetime.now(timezone.utc).isoformat()})
                if action == "run":
                    result_box["result"] = self.manager.run(
                        session, model=selected,
                        max_steps=int(body.get("max_steps", 24)), event_callback=publish,
                    )
                elif action == "turn":
                    result = self.manager.handle_turn(
                        session, str(body.get("message") or ""), model=selected,
                        max_steps=int(body.get("max_steps", 24)), answers=body.get("answers"),
                        planner_fn=generate_plan_with_model,
                        intake_fn=generate_intake_with_model,
                        event_callback=publish,
                        # The JSON decision block is stripped inside
                        # generate_intake_with_model.
                        on_delta=lambda delta: publish({"type": "assistant_delta", "stage": "intake", "content": delta}),
                    )
                    if getattr(result, "next_action", "") == "plan":
                        # Carry straight into plan generation on this same
                        # socket.  Relying on a second action="plan" request
                        # meant the plan silently never appeared when the
                        # frontend failed to issue it (stale cache, JS error,
                        # or a dropped response).  The intake analysis and the
                        # plan markdown share one live bubble; if the socket
                        # drops, the frontend retains the partial reply and a
                        # retried turn (answers are persisted) regenerates the
                        # plan idempotently.
                        _wf_log(session, "carrying into plan generation on same socket")
                        result = self.manager._plan_result(
                            session,
                            model=selected,
                            increment_version=False,
                            planner_fn=generate_plan_with_model,
                            on_delta=lambda delta: publish({"type": "assistant_delta", "stage": "plan", "content": delta}),
                        )
                    result_box["result"] = result
                elif action == "plan":
                    # A SEPARATE, short request that only generates the plan.
                    # turn signals readiness (next_action="plan"); the frontend
                    # calls this to stream the plan markdown on its own socket,
                    # so one dev-restart or network blip cannot abort both the
                    # intake analysis and the plan generation together.
                    if session.phase not in {"planning", "awaiting_approval", "replanning"}:
                        raise ValueError("session is not ready for plan generation (phase=%s)" % session.phase)
                    result_box["result"] = self.manager._plan_result(
                        session,
                        model=selected,
                        increment_version=False,
                        planner_fn=generate_plan_with_model,
                        on_delta=lambda delta: publish({"type": "assistant_delta", "stage": "plan", "content": delta}),
                    )
                elif action == "retry":
                    self.manager.branch_from_user_turn(session, int(body.get("user_ordinal", -1)), str(body.get("message") or ""))
                    result_box["result"] = self.manager.handle_turn(
                        session, str(body.get("message") or ""), model=selected,
                        max_steps=int(body.get("max_steps", 24)), planner_fn=generate_plan_with_model,
                        intake_fn=generate_intake_with_model,
                        event_callback=publish,
                        on_delta=lambda delta: publish({"type": "assistant_delta", "stage": "intake", "content": delta}),
                    )
                elif action == "revise":
                    feedback = str(body.get("feedback") or body.get("message") or "").strip()
                    markdown = body.get("markdown") or body.get("plan_markdown")
                    if "plan" in body:
                        markdown = plan_value_to_markdown(body.get("plan"))
                    if not feedback and not markdown:
                        raise ValueError("feedback or plan markdown is required")
                    revised = self.manager.revise_plan(
                        session, feedback, plan_markdown=markdown, model=selected,
                        planner_fn=generate_plan_with_model,
                        expected_plan_version=body.get("expected_plan_version", body.get("plan_revision")),
                        on_delta=lambda delta: publish({"type": "assistant_delta", "stage": "plan", "content": delta}),
                    )
                    # revise_plan returns the session, but the SSE layer expects
                    # a RunResult.  Wrap it (the up-to-date plan lives in the
                    # session snapshot serialised into workflow_result).
                    result_box["result"] = RunResult(
                        getattr(revised, "phase", "awaiting_approval"),
                        "计划已按你的意见重新生成，请检查新的步骤。",
                        len(getattr(revised.plan, "steps", None) or []),
                        [],
                        {"plan_revision": getattr(revised, "plan_version", 1)},
                    )
                else:
                    raise ValueError("unsupported stream action: %s" % action)
            except Exception as exc:
                result_box["error"] = str(exc)
                print("[错误] 模型工作流失败: %s: %s" % (type(exc).__name__, exc), flush=True)
                traceback.print_exc()
            finally:
                result_box["finished"] = True
                print("[stream] %s done action=%s ok=%s took=%.1fs" % (
                    datetime.now().strftime("%H:%M:%S"),
                    action,
                    "error" if result_box.get("error") else "ok",
                    time.monotonic() - started,
                ), flush=True)

        result_box["session"] = session

        def on_disconnect() -> None:
            # The frontend deliberately tears down the socket right after
            # receiving ``workflow_result`` so the Stop button is not stuck.
            # That completion is a normal end-of-stream, NOT a reason to
            # cancel a just-finished or approval-pending session: cancelling
            # here would flip the phase to "cancelled" and make the very next
            # approve/run silently return a cancelled result.
            if result_box.get("result") is None:
                self.manager.cancel(session)

        # Headers must be sent before the worker can fail; otherwise the
        # browser reports a misleading generic `Failed to fetch` and loses
        # the structured error event.
        threading.Thread(target=worker, daemon=True).start()
        self._write_sse(events_queue, result_box, on_disconnect=on_disconnect)

    def _write_sse(
        self,
        events_queue: queue.Queue,
        result_box: Dict[str, Any],
        on_disconnect: Optional[Callable[[], None]] = None,
    ) -> None:
        """Forward a worker's events to the SSE client until it finishes.

        Headers are sent before the worker can fail so the browser receives a
        structured ``error`` event instead of a generic ``Failed to fetch``.
        """
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", os.getenv("AGENT_CORS_ORIGIN", "*"))
        self.end_headers()
        try:
            while not result_box.get("finished") or not events_queue.empty():
                try:
                    event = events_queue.get(timeout=0.25)
                    self.wfile.write(("event: %s\ndata: " % event.get("type", "message")).encode("utf-8") + json_bytes(event) + b"\n\n")
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n"); self.wfile.flush()
            if result_box.get("error"):
                self.wfile.write(b"event: error\ndata: " + json_bytes({"error": result_box["error"]}) + b"\n\n")
            elif result_box.get("result") is not None:
                result = result_box["result"]
                self._console_model_message(getattr(result, "message", ""))
                session = result_box.get("session")
                snapshot = session.to_dict() if session is not None else {}
                # Defensive: every action must hand back a RunResult-shaped
                # object.  Fall back gracefully rather than killing the stream
                # (a Session with no .message/.status used to 500 revise).
                try:
                    result_payload = result.to_dict()
                    result_message = getattr(result, "message", "")
                    result_status = getattr(result, "status", "completed")
                except AttributeError:
                    result_payload = {}
                    result_message = getattr(result, "message", "")
                    result_status = getattr(result, "status", "completed")
                self.wfile.write(b"event: workflow_result\ndata: " + json_bytes({"type": "workflow_result", "result": result_payload, "session": snapshot, "workflow": snapshot.get("workflow", {}), "message": result_message, "ok": result_status not in {"error", "failed"}}) + b"\n\n")
            self.wfile.write(b"event: done\ndata: {}\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # Clients may disconnect while a long agent run is in flight.
            # Cooperative cancellation keeps the server healthy and prevents
            # a runaway tool loop on an abandoned session.
            if on_disconnect:
                try:
                    on_disconnect()
                except Exception:
                    pass

    def _stream_create_session(self, body: Dict[str, Any]) -> None:
        """Create a session while streaming the intake/plan analysis as SSE.

        The blocking ``/api/sessions`` endpoint hides the model's intake and
        planning work behind a single response.  This streamed variant runs
        the same analysis in a worker thread and forwards the model's
        ``assistant_delta`` tokens live so a fresh conversation never shows a
        silent gap followed by a burst of text.
        """
        events_queue: queue.Queue = queue.Queue()
        result_box: Dict[str, Any] = {}

        def publish(event: Dict[str, Any]) -> None:
            events_queue.put(event)

        def on_delta(piece: str) -> None:
            publish({"type": "assistant_delta", "stage": "intake", "content": str(piece or "")})

        def worker() -> None:
            try:
                selected = self._model_for_body(body)
                provider = "provider" if selected is not None and selected.available else "demo"
                publish({"type": "workflow_started", "provider": provider, "action": "create", "model": getattr(selected, "model", "DemoModel"), "created_at": datetime.now(timezone.utc).isoformat()})
                self._create_session(body, publish=publish, on_delta=on_delta)
            except Exception as exc:
                result_box["error"] = str(exc)
                print("[错误] 会话创建失败: %s" % exc, flush=True)
            finally:
                result_box["finished"] = True

        threading.Thread(target=worker, daemon=True).start()
        self._write_sse(events_queue, result_box)

    def _session_turn(self, session: Session, body: Dict[str, Any]) -> None:
        message = str(body.get("message") or body.get("task") or "").strip()
        answers = body.get("answers") if isinstance(body.get("answers"), dict) else None
        if not message and not answers:
            self._error(HTTPStatus.BAD_REQUEST, "message is required")
            return
        session.cancellation_event.clear()
        result = self.manager.handle_turn(
            session,
            message,
            model=self._model_for_body(body),
            max_steps=int(body.get("max_steps", 24)),
            answers=answers,
            planner_fn=generate_plan_with_model,
            intake_fn=generate_intake_with_model,
            event_callback=None,
        )
        # handle_turn now signals readiness instead of generating the plan on
        # the same request; carry the plan through here so this legacy
        # non-streaming endpoint still returns a usable plan.
        if getattr(result, "next_action", "") == "plan":
            result = self.manager._plan_result(session, model=self._model_for_body(body), increment_version=False, planner_fn=generate_plan_with_model)
        self._console_model_message(result.message)
        data = session.to_dict()
        self._send(
            HTTPStatus.OK,
            {
                "ok": result.status not in {"error", "failed"},
                "id": session.id,
                "session_id": session.id,
                "session": data,
                "workflow": session.workflow(),
                "message": result.message,
                "content": result.message,
                "result": result.to_dict(),
                "events": result.events,
                "plan": data["plan"]["steps"],
                "plan_state": data["plan"],
            },
        )

    def _model_for_body(self, body: Dict[str, Any]) -> Optional[OpenAICompatibleModel]:
        model_name = body.get("model")
        # Presence, rather than truthiness, matters here.  An explicit empty
        # key is a deliberate request for offline/demo mode and must not make
        # us silently construct a default client that inherits OPENAI_API_KEY.
        configurable_fields = ("model", "api_key", "base_url", "wire_api", "reasoning_effort")
        if not any(field in body for field in configurable_fields):
            # API clients may rely on the account's persisted provider
            # settings instead of resending credentials on every turn.
            user = self._current_user()
            saved = self.auth_store.user_settings(int(user["id"])) if user else {}
            # The key is a server-level credential: prefer the account's saved
            # key (if the account stored one via a prior explicit submit),
            # otherwise the env / .env value.  resolve_api_key reads the local
            # .env file as a fallback so a key added after server start is
            # still picked up.
            account_key = saved.get("api_key") or None
            env_key = account_key or resolve_api_key()
            if env_key:
                return OpenAICompatibleModel(
                    api_key=env_key, base_url=saved.get("base_url") or get_current_settings()["base_url"],
                    model=saved.get("model") or get_current_settings()["model"],
                    wire_api=saved.get("wire_api") or get_current_settings()["wire_api"],
                    reasoning_effort=saved.get("reasoning_effort") or get_current_settings()["reasoning_effort"],
                )
            return None
        return OpenAICompatibleModel(
            api_key=body.get("api_key") if "api_key" in body else None,
            base_url=body.get("base_url") if "base_url" in body else None,
            model=model_name,
            wire_api=body.get("wire_api") if "wire_api" in body else None,
            reasoning_effort=body.get("reasoning_effort") if "reasoning_effort" in body else None,
        )

    def _run_session(self, session: Session, body: Dict[str, Any]) -> None:
        if session.phase in {"clarifying", "planning", "replanning", "awaiting_approval"}:
            self._error(
                HTTPStatus.CONFLICT,
                "complete clarification and approve the plan before running tools",
                {"error_code": "workflow_gate", "workflow": session.workflow()},
            )
            return
        if (session.mode == "plan" or session.route == "plan" or session.route_decision.get("requires_approval")) and session.plan.status != "approved":
            self._error(HTTPStatus.CONFLICT, "approve the plan before running tools", {"error_code": "approval_required", "workflow": session.workflow()})
            return
        result = self.manager.run(session, model=self._model_for_body(body), max_steps=int(body.get("max_steps", 24)))
        self._console_model_message(result.message)
        data = session.to_dict()
        self._send(HTTPStatus.OK, {"ok": result.status not in {"error", "failed"}, "id": session.id, "session_id": session.id, "session": data, "workflow": session.workflow(), "message": result.message, "content": result.message, "result": result.to_dict(), "events": result.events})

    def _approve_plan(self, session: Session, body: Dict[str, Any]) -> None:
        if session.phase in {"clarifying", "planning", "replanning"} or (
            session.phase == "awaiting_approval" and not session.intake.ready
        ):
            self._error(
                HTTPStatus.CONFLICT,
                "complete clarification before approving the plan",
                {"error_code": "workflow_gate", "workflow": session.workflow()},
            )
            return
        if "markdown" in body:
            plan_markdown = body.get("markdown")
        elif "plan_markdown" in body:
            plan_markdown = body.get("plan_markdown")
        else:
            plan_markdown = None
        if "plan" in body:
            plan_markdown = plan_value_to_markdown(body.get("plan"))
        expected = body.get("expected_plan_version", body.get("plan_revision"))
        self.manager.approve_plan(session, plan_markdown=plan_markdown, expected_plan_version=expected)
        data = session.to_dict()
        self._send(HTTPStatus.OK, {"ok": True, "id": session.id, "session_id": session.id, "session": data, "workflow": session.workflow(), "plan": data["plan"]["steps"], "plan_state": data["plan"], "message": "计划已确认，下一轮将执行本地工具。"})

    def _revise_plan(self, session: Session, body: Dict[str, Any]) -> None:
        feedback = str(body.get("feedback") or body.get("message") or "").strip()
        if "markdown" in body:
            markdown = body.get("markdown")
        elif "plan_markdown" in body:
            markdown = body.get("plan_markdown")
        else:
            markdown = None
        if "plan" in body:
            markdown = plan_value_to_markdown(body.get("plan"))
        if not feedback and not markdown:
            self._error(HTTPStatus.BAD_REQUEST, "feedback or plan markdown is required")
            return
        expected = body.get("expected_plan_version", body.get("plan_revision"))
        model = self._model_for_body(body)
        try:
            self.manager.revise_plan(
                session,
                feedback,
                plan_markdown=markdown,
                model=model,
                planner_fn=generate_plan_with_model,
                expected_plan_version=expected,
            )
        except PlanConflictError:
            raise
        except Exception as exc:
            # A provider/planner failure is retryable and must not look like a
            # successful revision. Manual markdown validation remains a normal
            # 400 through the outer handler; only model-backed generation gets
            # the explicit 502 contract.
            if model is not None and markdown is None:
                self._error(
                    HTTPStatus.BAD_GATEWAY,
                    "planner failed; retry the revision without changing the current plan",
                    {"error_code": "planner_failed", "retryable": True, "message": str(exc)[:240]},
                )
                return
            raise
        data = session.to_dict()
        self._send(HTTPStatus.OK, {"ok": True, "id": session.id, "session_id": session.id, "session": data, "workflow": session.workflow(), "plan": data["plan"]["steps"], "plan_state": data["plan"], "message": "计划已重新生成，请检查步骤并确认后再执行。"})


def create_server(host: str = "127.0.0.1", port: int = 8000, workspace: Optional[str] = None) -> ThreadingHTTPServer:
    load_local_env(_settings_env_path())
    # A previously persisted workspace (the one the user actually works in)
    # wins over the process default so the backend and the frontend agree even
    # after a dev-runner restart that passes the checkout path explicitly.
    default_ws = _persisted_workspace() or workspace or os.getcwd()
    store_path = os.getenv("AGENT_SESSION_STORE") or str(Path(__file__).resolve().parent.parent / ".runtime" / "sessions.jsonl")
    manager = SessionManager(default_workspace=default_ws, store_path=store_path)
    auth_path = os.getenv("AGENT_AUTH_STORE") or str(Path(__file__).resolve().parent.parent / ".runtime" / "users.sqlite3")
    auth_store = AuthStore(auth_path)
    server = ThreadingHTTPServer((host, port), AgentRequestHandler)
    server.RequestHandlerClass.manager = manager
    server.RequestHandlerClass.auth_store = auth_store
    server.RequestHandlerClass.frontend_root = Path(__file__).resolve().parent.parent / "frontend"
    return server


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="NJU Coding Agent local backend")
    parser.add_argument("--host", default=os.getenv("AGENT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("AGENT_PORT", "8000")))
    parser.add_argument("--workspace", default=os.getenv("AGENT_WORKSPACE", os.getcwd()))
    args = parser.parse_args(argv)
    default_ws = _persisted_workspace() or args.workspace
    server = create_server(args.host, args.port, args.workspace)
    print("NJU Coding Agent API listening on http://%s:%d (workspace=%s)" % (args.host, args.port, Path(default_ws).resolve()))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

