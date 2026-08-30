"""Utility functions for CodePilot backend.

This module contains helper functions used across the backend,
such as path handling, data transformation, and HTTP utilities.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any, Dict, List, Optional


def json_bytes(value: Any) -> bytes:
    """Convert a value to JSON bytes with UTF-8 encoding."""
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def user_text(value: Any) -> str:
    """Convert common English errors to user-readable Chinese."""
    text = str(value or "")
    replacements = (
        ("No model API key configured", "尚未配置模型 API Key"),
        ("API key is required", "请先配置 API key（密钥）"),
        ("Model API request failed:", "模型服务请求失败："),
        ("Model API HTTP", "模型服务 HTTP 错误"),
        ("Model API returned invalid JSON", "模型服务返回了无效数据"),
        ("planner failed; retry", "计划生成失败，请重试"),
        ("complete clarification and approve the plan before running tools", "请先完成需求澄清并确认计划，再执行工具"),
        ("approve the plan before running tools", "请先确认计划，再执行工具"),
        ("The model returned an empty response", "模型返回了空内容，请重试"),
        ("network error", "网络连接中断"),
        ("Network Error", "网络连接中断"),
        ("Failed to fetch", "无法连接后端服务"),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    return text


def path_parts(path: str) -> List[str]:
    """Split a URL path into unquoted parts."""
    return [urllib.parse.unquote(part) for part in path.split("/") if part]


def nested_tree(items: List[Dict[str, Any]], root_name: str) -> Dict[str, Any]:
    """Convert flat ``list_tree`` records to the shape used by the UI."""
    root: Dict[str, Any] = {"name": root_name or "workspace", "type": "directory", "children": []}
    directories: Dict[str, Dict[str, Any]] = {"": root}
    for item in items:
        relative = str(item.get("path", "")).replace("\\", "/").strip("/")
        if not relative:
            continue
        bits = relative.split("/")
        parent_path = ""
        for index, bit in enumerate(bits):
            current_path = bit if not parent_path else parent_path + "/" + bit
            parent = directories.get(parent_path)
            if parent is None:
                break
            existing = next((child for child in parent["children"] if child.get("name") == bit), None)
            if existing is None:
                is_dir = index < len(bits) - 1 or item.get("type") == "directory"
                existing = {"name": bit, "type": "directory" if is_dir else "file"}
                if is_dir:
                    existing["children"] = []
                    directories[current_path] = existing
                else:
                    existing["path"] = relative
                    if "size" in item:
                        existing["size"] = item["size"]
                parent["children"].append(existing)
            elif existing.get("type") == "directory":
                directories[current_path] = existing
            parent_path = current_path
    return root


def plan_value_to_markdown(value: Any) -> Optional[str]:
    """Normalize the editable plan shapes accepted by the HTTP API.

    The browser sends a list of step objects, while small API clients often
    send markdown or a list of strings.  Keeping this conversion at the
    transport boundary means ``PlanState`` only has one parser and, more
    importantly, an empty/invalid list is not silently treated as approval of
    the previous revision.
    """
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        if not value:
            return None
        if all(isinstance(item, str) for item in value):
            return "\n".join(f"- {item}" for item in value)
        if all(isinstance(item, dict) for item in value):
            # The frontend editor uses ``title`` while older API clients use
            # ``text``.  Never stringify the whole dict as a step title: that
            # leaks Python repr syntax into the plan UI on later revisions.
            def step_title(item: dict) -> str:
                title = item.get("text") or item.get("title") or item.get("name")
                return str(title).strip() if title is not None else ""

            lines = [f"- {step_title(item)}" for item in value if step_title(item)]
            return "\n".join(lines) or None
    return None
