"""Small, dependency-free user authentication store for the local agent.

Passwords are never stored in plaintext.  SQLite keeps registrations across
server restarts while bearer tokens remain short-lived in memory.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional


class AuthError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class AuthStore:
    TOKEN_TTL = 7 * 24 * 60 * 60
    USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@+-]{3,64}$")

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._tokens: Dict[str, tuple[int, float]] = {}
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, email TEXT, phone TEXT, salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at REAL NOT NULL)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            if "email" not in columns: db.execute("ALTER TABLE users ADD COLUMN email TEXT")
            if "phone" not in columns: db.execute("ALTER TABLE users ADD COLUMN phone TEXT")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL AND email <> ''")
            db.execute("CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at REAL NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)")
            db.execute("CREATE TABLE IF NOT EXISTS auth_tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at REAL NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)")
            # Migrate legacy installations that stored provider credentials in
            # account settings.  Secrets must not remain in the database.
            for row in db.execute("SELECT user_id, settings FROM user_settings").fetchall():
                try:
                    value = json.loads(row["settings"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if isinstance(value, dict) and any(str(k).lower() in {"api_key", "openai_api_key", "model_api_key", "authorization"} for k in value):
                    safe = {k: v for k, v in value.items() if str(k).lower() not in {"api_key", "openai_api_key", "model_api_key", "authorization"}}
                    db.execute("UPDATE user_settings SET settings = ?, updated_at = ? WHERE user_id = ?", (json.dumps(safe, ensure_ascii=False), time.time(), row["user_id"]))
            db.commit()

    @contextmanager
    def _connect(self):
        """Yield a connection and always close it (important on Windows)."""
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @staticmethod
    def _hash(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000)

    @classmethod
    def _validate(cls, username: object, password: object) -> tuple[str, str]:
        name = str(username or "").strip()
        secret = str(password or "")
        if not cls.USERNAME_RE.fullmatch(name):
            raise AuthError("username must be 3-64 characters (letters, numbers, email symbols, . _ + -)")
        if len(secret) < 6 or len(secret) > 256:
            raise AuthError("password must be 6-256 characters")
        return name, secret

    @staticmethod
    def _public(row: sqlite3.Row) -> Dict[str, object]:
        return {"id": int(row["id"]), "username": row["username"], "email": row["email"], "created_at": row["created_at"]}

    def register(self, username: object, password: object, email: object = "", phone: object = "") -> Dict[str, object]:
        name, secret = self._validate(username, password)
        key = name.casefold()
        salt = secrets.token_bytes(16)
        digest = self._hash(secret, salt)
        with self._lock, self._connect() as db:
            try:
                cursor = db.execute("INSERT INTO users(username, username_key, email, phone, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (name, key, str(email or "").strip() or None, str(phone or "").strip() or None, salt, digest, time.time()))
                db.commit()
            except sqlite3.IntegrityError as exc:
                raise AuthError("username is already registered", 409) from exc
            row = db.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return self._public(row)

    def login(self, username: object, password: object) -> tuple[str, Dict[str, object]]:
        name = str(username or "").strip()
        secret = str(password or "")
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE username_key = ? OR lower(COALESCE(email, '')) = ?", (name.casefold(), name.casefold())).fetchone()
        if row is None or not hmac.compare_digest(self._hash(secret, row["salt"]), row["password_hash"]):
            raise AuthError("invalid username or password", 401)
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._tokens[token] = (int(row["id"]), time.time() + self.TOKEN_TTL)
            with self._connect() as db:
                db.execute("INSERT OR REPLACE INTO auth_tokens(token,user_id,expires_at) VALUES(?,?,?)", (token, int(row["id"]), time.time() + self.TOKEN_TTL)); db.commit()
        return token, self._public(row)

    def user_for_token(self, token: object) -> Optional[Dict[str, object]]:
        value = str(token or "").strip()
        with self._lock:
            record = self._tokens.get(value)
            if not record:
                with self._connect() as db:
                    row = db.execute("SELECT user_id, expires_at FROM auth_tokens WHERE token = ?", (value,)).fetchone()
                if row: record = (int(row["user_id"]), float(row["expires_at"])); self._tokens[value] = record
            if not record:
                return None
            user_id, expires = record
            if expires <= time.time():
                self._tokens.pop(value, None)
                return None
        with self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._public(row) if row else None

    def logout(self, token: object) -> None:
        with self._lock:
            self._tokens.pop(str(token or "").strip(), None)
            with self._connect() as db:
                db.execute("DELETE FROM auth_tokens WHERE token = ?", (str(token or "").strip(),)); db.commit()

    def update_profile(self, user_id: int, username: object = None, email: object = None, phone: object = None) -> Dict[str, object]:
        """Update a user's display name / contact fields.  Uniqueness on the
        username and (when set) the email is enforced, ignoring the row itself.
        """
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if row is None:
                raise AuthError("user not found", 404)
            new_name = str(username if username is not None else row["username"] or "").strip() or str(row["username"])
            if not self.USERNAME_RE.fullmatch(new_name):
                raise AuthError("username must be 3-64 characters (letters, numbers, email symbols, . _ + -)")
            new_email = str(email if email is not None else row["email"] or "").strip() or None
            new_phone = str(phone if phone is not None else row["phone"] or "").strip() or None
            if new_name.casefold() != row["username_key"]:
                clash = db.execute("SELECT 1 FROM users WHERE username_key = ? AND id <> ?", (new_name.casefold(), int(user_id))).fetchone()
                if clash:
                    raise AuthError("username is already registered", 409)
            if new_email:
                clash = db.execute("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?", (new_email.casefold(), int(user_id))).fetchone()
                if clash:
                    raise AuthError("email is already registered", 409)
            db.execute(
                "UPDATE users SET username = ?, username_key = ?, email = ?, phone = ? WHERE id = ?",
                (new_name, new_name.casefold(), new_email, new_phone, int(user_id)),
            )
            db.commit()
            updated = db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
        return self._public(updated)

    def change_password(self, user_id: int, current_password: object = None, new_password: object = None) -> None:
        """Verify the current password and replace it with a fresh one."""
        secret = str(current_password or "")
        fresh = str(new_password or "")
        if len(fresh) < 6 or len(fresh) > 256:
            raise AuthError("password must be 6-256 characters")
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
            if row is None:
                raise AuthError("user not found", 404)
            if not secret or not hmac.compare_digest(self._hash(secret, row["salt"]), row["password_hash"]):
                raise AuthError("current password is incorrect", 401)
            salt = secrets.token_bytes(16)
            db.execute("UPDATE users SET salt = ?, password_hash = ? WHERE id = ?", (salt, self._hash(fresh, salt), int(user_id)))
            db.commit()

    def user_settings(self, user_id: int) -> Dict[str, object]:
        with self._connect() as db:
            row = db.execute("SELECT settings FROM user_settings WHERE user_id = ?", (int(user_id),)).fetchone()
        if not row:
            return {}
        try:
            value = json.loads(row["settings"])
            return value if isinstance(value, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}

    def save_user_settings(self, user_id: int, settings: Dict[str, object]) -> None:
        blocked = {"api_key", "openai_api_key", "model_api_key", "authorization"}
        safe_settings = {key: value for key, value in settings.items() if str(key).lower() not in blocked}
        payload = json.dumps(safe_settings, ensure_ascii=False)
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO user_settings(user_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings, updated_at=excluded.updated_at", (int(user_id), payload, time.time()))
            db.commit()
