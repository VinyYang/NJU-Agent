"""Configuration management for CodePilot backend.

This module handles loading, saving, and accessing configuration settings
from environment variables and the local .env file.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict


def _settings_env_path() -> Path:
    """Get the path to the local .env file."""
    return Path(__file__).resolve().parent.parent / ".env"


def load_local_env(path: Path | None = None) -> None:
    """Load environment variables from a .env file."""
    if path is None:
        path = _settings_env_path()
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        return


def _env_file_value(key: str) -> Optional[str]:
    """Read a single key value from the local .env file without touching os.environ.

    The running server may load its environment at startup; if .env is edited
    later (or a stale empty var already shadows the file) os.getenv stays stale.
    Falling back to the file keeps ``api_key_configured`` truthful about what
    the user actually saved in .env.
    """
    try:
        path = _settings_env_path()
        if not path.is_file():
            return None
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == key:
                cleaned = value.strip().strip('"').strip("'")
                return cleaned or None
    except OSError:
        return None
    return None


def resolve_api_key() -> Optional[str]:
    """Resolve the model API key: env first, then the local .env file.

    The server loads .env into os.environ at startup, so os.getenv is usually
    enough.  Falling back to the file covers the case where .env was edited
    after the process started (or a stale empty var shadows the real value) —
    both callers (settings report and per-request model construction) must
    agree on the same key.
    """
    return os.getenv("OPENAI_API_KEY") or os.getenv("MODEL_API_KEY") or _env_file_value("OPENAI_API_KEY") or _env_file_value("MODEL_API_KEY")


def get_current_settings() -> Dict[str, str]:
    """Get current model and API settings from environment (with .env fallback)."""
    return {
        "base_url": os.getenv("OPENAI_BASE_URL", _env_file_value("OPENAI_BASE_URL") or "https://xcpcai.com/v1"),
        "model": os.getenv("CODING_AGENT_MODEL", os.getenv("OPENAI_MODEL", _env_file_value("CODING_AGENT_MODEL") or _env_file_value("OPENAI_MODEL") or "gpt-5.6-sol")),
        "wire_api": os.getenv("MODEL_WIRE_API", _env_file_value("MODEL_WIRE_API") or "auto"),
        "reasoning_effort": os.getenv("MODEL_REASONING_EFFORT", _env_file_value("MODEL_REASONING_EFFORT") or "medium"),
        "api_key_configured": "true" if resolve_api_key() else "false",
    }


def write_local_settings(settings: Dict[str, Any]) -> None:
    """Write settings to the local .env file and update environment."""
    values = {
        "OPENAI_API_KEY": str(settings.get("api_key") or ""),
        "OPENAI_BASE_URL": str(settings.get("base_url") or "https://xcpcai.com/v1").rstrip("/"),
        "CODING_AGENT_MODEL": str(settings.get("model") or "gpt-5.6-sol"),
        "MODEL_WIRE_API": str(settings.get("wire_api") or "auto"),
        "MODEL_REASONING_EFFORT": str(settings.get("reasoning_effort") or "medium"),
    }
    path = _settings_env_path()
    path.write_text(
        "# CodePilot local model settings (ignored by git)\n"
        + "\n".join(f"{key}={value}" for key, value in values.items())
        + "\n",
        encoding="utf-8",
    )
    for key, value in values.items():
        os.environ[key] = value