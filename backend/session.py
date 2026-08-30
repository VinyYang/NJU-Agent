"""Session-facing API.

The implementation remains imported from :mod:`agent_core` for compatibility
with older integrations.  This module is the stable home for new code and
provides a migration path while the coordinator is incrementally decomposed.
"""

from .agent_core import Conversation, Session, SessionManager

# Explicit factory helpers keep construction independent of the coordinator.
def create_session_manager(default_workspace=None, store_path=None):
    return SessionManager(default_workspace=default_workspace, store_path=store_path)

__all__ = ["Conversation", "Session", "SessionManager"]
