"""Plan state management and conflict handling for agent execution."""

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PlanState:
    steps: List[Dict[str, Any]] = field(default_factory=list)
    status: str = "proposed"
    notes: List[str] = field(default_factory=list)
    revision_count: int = 0
    updated_at: str = field(default_factory=_now)

    @classmethod
    def from_markdown(cls, markdown: str) -> "PlanState":
        steps: List[Dict[str, Any]] = []
        current: Optional[Dict[str, Any]] = None
        # A fenced code-block wrapper (``` / ~~~ with an optional language tag)
        # must never become a step nor stick to the previous step's text.
        fence_re = re.compile(r"^\s*(?:`{3,}|~{3,})\s*[\w+.-]*\s*$")
        for raw_line in (markdown or "").splitlines():
            line = raw_line.strip()
            if fence_re.match(line):
                current = None
                continue
            match = re.match(r"^(?:\d+[.)]|[-*])\s+(.+)$", line)
            if match:
                # Models frequently wrap code identifiers in inline backticks
                # (`index.html`, `#63065F`); strip them so plan steps render as
                # plain text instead of showing literal backticks.
                title = re.sub(r"`+", "", match.group(1)).strip()
                status = "pending"
                status_match = re.search(r"\s+\[(pending|active|completed|done|skipped|failed|todo|current)\]\s*$", title, re.IGNORECASE)
                if status_match:
                    status = status_match.group(1).lower()
                    status = {"done": "completed", "todo": "pending", "current": "active"}.get(status, status)
                    title = title[: status_match.start()].rstrip()
                current = {"id": "step-%d" % (len(steps) + 1), "title": title, "description": "", "status": status}
                steps.append(current)
            elif line and current is not None:
                current["description"] = (current["description"] + " " + re.sub(r"`+", "", line)).strip()
        return cls(steps=steps)

    @classmethod
    def from_task(cls, task: str) -> "PlanState":
        lower = (task or "").lower()
        steps = [
            {"id": "step-1", "title": "Inspect the workspace", "description": "Read the relevant files and existing tests before editing.", "status": "pending"},
            {"id": "step-2", "title": "Implement the requested change", "description": "Make the smallest coherent code change and preserve existing behavior.", "status": "pending"},
            {"id": "step-3", "title": "Add or update tests", "description": "Cover the new behavior and important edge cases.", "status": "pending"},
            {"id": "step-4", "title": "Run smoke tests and summarize", "description": "Execute the project test command and report files changed and results.", "status": "pending"},
        ]
        if any(word in lower for word in ("document", "readme", "文档")):
            steps.insert(2, {"id": "step-docs", "title": "Update documentation", "description": "Explain how to use the change.", "status": "pending"})
            for index, step in enumerate(steps):
                step["id"] = "step-%d" % (index + 1)
        return cls(steps=steps)

    def revise(self, feedback: str, replacement_markdown: Optional[str] = None) -> None:
        if replacement_markdown and replacement_markdown.strip():
            replacement = self.from_markdown(replacement_markdown)
            if replacement.steps:
                self.steps = replacement.steps
        if feedback and feedback.strip():
            self.notes.append(feedback.strip())
        self.revision_count += 1
        self.status = "proposed"
        self.updated_at = _now()

    def approve(self) -> None:
        if not self.steps:
            raise ValueError("cannot approve an empty plan")
        self.status = "approved"
        self.updated_at = _now()

    def set_step_status(self, step_id: str, status: str) -> None:
        allowed = {"pending", "active", "completed", "skipped", "failed"}
        if status not in allowed:
            raise ValueError("invalid step status")
        for step in self.steps:
            if step.get("id") == step_id:
                step["status"] = status
                self.updated_at = _now()
                return
        raise KeyError(step_id)

    def to_markdown(self) -> str:
        lines: List[str] = []
        for index, step in enumerate(self.steps, 1):
            suffix = " [%s]" % step.get("status", "pending")
            line = "%d. %s%s" % (index, step.get("title", ""), suffix)
            lines.append(line)
            if step.get("description"):
                lines.append("   " + str(step["description"]))
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "steps": self.steps,
            "status": self.status,
            "notes": self.notes,
            "revision_count": self.revision_count,
            "updated_at": self.updated_at,
            "markdown": self.to_markdown(),
        }


@dataclass
class RunResult:
    status: str
    message: str
    steps: int
    events: List[Dict[str, Any]] = field(default_factory=list)
    metrics: Dict[str, Any] = field(default_factory=dict)
    # ``plan``: clarification completed and the frontend should fetch the plan
    # in a separate short request; empty for every other result.
    next_action: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"status": self.status, "message": self.message, "steps": self.steps, "events": self.events, "metrics": self.metrics, "next_action": self.next_action}


class PlanConflictError(ValueError):
    """Raised when a client attempts to mutate an obsolete plan revision."""

    error_code = "stale_plan"
    status_code = 409