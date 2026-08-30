"""Model abstraction layer for OpenAI-compatible and demo models."""

import json
import os
from typing import Any, Callable, Dict, Optional, Sequence, Iterator

from urllib import error as url_error
from urllib import request as url_request

from .response import ModelResponse, parse_model_response, _as_dict


class OpenAICompatibleModel:
    """Dependency-free client for OpenAI-compatible Responses or Chat APIs."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 120.0,
        wire_api: str | None = None,
        reasoning_effort: str | None = None,
    ):
        # ``None`` means "use the process configuration"; an explicitly
        # supplied empty string means the caller intentionally selected
        # offline/demo mode.  Using ``api_key or ...`` here made an empty key
        # silently fall back to a developer's environment and could trigger a
        # real network request from a supposedly offline test or UI session.
        configured_key = (
            api_key
            if api_key is not None
            else os.getenv("OPENAI_API_KEY") or os.getenv("MODEL_API_KEY")
        )
        self.api_key = str(configured_key).strip() if configured_key else None
        # Accept either a canonical API root or a copied endpoint URL from a
        # provider's docs.  The transport appends the selected wire endpoint
        # itself, so retaining /chat/completions or /responses would produce
        # invalid doubled paths and misleading connection failures.
        raw_base_url = (base_url or os.getenv("OPENAI_BASE_URL") or "https://xcpcai.com/v1").strip().rstrip("/")
        for suffix in ("/chat/completions", "/responses"):
            if raw_base_url.lower().endswith(suffix):
                raw_base_url = raw_base_url[: -len(suffix)].rstrip("/")
                break
        self.base_url = raw_base_url
        self.model = model or os.getenv("CODING_AGENT_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-5.6-sol"
        self.wire_api = (wire_api or os.getenv("MODEL_WIRE_API", "auto")).lower()
        self.reasoning_effort = reasoning_effort or os.getenv("MODEL_REASONING_EFFORT", "medium")
        # Codex configuration calls the strongest tier "ultra", while the
        # OpenAI-compatible gateway exposes the equivalent tier as "max".
        # Normalize at the transport boundary so both config styles work.
        if str(self.reasoning_effort).lower() == "ultra":
            self.reasoning_effort = "max"
        self.timeout = timeout
        # Records which protocol an ``auto`` probe settled on (used by
        # ``stream_text`` so plain chat and tool loops agree on one path).
        self._probed_protocol: Optional[str] = None

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def complete(self, messages: Sequence[Dict[str, Any]], tools: Sequence[Dict[str, Any]]) -> ModelResponse:
        if not self.api_key:
            raise RuntimeError("No model API key configured")
        if self.wire_api == "auto":
            # Some OpenAI-compatible gateways expose only Chat Completions,
            # while others expose both protocols. Probe Responses first (the
            # richer native tool format), then retry once with Chat Completions
            # when the endpoint rejects the request.
            try:
                return OpenAICompatibleModel(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    model=self.model,
                    timeout=self.timeout,
                    wire_api="responses",
                    reasoning_effort=self.reasoning_effort,
                ).complete(messages, tools)
            except RuntimeError as exc:
                if not any(token in str(exc) for token in ("HTTP 400", "HTTP 404", "HTTP 405")):
                    raise
                return OpenAICompatibleModel(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    model=self.model,
                    timeout=self.timeout,
                    wire_api="chat",
                    reasoning_effort=self.reasoning_effort,
                ).complete(messages, tools)
        effort = self.reasoning_effort
        if self.wire_api == "responses":
            input_items: list[dict[str, Any]] = []
            for message in messages:
                role = message.get("role")
                if role == "tool":
                    input_items.append({"type": "function_call_output", "call_id": message.get("tool_call_id"), "output": str(message.get("content", ""))})
                    continue
                if message.get("content"):
                    input_items.append({"role": role, "content": str(message.get("content", ""))})
                for call in message.get("tool_calls", []):
                    function = _as_dict(call.get("function"))
                    input_items.append({"type": "function_call", "call_id": call.get("id"), "name": function.get("name"), "arguments": function.get("arguments", "{}")})
            response_tools = []
            for tool in tools:
                function = _as_dict(tool.get("function"))
                response_tools.append({"type": "function", "name": function.get("name"), "description": function.get("description", ""), "parameters": function.get("parameters", {})})
            payload: dict[str, Any] = {"model": self.model, "input": input_items, "store": False}
            if effort: payload["reasoning"] = {"effort": effort}
            if response_tools: payload["tools"] = response_tools; payload["tool_choice"] = "auto"
            endpoint = "/responses"
        else:
            payload = {"model": self.model, "messages": list(messages), "temperature": 0.1}
            if effort: payload["reasoning_effort"] = effort
            if tools: payload["tools"] = list(tools); payload["tool_choice"] = "auto"
            endpoint = "/chat/completions"
        body = json.dumps(payload).encode("utf-8")
        req = url_request.Request(
            self.base_url + endpoint,
            data=body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key},
            method="POST",
        )
        try:
            with url_request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except url_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError("Model API HTTP %s: %s" % (exc.code, detail[:500]))
        except (url_error.URLError, TimeoutError) as exc:
            raise RuntimeError("Model API request failed: %s" % exc)
        try:
            return parse_model_response(json.loads(raw))
        except json.JSONDecodeError as exc:
            raise RuntimeError("Model API returned invalid JSON: %s" % exc)

    def stream_text(self, messages: Sequence[Dict[str, Any]]) -> Any:
        """Yield text deltas over the configured (or auto-probed) protocol."""
        if not self.api_key:
            raise RuntimeError("No model API key configured")
        if self.wire_api == "auto":
            try:
                yield from self._stream_responses_text(messages)
                self._probed_protocol = "responses"
                return
            except RuntimeError as exc:
                if not any(token in str(exc) for token in ("HTTP 400", "HTTP 404", "HTTP 405")):
                    raise
            self._probed_protocol = "chat"
        elif self.wire_api == "responses":
            yield from self._stream_responses_text(messages)
            return
        yield from self._stream_chat_text(messages)

    def _stream_chat_text(self, messages: Sequence[Dict[str, Any]]) -> Any:
        payload = {"model": self.model, "messages": list(messages), "stream": True}
        if self.reasoning_effort:
            payload["reasoning_effort"] = self.reasoning_effort
        req = url_request.Request(self.base_url + "/chat/completions", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key}, method="POST")
        with url_request.urlopen(req, timeout=self.timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
                if delta:
                    yield delta

    def _stream_responses_text(self, messages: Sequence[Dict[str, Any]]) -> Any:
        input_items = self._responses_input_items(messages)
        payload = {"model": self.model, "input": input_items, "stream": True, "store": False}
        if self.reasoning_effort:
            payload["reasoning"] = {"effort": self.reasoning_effort}
        req = url_request.Request(self.base_url + "/responses", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key}, method="POST")
        with url_request.urlopen(req, timeout=self.timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                typ = str(event.get("type", ""))
                piece = event.get("delta")
                if typ.endswith("output_text.delta") and piece:
                    yield str(piece)
                elif isinstance(piece, str) and "text" in typ and piece:
                    yield piece

    def stream_complete(self, messages: Sequence[Dict[str, Any]], tools: Sequence[Dict[str, Any]], on_delta=None, early_stop: Callable[[str], bool] | None = None) -> ModelResponse:
        """Stream a turn while retaining native tool calls.

        ``auto`` mirrors :meth:`complete`'s probe: try the Responses endpoint
        first, then retry once with Chat Completions when the gateway rejects
        the richer protocol.  Without this a Responses-only provider streams
        fine for plain chat but silently breaks the agent's tool loop.

        ``early_stop(content)`` may return True once the accumulated text is
        already a complete usable answer.  Intake JSON benefits from this:
        some gateways keep the socket open after a valid object, which would
        otherwise leave the UI stuck on the Stop button.
        """
        if not self.api_key:
            raise RuntimeError("No model API key configured")
        if self.wire_api == "auto":
            try:
                response = OpenAICompatibleModel(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    model=self.model,
                    timeout=self.timeout,
                    wire_api="responses",
                    reasoning_effort=self.reasoning_effort,
                ).stream_complete(messages, tools, on_delta, early_stop=early_stop)
                self._probed_protocol = "responses"
                return response
            except RuntimeError as exc:
                if not any(token in str(exc) for token in ("HTTP 400", "HTTP 404", "HTTP 405")):
                    raise
            self._probed_protocol = "chat"
            return OpenAICompatibleModel(
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.model,
                timeout=self.timeout,
                wire_api="chat",
                reasoning_effort=self.reasoning_effort,
            ).stream_complete(messages, tools, on_delta, early_stop=early_stop)
        if self.wire_api == "responses":
            return self._stream_responses_complete(messages, tools, on_delta, early_stop=early_stop)
        return self._stream_chat_complete(messages, tools, on_delta, early_stop=early_stop)

    def _stream_chat_complete(self, messages, tools, on_delta=None, early_stop: Callable[[str], bool] | None = None) -> ModelResponse:
        payload = {"model": self.model, "messages": list(messages), "stream": True}
        if self.reasoning_effort:
            payload["reasoning_effort"] = self.reasoning_effort
        if tools:
            payload["tools"] = list(tools)
            payload["tool_choice"] = "auto"
        req = url_request.Request(self.base_url + "/chat/completions", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key}, method="POST")
        content = ""
        calls: Dict[int, Dict[str, Any]] = {}
        with url_request.urlopen(req, timeout=self.timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = ((json.loads(data).get("choices") or [{}])[0].get("delta") or {})
                except json.JSONDecodeError:
                    continue
                piece = delta.get("content") or ""
                if piece:
                    content += piece
                    if on_delta:
                        on_delta(piece)
                    if early_stop and early_stop(content):
                        break
                for call in delta.get("tool_calls") or []:
                    idx = int(call.get("index", 0))
                    current = calls.setdefault(idx, {"id": call.get("id") or "call-%d" % idx, "name": "", "arguments": ""})
                    fn = call.get("function") or {}
                    current["name"] += fn.get("name") or ""
                    current["arguments"] += fn.get("arguments") or ""
                # Tool-call turns are not JSON-intake answers; never early-stop
                # while arguments are still streaming.
                if calls and early_stop:
                    continue
        parsed_calls = []
        for call in calls.values():
            try:
                args = json.loads(call["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            parsed_calls.append({"id": call["id"], "name": call["name"], "arguments": args})
        return ModelResponse(content=content, tool_calls=parsed_calls)

    @staticmethod
    def _responses_input_items(messages: Sequence[Dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert the OpenAI-compatible chat transcript into Responses input.

        Assistant ``tool_calls`` become native ``function_call`` items so the
        gateway still sees a complete call/result exchange; dropping them
        produced orphan ``function_call_output`` items that Responses-only
        gateways reject.
        """
        input_items: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            if role == "tool":
                input_items.append({
                    "type": "function_call_output",
                    "call_id": message.get("tool_call_id"),
                    "output": str(message.get("content", "")),
                })
                continue
            if message.get("content"):
                input_items.append({"role": role, "content": str(message.get("content", ""))})
            for call in message.get("tool_calls", []):
                function = _as_dict(call.get("function"))
                input_items.append({
                    "type": "function_call",
                    "call_id": call.get("id"),
                    "name": function.get("name"),
                    "arguments": function.get("arguments", "{}"),
                })
        return input_items

    @staticmethod
    def _responses_tools(tools: Sequence[Dict[str, Any]]) -> list[dict[str, Any]]:
        converted = []
        for tool in tools:
            function = _as_dict(tool.get("function"))
            converted.append({
                "type": "function",
                "name": function.get("name"),
                "description": function.get("description", ""),
                "parameters": function.get("parameters", {}),
            })
        return converted

    def _stream_responses_complete(self, messages, tools, on_delta=None, early_stop: Callable[[str], bool] | None = None) -> ModelResponse:
        input_items = self._responses_input_items(messages)
        response_tools = self._responses_tools(tools)
        payload: dict[str, Any] = {"model": self.model, "input": input_items, "stream": True, "store": False}
        if self.reasoning_effort:
            payload["reasoning"] = {"effort": self.reasoning_effort}
        # Without the tool schema the gateway cannot emit function calls and
        # the agent silently degrades to a text-only chat.
        if response_tools:
            payload["tools"] = response_tools
            payload["tool_choice"] = "auto"
        req = url_request.Request(self.base_url + "/responses", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key}, method="POST")
        content = ""
        calls: Dict[str, Dict[str, Any]] = {}
        with url_request.urlopen(req, timeout=self.timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                typ = str(event.get("type", ""))
                if typ.endswith("output_text.delta"):
                    piece = event.get("delta") or ""
                    content += str(piece)
                    if on_delta and piece:
                        on_delta(str(piece))
                    if early_stop and content and early_stop(content):
                        break
                if "function_call_arguments.delta" in typ:
                    item = event.get("item_id") or event.get("output_index", 0)
                    call = calls.setdefault(str(item), {"id": event.get("call_id") or str(item), "name": event.get("name") or "", "arguments": ""})
                    call["arguments"] += str(event.get("delta") or "")
                elif typ.endswith("output_item.added") and isinstance(event.get("item"), dict) and event["item"].get("type") == "function_call":
                    item = event["item"]
                    calls[str(item.get("id"))] = {"id": item.get("call_id") or item.get("id"), "name": item.get("name") or "", "arguments": ""}
                if typ.endswith("completed") or typ == "response.completed":
                    break
        parsed = []
        for call in calls.values():
            try:
                args = json.loads(call["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            parsed.append({"id": call["id"], "name": call["name"], "arguments": args})
        return ModelResponse(content=content, tool_calls=parsed)


class DemoModel:
    """Offline fallback used when no API key is configured.

    It keeps the UI demonstrable and makes smoke tests deterministic.  It does
    not pretend to be a full language model, but it deliberately exercises the
    same local tool loop as a remote model: inspect the workspace, run a safe
    verification command, then summarize the result.  This makes the safety
    boundary and event stream visible even when a user has not configured a
    provider key.
    """

    def __init__(self, task: str = ""):
        self.task = task
        self.calls = 0

    def complete(self, messages: Sequence[Dict[str, Any]], tools: Sequence[Dict[str, Any]]) -> ModelResponse:
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(
                content="Demo mode: inspecting the opened workspace before verification.",
                tool_calls=[{"id": "demo-list", "name": "list_tree", "arguments": {"path": "."}}],
            )
        if self.calls == 2:
            # Prefer the repository's own tests when the preceding tree result
            # contains a test directory.  Otherwise use a harmless Python
            # command so the offline path still demonstrates subprocess
            # execution without guessing a project-specific test runner.
            transcript = json.dumps(list(messages), ensure_ascii=False).lower()
            if "backend/tests" in transcript:
                command = "python -m unittest discover -s backend/tests -v"
            elif "tests/" in transcript or '"tests"' in transcript:
                command = "python -m unittest discover -s tests -v"
            else:
                command = "python -c \"print('CodePilot verification: no test directory detected')\""
            return ModelResponse(
                content="Workspace inspected. Running a verification command now.",
                tool_calls=[{"id": "demo-verify", "name": "run_command", "arguments": {"command": command, "timeout": 30}}],
            )
        return ModelResponse(
            content=(
                "Demo run finished: local inspection and verification completed. "
                "Configure OPENAI_API_KEY (or MODEL_API_KEY) for autonomous model-guided edits."
            )
        )
