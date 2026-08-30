"""Local tool implementations for filesystem and command operations."""

import difflib
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union


def _attach_windows_kill_job(process: subprocess.Popen) -> Any:
    """Attach a process to a Windows Job that kills its descendants on close.

    ``subprocess.run(..., timeout=...)`` only terminates the immediate shell.
    A shell-launched compiler or test runner can keep inherited pipes open and
    make the caller wait indefinitely.  Job Objects provide a small, standard
    library-only process-tree boundary.  The helper is a no-op on non-Windows
    hosts and gracefully falls back when a parent sandbox disallows nested
    jobs.
    """

    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class LargeInteger(ctypes.Structure):
            _fields_ = [("QuadPart", ctypes.c_longlong)]

        class BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTime", LargeInteger),
                ("PerJobUserTime", LargeInteger),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_void_p),
                ("Priority", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, wintypes.INT, ctypes.c_void_p, wintypes.DWORD]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            return None
        info = ExtendedLimitInformation()
        # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        info.BasicLimitInformation.LimitFlags = 0x2000
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            kernel32.CloseHandle(handle)
            return None
        if not kernel32.AssignProcessToJobObject(handle, wintypes.HANDLE(process._handle)):
            kernel32.CloseHandle(handle)
            return None
        return (kernel32, handle)
    except Exception:
        return None


def _close_windows_kill_job(job: Any) -> None:
    if not job:
        return
    try:
        job[0].CloseHandle(job[1])
    except Exception:
        pass


TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search UTF-8 source files in the workspace and return bounded matching lines.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "path": {"type": "string", "description": "Relative file or directory, default ."},
                    "max_results": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_diff",
            "description": "Show the current git diff for workspace files without modifying them.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative path, default ."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": "Replace one exact text fragment in a UTF-8 file. Read the file first and include the exact old text.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}},
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tree",
            "description": "List files and directories in the opened workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative directory, default ."},
                    "max_depth": {"type": "integer", "description": "Maximum traversal depth, default 5."},
                    "max_entries": {"type": "integer", "description": "Maximum records, default 500."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "make_directory",
            "description": "Create a directory inside the opened workspace. Parent directories are created as needed.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a UTF-8 text file from the opened workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or replace a UTF-8 text file in the opened workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file from the opened workspace. Use only when the task explicitly requires removal.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a project command in the opened workspace and return stdout/stderr.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "number"},
                },
                "required": ["command"],
            },
        },
    },
]


@dataclass(frozen=True)
class ToolSpec:
    """Runtime metadata for one model-callable local tool."""

    name: str
    definition: Dict[str, Any]
    required: Tuple[str, ...] = ()


TOOL_REGISTRY: Dict[str, ToolSpec] = {
    str(definition.get("function", {}).get("name")): ToolSpec(
        name=str(definition.get("function", {}).get("name")),
        definition=definition,
        required=tuple(definition.get("function", {}).get("parameters", {}).get("required", ())),
    )
    for definition in TOOL_DEFINITIONS
    if definition.get("function", {}).get("name")
}


def _validate_tool_arguments(spec: ToolSpec, arguments: Any) -> Optional[str]:
    """Validate model-supplied arguments before entering local code.

    OpenAI-compatible gateways do not all enforce the JSON schema attached to
    a tool definition.  Keeping this check in the agent itself makes malformed
    calls deterministic and gives the model an actionable error message for a
    retry, instead of leaking a Python ``TypeError`` from a filesystem tool.
    """

    if not isinstance(arguments, dict):
        return "arguments must be a JSON object"
    missing = [name for name in spec.required if name not in arguments]
    if missing:
        return "Missing required arguments: " + ", ".join(missing)
    properties = spec.definition.get("function", {}).get("parameters", {}).get("properties", {})
    for name, value in arguments.items():
        if name not in properties:
            # Preserve forward compatibility with providers that add metadata.
            continue
        expected = properties[name].get("type")
        valid = True
        if expected == "string":
            valid = isinstance(value, str)
        elif expected == "integer":
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif expected == "number":
            valid = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif expected == "boolean":
            valid = isinstance(value, bool)
        elif expected == "array":
            valid = isinstance(value, list)
        elif expected == "object":
            valid = isinstance(value, dict)
        if not valid:
            return "argument '%s' must be %s" % (name, expected or "valid JSON")
    return None


