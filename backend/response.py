"""Model response parsing utilities for OpenAI-compatible API responses."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple


@dataclass
class ModelResponse:
    """Normalized model output consumed by AgentEngine."""

    content: str = ""
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    raw: Any = None


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if text:
                    parts.append(str(text))
        return "".join(parts)
    return str(content)


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    for method_name in ("model_dump", "to_dict", "dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                converted = method()
                if isinstance(converted, dict):
                    return converted
            except Exception:
                pass
    return {}


def _parse_arguments(arguments: Any) -> Dict[str, Any]:
    if arguments is None:
        return {}
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return {"_raw": arguments}
    return {"value": arguments}


def _parse_text_tool_calls(content: str) -> Tuple[str, List[Dict[str, Any]]]:
    calls: List[Dict[str, Any]] = []
    pattern = re.compile(
        r"<tool_call(?:\s+name=[\"'](?P<name>[^\"]+)[\"'])?\s*>"
        r"(?P<args>.*?)",
        re.IGNORECASE | re.DOTALL,
    )
    remaining = content
    for match in pattern.finditer(content):
        name = match.group("name")
        raw = match.group("args").strip()
        parsed: Any
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"_raw": raw}
        if not name and isinstance(parsed, dict):
            name = str(parsed.pop("name", parsed.pop("tool", "")))
        if name:
            calls.append({
                "id": "text-" + uuid.uuid4().hex[:10],
                "name": name,
                "arguments": _parse_arguments(parsed),
            })
        remaining = remaining.replace(match.group(0), "")

    if not calls:
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL | re.IGNORECASE)
        candidate = fenced.group(1) if fenced else content.strip()
        try:
            parsed_json = json.loads(candidate)
        except (TypeError, json.JSONDecodeError):
            parsed_json = None
        if isinstance(parsed_json, dict) and isinstance(parsed_json.get("tool_calls"), list):
            for item in parsed_json["tool_calls"]:
                item_dict = _as_dict(item)
                function = _as_dict(item_dict.get("function"))
                name = item_dict.get("name") or function.get("name")
                if name:
                    calls.append({
                        "id": str(item_dict.get("id") or ("text-" + uuid.uuid4().hex[:10])),
                        "name": str(name),
                        "arguments": _parse_arguments(item_dict.get("arguments", function.get("arguments"))),
                    })
            if calls and fenced:
                remaining = remaining.replace(fenced.group(0), "")
    return remaining.strip(), calls


def parse_model_response(response: Any) -> ModelResponse:
    if isinstance(response, ModelResponse):
        return response
    data = _as_dict(response)
    if isinstance(data.get("output"), list):
        texts: List[str] = []
        calls: List[Dict[str, Any]] = []
        for item in data["output"]:
            item_dict = _as_dict(item)
            if item_dict.get("type") == "function_call":
                calls.append({
                    "id": str(item_dict.get("call_id") or item_dict.get("id") or ("call-" + str(len(calls) + 1))),
                    "name": str(item_dict.get("name") or ""),
                    "arguments": _parse_arguments(item_dict.get("arguments")),
                })
            if item_dict.get("type") == "message":
                texts.append(_content_to_text(item_dict.get("content")))
        content = str(data.get("output_text") or "") or "".join(texts)
        return ModelResponse(content=content, tool_calls=[call for call in calls if call["name"]], finish_reason=data.get("status"), raw=response)
    choices = data.get("choices")
    if choices is None:
        choices = getattr(response, "choices", None)
    first = choices[0] if choices else {}
    first_dict = _as_dict(first)
    message = first_dict.get("message") or getattr(first, "message", None) or first_dict.get("delta") or first
    message_dict = _as_dict(message)
    content = _content_to_text(message_dict.get("content", getattr(message, "content", "")))
    normalized_calls: List[Dict[str, Any]] = []
    native_calls = message_dict.get("tool_calls", getattr(message, "tool_calls", None)) or []
    for index, call in enumerate(native_calls):
        call_dict = _as_dict(call)
        function = _as_dict(call_dict.get("function"))
        name = call_dict.get("name") or function.get("name")
        if not name:
            continue
        arguments = call_dict.get("arguments")
        if arguments is None:
            arguments = function.get("arguments")
        normalized_calls.append({
            "id": str(call_dict.get("id") or ("call-" + str(index + 1))),
            "name": str(name),
            "arguments": _parse_arguments(arguments),
        })
    if not normalized_calls and content:
        content, normalized_calls = _parse_text_tool_calls(content)
    return ModelResponse(
        content=content,
        tool_calls=normalized_calls,
        finish_reason=first_dict.get("finish_reason"),
        raw=response,
    )
