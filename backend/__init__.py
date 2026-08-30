"""Standalone coding-agent backend.

The package intentionally depends only on Python's standard library.  It
contains the model/tool loop used by the HTTP server in :mod:`backend.server`.
"""

from .agent_core import (
    AgentEngine,
    Conversation,
    DemoModel,
    LocalTools,
    ModelResponse,
    OpenAICompatibleModel,
    PlanState,
    Session,
    SessionManager,
    parse_model_response,
)

__all__ = [
    "AgentEngine",
    "Conversation",
    "DemoModel",
    "LocalTools",
    "ModelResponse",
    "OpenAICompatibleModel",
    "PlanState",
    "Session",
    "SessionManager",
    "parse_model_response",
]
