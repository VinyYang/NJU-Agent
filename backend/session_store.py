"""Small append-only session journal used by the local server.

The journal is intentionally boring: one JSON object per line, latest record
wins, and a delete tombstone removes a session on the next load. It is local
runtime state (``.runtime`` is git-ignored), not a cloud conversation store.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, Union


class SessionStore:
    MAX_RECORD_BYTES = 2 * 1024 * 1024

    def __init__(self, path: Union[Path, str]):
        self.path = Path(path)
        self._lock = threading.RLock()

    @staticmethod
    def _safe(value: Dict[str, Any]) -> Dict[str, Any]:
        # Never persist credential-shaped fields even if a future caller adds
        # them to a session payload.
        blocked = {"api_key", "openai_api_key", "model_api_key", "authorization"}
        def scrub(item: Any) -> Any:
            if isinstance(item, dict):
                return {key: scrub(child) for key, child in item.items() if key.lower() not in blocked}
            if isinstance(item, list):
                return [scrub(child) for child in item]
            return item
        return scrub(value)

    def _append(self, record: Dict[str, Any]) -> None:
        encoded = json.dumps(self._safe(record), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > self.MAX_RECORD_BYTES:
            raise ValueError("session record is too large")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("ab") as stream:
                stream.write(encoded + b"\n")
                stream.flush()
                try:
                    import os
                    os.fsync(stream.fileno())
                except OSError:
                    pass

    def save(self, session: Dict[str, Any]) -> None:
        self._append({"type": "snapshot", "id": str(session.get("id", "")), "session": session})

    def delete(self, session_id: str) -> None:
        self._append({"type": "delete", "id": str(session_id)})

    def load(self) -> Iterable[Dict[str, Any]]:
        if not self.path.is_file():
            return []
        latest: Dict[str, Dict[str, Any]] = {}
        try:
            with self._lock, self.path.open("rb") as stream:
                for raw in stream:
                    if len(raw) > self.MAX_RECORD_BYTES:
                        continue
                    try:
                        record = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    session_id = str(record.get("id", ""))
                    if not session_id:
                        continue
                    if record.get("type") == "delete":
                        latest.pop(session_id, None)
                    elif record.get("type") == "snapshot" and isinstance(record.get("session"), dict):
                        latest[session_id] = record["session"]
        except OSError:
            return []
        return list(latest.values())
