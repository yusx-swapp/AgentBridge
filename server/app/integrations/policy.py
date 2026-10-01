"""Small, stateless runtime policy interface used by the platform routes.

Policies validate already-authorized requests and format runtime metadata. They
never import the application, access the database, queue input or send frames;
the caller owns authorization, persistence and transport, in that order.
The default deliberately retains the existing CLI runtime behavior.
"""
from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from fastapi import HTTPException

if TYPE_CHECKING:
    from ..models import Agent, Session


class InputRejected(Exception):
    """A safe wire response; callers must send it without queuing the input."""

    def __init__(self, frame: dict):
        super().__init__(frame["message"])
        self.frame = frame


class RuntimePolicy:
    renderer: str | None = None
    restore_events = False
    library_continuation = False
    identity_fields = {"runtime", "local_project_id", "runtime_config"}

    def validate_create_fields(self, body: dict) -> None:
        pass

    def validate_local_project(self, project_id: str | None) -> None:
        pass

    def create_config(self, body: dict) -> dict:
        return body.get("runtime_config") or {}

    def validate_create_capabilities(self, config: dict, capabilities: object) -> None:
        """Validate runtime-owned references against this Machine's inventory."""
        pass

    def initialize_agent(self, agent: Agent) -> None:
        pass

    def validate_agent_update(self, agent: Agent, body: dict) -> dict | None:
        """Validate without mutation; return changed desired config, or None.

        The platform checks active conversations before applying a returned
        config and calls initialize_agent only when the desired revision changes.
        Ordinary runtimes retain their display-only update behavior.
        """
        if self.identity_fields & body.keys():
            raise HTTPException(422, "this endpoint only supports display renames")
        self.validate_update_fields(body)
        return None

    def validate_update_fields(self, body: dict) -> None:
        if body.keys() - self.identity_fields - {"display_name"}:
            raise HTTPException(422, "unsupported Agent update field")

    def require_retry(self) -> None:
        raise HTTPException(422, "this runtime does not support provisioning retry")

    def retry_agent(self, agent: Agent, body: dict) -> None:
        self.require_retry()

    def observed_status(self, agent: Agent, status: object) -> dict | None:
        return None

    def status_notification(self, agent: Agent) -> dict | None:
        return None

    def validate_project_migration(self, agent: Agent, project_id: str) -> None:
        pass

    def validate_project_removal(self) -> None:
        pass

    def session_fields(self, agent: Agent) -> dict:
        return {"runtime": agent.runtime, "runtime_status": agent.runtime_status,
                "renderer": self.renderer}

    def session_surface(self, surface: str | None, *, error_status: int = 422) -> str | None:
        return surface

    def stored_surface(self, surface: str | None) -> str | None:
        return surface

    def command_rejection(self, kind: str) -> dict | None:
        return None

    def input_rejection(self, sess: Session, frame: dict, code: str, message: str) -> dict:
        response = {"type": "error", "message": message}
        if code == "read_only":
            response["code"] = code
        return response

    def client_input_id(self, frame: dict) -> str:
        return str(UUID(str(frame.get("client_input_id") or uuid4())))

    def validate_input_options(self, sess: Session, frame: dict) -> None:
        pass

    def prepare_input(self, sess: Session, frame: dict) -> tuple[str, str]:
        """Validate without side effects, before local queuing or forwarding."""
        try:
            client_input_id = self.client_input_id(frame)
        except (TypeError, ValueError, AttributeError):
            raise InputRejected(self.input_rejection(
                sess, frame, "invalid_input_id", "invalid client_input_id")) from None
        data = frame.get("data", "")
        if not isinstance(data, str):
            raise InputRejected(self.input_rejection(
                sess, frame, "invalid_data", "invalid input data"))
        self.validate_input_options(sess, frame)
        return client_input_id, data

    def acknowledged_input_id(self, original: str, canonical: str) -> str | None:
        return canonical