class LocalTools:
    """Filesystem and command tools constrained to one workspace directory."""

    MAX_READ_BYTES = 2 * 1024 * 1024
    MAX_WRITE_BYTES = 4 * 1024 * 1024
    MAX_OUTPUT_CHARS = 120_000
    MAX_SEARCH_RESULTS = 100
    MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024
    MAX_TREE_DEPTH = 12
    MAX_TREE_ENTRIES = 1_000
    CHANGE_CONTENT_BYTES = 256 * 1024
    DEFAULT_TIMEOUT = 30.0
    MAX_TIMEOUT = 180.0

    # This is intentionally a conservative deny-list for accidental disasters.
    # Users can still run normal build/test/git commands.  The HTTP API exposes
    # ``confirmed`` for callers that want to explicitly override a warning.
    _DANGEROUS_PATTERNS = (
        r"\brm\s+-rf\b",
        r"\b(del|erase)\s+/[sqf]\b",
        r"\bformat\s+[a-z]:",
        r"\b(shutdown|restart-computer)\b",
    )

    def __init__(self, workspace: Union[Path, str]):
        # Be defensive about a common Windows batch quoting failure where a
        # directory ending in ``\`` escapes the closing quote and Python sees
        # a literal trailing `"` in argv.
        normalized_workspace = str(workspace).strip().strip('"')
        self.workspace = Path(normalized_workspace).expanduser().resolve()
        if not self.workspace.exists():
            raise FileNotFoundError("workspace directory does not exist: %s" % self.workspace)
        if not self.workspace.is_dir():
            raise ValueError("workspace must be a directory")

    def resolve(self, path: Union[str, Path] = ".") -> Path:
        raw = Path(path)
        candidate = raw.resolve() if raw.is_absolute() else (self.workspace / raw).resolve()
        try:
            candidate.relative_to(self.workspace)
        except ValueError:
            raise ValueError("path escapes workspace")
        return candidate

    def read_file(self, path: str, max_bytes: int = MAX_READ_BYTES) -> str:
        target = self.resolve(path)
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(path)
        if target.stat().st_size > max_bytes:
            raise ValueError("file is larger than the read limit")
        return target.read_text(encoding="utf-8", errors="replace")

    @classmethod
    def _change_snapshot(cls, target: Path) -> Optional[str]:
        """Capture text needed for a review card/undo without huge payloads."""
        if not target.exists() or not target.is_file():
            return ""
        try:
            if target.stat().st_size > cls.CHANGE_CONTENT_BYTES:
                return None
            return target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    @classmethod
    def _change_metadata(cls, relative: str, operation: str, before: Optional[str], after: Optional[str]) -> Dict[str, Any]:
        old = before or ""
        new = after or ""
        old_lines = old.splitlines(keepends=True)
        new_lines = new.splitlines(keepends=True)
        additions = deletions = 0
        for tag, old_start, old_end, new_start, new_end in difflib.SequenceMatcher(None, old_lines, new_lines).get_opcodes():
            if tag in {"replace", "delete"}:
                deletions += old_end - old_start
            if tag in {"replace", "insert"}:
                additions += new_end - new_start
        diff = "".join(difflib.unified_diff(old_lines, new_lines, fromfile=relative, tofile=relative, lineterm=""))
        return {
            "operation": operation,
            "path": relative,
            "additions": additions,
            "deletions": deletions,
            "diff": diff[:20_000],
            "before_content": old if before is not None else "",
            "after_content": new if after is not None else "",
            "undoable": before is not None and after is not None,
        }

    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        if not isinstance(content, str):
            raise TypeError("content must be a string")
        if len(content.encode("utf-8")) > self.MAX_WRITE_BYTES:
            raise ValueError("content is larger than the write limit")
        target = self.resolve(path)
        relative = str(target.relative_to(self.workspace)).replace("\\", "/")
        existed = target.exists() and target.is_file()
        before = self._change_snapshot(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Replace via a sibling temporary file so an interrupted write does not
        # leave a half-written source file behind.
        temporary = target.with_name(target.name + ".agent-tmp-" + uuid.uuid4().hex)
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(target)
        return {
            "path": relative,
            "bytes": len(content.encode("utf-8")),
            "change": self._change_metadata(relative, "modify" if existed else "create", before, content if len(content.encode("utf-8")) <= self.CHANGE_CONTENT_BYTES else None),
        }

    def delete_path(self, path: str) -> Dict[str, Any]:
        target = self.resolve(path)
        if target == self.workspace:
            raise ValueError("cannot delete the workspace root")
        if not target.exists():
            raise FileNotFoundError(path)
        relative = str(target.relative_to(self.workspace)).replace("\\", "/")
        before = self._change_snapshot(target)
        kind = "directory" if target.is_dir() and not target.is_symlink() else "file"
        if kind == "directory":
            shutil.rmtree(target)
        else:
            target.unlink()
        if kind != "file":
            return {"path": relative, "type": kind, "change": {"operation": "delete", "path": relative, "additions": 0, "deletions": 0, "diff": "", "before_content": "", "after_content": "", "undoable": False}}
        return {"path": relative, "type": kind, "change": self._change_metadata(relative, "delete", before, "")}

    def delete_file(self, path: str) -> Dict[str, Any]:
        """Delete one regular workspace file, never an entire directory tree.

        The interactive file browser may expose a separate, explicit folder
        deletion action, but the model-facing ``delete_file`` tool must keep
        its narrower contract.  This prevents a malformed or over-broad model
        call from turning into an unreviewable recursive ``rmtree``.
        """
        target = self.resolve(path)
        if target.is_dir() and not target.is_symlink():
            raise IsADirectoryError(path)
        return self.delete_path(path)

    def make_directory(self, path: str) -> Dict[str, Any]:
        """Create a directory inside the workspace and return its relative path."""
        if not isinstance(path, str) or not path.strip():
            raise ValueError("path is required")
        target = self.resolve(path)
        if target == self.workspace:
            raise ValueError("cannot recreate the workspace root")
        if target.exists():
            if target.is_dir():
                raise FileExistsError(path)
            raise FileExistsError(path)
        target.mkdir(parents=True, exist_ok=False)
        relative = str(target.relative_to(self.workspace)).replace("\\", "/")
        return {"path": relative, "type": "directory"}

    def search_files(self, query: str, path: str = ".", max_results: int = 50) -> List[Dict[str, Any]]:
        if not isinstance(query, str) or not query:
            raise ValueError("query is required")
        base = self.resolve(path)
        if not base.exists():
            raise FileNotFoundError(path)
        candidates = [base] if base.is_file() else sorted(base.rglob("*"), key=lambda item: str(item).lower())
        limit = max(1, min(int(max_results), self.MAX_SEARCH_RESULTS))
        matches: List[Dict[str, Any]] = []
        for candidate in candidates:
            if len(matches) >= limit or not candidate.is_file():
                continue
            relative_parts = candidate.relative_to(self.workspace).parts
            if any(part in {".git", ".venv", "venv", "node_modules", "__pycache__"} for part in relative_parts):
                continue
            try:
                if candidate.stat().st_size > self.MAX_SEARCH_FILE_BYTES:
                    continue
                text = candidate.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for line_number, line in enumerate(text.splitlines(), 1):
                if query.casefold() in line.casefold():
                    matches.append({"path": str(candidate.relative_to(self.workspace)).replace("\\", "/"), "line": line_number, "text": line[:500]})
                    if len(matches) >= limit:
                        break
        return matches

    def git_diff(self, path: str = ".") -> Dict[str, Any]:
        target = self.resolve(path)
        relative = str(target.relative_to(self.workspace)).replace("\\", "/") if target != self.workspace else "."
        command = ["git", "diff", "--no-ext-diff", "--unified=3", "--", relative]
        try:
            completed = subprocess.run(command, cwd=str(self.workspace), capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace")
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "diff": "", "error": str(exc)}
        diff = (completed.stdout or "")[:self.MAX_OUTPUT_CHARS]
        return {"ok": completed.returncode == 0, "diff": diff, "exit_code": completed.returncode, "stderr": (completed.stderr or "")[:4000]}

    def apply_patch(self, path: str, old_text: str, new_text: str) -> Dict[str, Any]:
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise TypeError("old_text and new_text must be strings")
        current = self.read_file(path)
        occurrences = current.count(old_text)
        if occurrences == 0:
            raise ValueError("old_text was not found; read the file again before patching")
        if occurrences > 1:
            raise ValueError("old_text is ambiguous; include a larger unique context")
        return self.write_file(path, current.replace(old_text, new_text, 1))

    def list_tree(self, path: str = ".", max_depth: int = 5, max_entries: int = 500) -> List[Dict[str, Any]]:
        base = self.resolve(path)
        if not base.exists() or not base.is_dir():
            raise NotADirectoryError(path)
        try:
            depth_limit = max(0, min(int(max_depth), self.MAX_TREE_DEPTH))
        except (TypeError, ValueError):
            depth_limit = 5
        try:
            entry_limit = max(1, min(int(max_entries), self.MAX_TREE_ENTRIES))
        except (TypeError, ValueError):
            entry_limit = 500
        output: List[Dict[str, Any]] = []
        base_depth = len(base.relative_to(self.workspace).parts)
        for item in sorted(base.rglob("*"), key=lambda p: str(p).lower()):
            relative = item.relative_to(self.workspace)
            depth = len(relative.parts) - base_depth
            if depth > depth_limit:
                continue
            # Keep common VCS/build directories visible only at their root; a
            # huge node_modules tree is not useful context for a model/UI.
            if any(part in {".git", ".venv", "venv", "node_modules", "__pycache__"} for part in relative.parts):
                continue
            record: Dict[str, Any] = {
                "path": str(relative).replace("\\", "/"),
                "type": "directory" if item.is_dir() else "file",
            }
            if item.is_file():
                try:
                    record["size"] = item.stat().st_size
                except OSError:
                    record["size"] = 0
            output.append(record)
            if len(output) >= entry_limit:
                break
        return output

    def run_command(
        self,
        command: str,
        cwd: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        confirmed: bool = False,
    ) -> Dict[str, Any]:
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command must be a non-empty string")
        if any(re.search(pattern, command, re.IGNORECASE) for pattern in self._DANGEROUS_PATTERNS) and not confirmed:
            return {
                "command": command,
                "cwd": str(self.workspace),
                "exit_code": -1,
                "stdout": "",
                "stderr": "Command blocked as potentially destructive; confirm explicitly to run it.",
                "timed_out": False,
                "blocked": True,
            }
        try:
            timeout_value = min(max(float(timeout), 0.05), self.MAX_TIMEOUT)
        except (TypeError, ValueError):
            timeout_value = self.DEFAULT_TIMEOUT
        working_dir = self.resolve(cwd or ".")
        if not working_dir.is_dir():
            raise NotADirectoryError(cwd or ".")
        started = time.monotonic()
        def needs_shell(value: str) -> bool:
            quote: Optional[str] = None
            escaped = False
            for character in value:
                if escaped:
                    escaped = False
                    continue
                if character == "\\" and os.name != "nt":
                    escaped = True
                    continue
                if quote:
                    if character == quote:
                        quote = None
                    continue
                if character in {"'", '"'}:
                    quote = character
                    continue
                if character in "|&<>\n" or (os.name != "nt" and character in ";()`$"):
                    return True
            try:
                first = shlex.split(value, posix=os.name != "nt")[0].strip('"').lower()
            except (ValueError, IndexError):
                return True
            windows_builtins = {"cd", "chdir", "cls", "copy", "del", "dir", "echo", "erase", "md", "mkdir", "move", "rd", "ren", "rename", "rmdir", "set", "type"}
            posix_builtins = {"cd", "export", "source", ".", "alias", "ulimit"}
            return first in (windows_builtins if os.name == "nt" else posix_builtins)

        use_shell = needs_shell(command)
        process_command: Any = command
        if not use_shell:
            process_command = shlex.split(command, posix=os.name != "nt")
            if os.name == "nt":
                process_command = [
                    token[1:-1] if len(token) >= 2 and token[0] == token[-1] == '"' else token
                    for token in process_command
                ]
        popen_options: Dict[str, Any] = {}
        if os.name == "nt":
            popen_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            popen_options["start_new_session"] = True
        process = subprocess.Popen(
            process_command,
            cwd=str(working_dir),
            shell=use_shell,
            # Do not expose provider credentials to arbitrary project
            # commands.  The agent can still use normal build/test variables,
            # while API keys and token-like secrets stay in the model client.
            env={
                key: value
                for key, value in os.environ.items()
                if not re.search(r"(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|PASSWORD|SECRET)", key, re.IGNORECASE)
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            **popen_options,
        )
        kill_job = _attach_windows_kill_job(process)
        try:
            stdout, stderr = process.communicate(timeout=timeout_value)
            stdout = stdout or ""
            stderr = stderr or ""
            timed_out = False
            exit_code = process.returncode
        except subprocess.TimeoutExpired:
            # Kill the entire process group/tree, not only the intermediate
            # shell.  Otherwise a child compiler/test process can keep the
            # stdout pipe open and defeat the timeout, especially on Windows.
            if kill_job:
                # Closing a kill-on-close Job terminates the shell and every
                # descendant that inherited our pipes.
                _close_windows_kill_job(kill_job)
                kill_job = None
            elif os.name == "nt" and use_shell:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            elif os.name == "nt":
                process.kill()
            else:
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    process.kill()
            try:
                stdout, stderr = process.communicate(timeout=1.0)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            stdout = stdout or ""
            stderr = stderr or ""
            timed_out = True
            exit_code = -1
            stderr = (stderr + "\nCommand timed out after %.2fs" % timeout_value).strip()
        finally:
            _close_windows_kill_job(kill_job)
        duration_ms = int((time.monotonic() - started) * 1000)
        return {
            "command": command,
            "cwd": str(working_dir),
            "exit_code": exit_code,
            "stdout": stdout[-self.MAX_OUTPUT_CHARS :],
            "stderr": stderr[-self.MAX_OUTPUT_CHARS :],
            "timed_out": timed_out,
            "blocked": False,
            "duration_ms": duration_ms,
        }