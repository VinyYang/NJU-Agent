"""Execution-engine API.

Re-exports the model/tool loop from :mod:`agent_core` so callers can depend
on a focused module while preserving the original import path.
"""

from .agent_core import AgentEngine

__all__ = ["AgentEngine"]
