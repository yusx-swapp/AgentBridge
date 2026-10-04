"""Focused contract tests for the Server's stateless runtime policy seam."""

# ---------------------------------------------------------------------------
# Integration policy and runtime descriptors
# ---------------------------------------------------------------------------
from copy import deepcopy
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException
import pytest

from server.app.integrations import InputRejected, RuntimePolicy, runtime_policy
from server.app.integrations.deeporca import DeepOrcaPolicy
from server.app.integrations.deeporca import desired


ROOT = Path(__file__).resolve().parents[1]
INPUT_ID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"
SESSION = SimpleNamespace(id="session", agent_id="agent")


def agent(runtime="deeporca"):
    return SimpleNamespace(id="agent", devbox_id="box", runtime=runtime,
                           local_project_id="project", runtime_config={}, runtime_status=None)


def test_server_extension_imports_without_app_database_connector_or_sdk(tmp_path):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("AGENTBRIDGE_", "DEEPBOX_"))}
    env.update(PYTHON_DOTENV_DISABLED="1", DEEPBOX_ENV="test",
               DEEPBOX_DATABASE_URL=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
               DEEPBOX_DATA_DIR=str(tmp_path))
    code = "\n".join((
        "import sys",
        "from server.app.integrations import runtime_policy",
        "assert runtime_policy('deeporca').renderer == 'deeporca-chat-v1'",
        "assert 'server.app.main' not in sys.modules",
        "assert 'server.app.models' not in sys.modules",
        "assert 'server.app.hub' not in sys.modules",
        "assert not any(n == 'connector' or n.startswith('connector.') for n in sys.modules)",
        "assert not any(n == 'deeporca' or n.startswith('deeporca.') for n in sys.modules)",
    ))
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "test.db").exists()


def test_platform_main_has_no_deeporca_contract_or_runtime_branches():
    source = (ROOT / "server/app/main.py").read_text(encoding="utf-8")
    assert "deeporca" not in source.lower()
    assert "from .integrations import InputRejected, runtime_policy" in source


@pytest.mark.parametrize("runtime", [None, "codex-cli", "claude-code", "codex", "copilot", "future-runtime"])
def test_default_policy_preserves_existing_runtime_behavior(runtime):
    policy = runtime_policy(runtime)
    assert type(policy) is RuntimePolicy
    record = agent(runtime)
    policy.validate_create_fields({"cwd": "legacy-path", "launch_cmd": "legacy-command"})
    policy.validate_local_project(None)
    config = {"custom_cli_setting": "unchanged"}
    assert policy.create_config({"runtime_config": config}) is config
    policy.initialize_agent(record)
    assert record.runtime_status is None
    assert policy.status_notification(record) is None
    assert policy.observed_status(record, {"state": "ready"}) is None
    policy.validate_project_migration(record, "other-project")
    policy.validate_project_removal()
    for surface in (None, "structured", "terminal"):
        assert policy.session_surface(surface) == surface
        assert policy.stored_surface(surface) == surface
    assert not policy.restore_events
    assert policy.session_fields(record) == {
        "runtime": runtime, "runtime_status": None, "renderer": None}
    assert policy.command_rejection("permission") is None
    frame = {"client_input_id": INPUT_ID, "data": "text", "options": {"permission_mode": "plan"},
             "cli_only_field": True}
    assert policy.prepare_input(SESSION, frame) == (str(UUID(INPUT_ID)), "text")
    assert policy.acknowledged_input_id(INPUT_ID, str(UUID(INPUT_ID))) == str(UUID(INPUT_ID))
    with pytest.raises(InputRejected) as failure:
        policy.prepare_input(SESSION, {"client_input_id": "not-a-uuid"})
    assert failure.value.frame == {"type": "error", "message": "invalid client_input_id"}
    with pytest.raises(HTTPException) as failure:
        policy.require_retry()
    assert failure.value.status_code == 422


def test_desired_status_policy_has_no_persistence_or_notification_side_effects():
    policy = runtime_policy("deeporca")
    assert isinstance(policy, DeepOrcaPolicy)
    record = agent()
    policy.initialize_agent(record)
    pending = deepcopy(record.runtime_status)
    ready = {"state": "ready", "revision": pending["revision"]}
    assert policy.observed_status(record, ready) == ready
    assert record.runtime_status == pending
    assert policy.status_notification(record) == {
        "type": "agent.runtime_status", "agent_id": "agent", "devbox_id": "box",
        "runtime": "deeporca", "renderer": "deeporca-chat-v1", "runtime_status": pending}
    for bad in (None, [], {**ready, "revision": "stale"}, {**ready, "state": []},
                {**ready, "state": "unknown"}, {**ready, "detail": "private-path"},
                {**ready, "code": None}, {**ready, "code": "private/path"}):
        assert policy.observed_status(record, bad) is None
    assert record.runtime_status == pending
    record.runtime_status = ready
    policy.retry_agent(record, {})
    assert record.runtime_status == pending
    with pytest.raises(HTTPException) as failure:
        policy.retry_agent(record, {"credentials": "do-not-accept"})
    assert failure.value.status_code == 422
    record.local_project_id = None
    with pytest.raises(HTTPException) as failure:
        desired.pending_status(record)
    assert failure.value.status_code == 409


def test_deeporca_input_and_renderer_policy_do_not_modify_request_options():
    policy = runtime_policy("deeporca")
    frame = {"type": "input", "session_id": "session", "client_input_id": INPUT_ID,
             "data": "text", "options": {"model": "safe-model"}}
    original = deepcopy(frame)
    assert policy.prepare_input(SESSION, frame) == (INPUT_ID, "text")
    assert frame == original  # binding defaults are not per-turn input options
    assert policy.acknowledged_input_id(INPUT_ID, str(UUID(INPUT_ID))) == INPUT_ID
    assert policy.acknowledged_input_id("x" * 129, "unused") is None
    assert policy.command_rejection("permission") == {
        "type": "error", "code": "approval_not_supported",
        "message": "DeepOrca does not support approval responses"}
    assert policy.command_rejection("input") is None
    assert policy.restore_events
    assert policy.stored_surface("terminal") == "structured"
    assert policy.session_surface(None) == "structured"
    for status in (400, 422):
        with pytest.raises(HTTPException) as failure:
            policy.session_surface("terminal", error_status=status)
        assert failure.value.status_code == status


@pytest.mark.parametrize("change,code,message", [
    ({"client_input_id": None}, "invalid_input_id", "invalid client_input_id"),
    ({"client_input_id": "x" * 200}, "invalid_input_id", "invalid client_input_id"),
    ({"data": []}, "invalid_data", "invalid input data"),
    ({"options": {"approval_mode": "never"}}, "invalid_options",
     "DeepOrca only supports text input and model options"),
    ({"options": {"model": "../private"}}, "invalid_options",
     "DeepOrca model must be a safe identifier of at most 128 characters"),
])
def test_policy_rejections_are_safe_bounded_and_correlated(change, code, message):
    frame = {"type": "stdin", "session_id": "session", "client_input_id": INPUT_ID,
             "data": "private text", **change}
    with pytest.raises(InputRejected) as failure:
        runtime_policy("deeporca").prepare_input(SESSION, frame)
    input_id = frame.get("client_input_id")
    assert failure.value.frame == {
        "type": "input_ack", "status": "rejected", "agent_id": "agent", "session_id": "session",
        "client_input_id": input_id[:128] if isinstance(input_id, str) else None,
        "reason": code, "code": code, "message": message}

# ---------------------------------------------------------------------------
# Authorized routes and lifecycle controls
# ---------------------------------------------------------------------------
"""Hermetic DeepOrca desired/observed state and HTTP/WebSocket regressions."""
import asyncio
import datetime as dt
import importlib
import os
from unittest.mock import AsyncMock, patch

import pytest

from agentbridge.integrations.deeporca.contract import (
    EMBEDDED_API_VERSION, RENDERER_ID, RUNTIME_ID,
    binding_revision, validate_runtime_config,
)


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.startswith(("AGENTBRIDGE_", "DEEPBOX_")):
            monkeypatch.delenv(key)
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setenv("DEEPBOX_DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("DEEPBOX_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DEEPBOX_ENV", "test")
    monkeypatch.setenv("DEEPBOX_REGISTRATION_ENABLED", "true")
    from server.app import config, models, main, live
    from server.app.hub import Hub
    from fastapi.testclient import TestClient

    importlib.reload(config)
    importlib.reload(models)
    importlib.reload(main)
    monkeypatch.setattr(main, "hub", Hub())
    monkeypatch.setattr(live, "DATA_DIR", tmp_path / "recordings")
    live.DATA_DIR.mkdir()
    monkeypatch.setattr(main, "live_registry", live.LiveRegistry())
    with TestClient(main.app) as client:
        assert client.post("/api/auth/register", json={
            "username": "owner", "password": "strong-password"}).status_code == 200
        yield client, main
    for session in main.live_registry._sessions.values():
        session._cast.close()
    models._engine.dispose()


def machine(client, name="box"):
    result = client.post("/api/devboxes", json={"name": name}).json()
    headers = {"authorization": "Bearer " + result["token"]}
    project = name + "-project"
    response = client.post(f"/api/devboxes/{result['devbox']['id']}/projects", headers=headers, json={
        "projects": [{"id": project, "handle": "repo", "name": "Repository"}]})
    assert response.status_code == 200, response.text
    return result["devbox"]["id"], headers, project


def create(client, box, project, **extra):
    return client.post(f"/api/devboxes/{box}/agents", json={
        "handle": "orca", "runtime": RUNTIME_ID, "local_project_id": project, **extra})


def attach(ws, session_id):
    ws.send_json({"type": "attach", "session_id": session_id})
    frames = [ws.receive_json() for _ in range(3)]
    assert {frame["type"] for frame in frames} == {"collaboration", "restore", "status"}
    return frames


def assert_input_rejected(ack, frame, agent_id, code, message):
    input_id = frame.get("client_input_id")
    assert ack == {
        "type": "input_ack", "status": "rejected", "session_id": frame["session_id"],
        "agent_id": agent_id,
        "client_input_id": input_id[:128] if isinstance(input_id, str) else None,
        "reason": code, "code": code, "message": message,
    }


def test_runtime_policy_is_not_consulted_before_http_authorization(app_client):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project).json()
    assert client.post("/api/auth/register", json={
        "username": "outsider", "password": "strong-password"}).status_code == 200
    # Deliberately invalid bodies must not reveal runtime policy to nonmembers.
    with patch.object(main, "runtime_policy", side_effect=AssertionError("policy before authorization")):
        assert client.post(f"/api/devboxes/{box}/agents", json={
            "runtime": RUNTIME_ID, "cwd": "private"}).status_code == 404
        assert client.patch(f"/api/agents/{agent['id']}", json={
            "runtime_config": None}).status_code == 404
        assert client.post(f"/api/agents/{agent['id']}/runtime/retry", json={
            "credentials": "private"}).status_code == 404
        assert client.post(f"/api/agents/{agent['id']}/sessions", json={
            "surface": "terminal"}).status_code == 404


def test_shared_contract_default_and_canonical_revision():
    assert (RUNTIME_ID, RENDERER_ID, EMBEDDED_API_VERSION) == ("deeporca", "deeporca-chat-v1", 1)
    config = validate_runtime_config({})
    assert config == {"integration_version": 1, "profile": {
        "mode": "create", "configuration_template_ref": "connector-default"}}
    assert binding_revision("a", "p", {}) == binding_revision("a", "p", config)
    assert len(binding_revision("a", "p", config)) == 16
    assert binding_revision("a", "p", config) != binding_revision("b", "p", config)
    assert binding_revision("a", "p", config) != binding_revision("a", "q", config)
    assert binding_revision("a", "p", config) != binding_revision("a", "p", {"model": "model-1"})
    config["profile"]["mode"] = "bad"
    assert validate_runtime_config({})["profile"]["mode"] == "create"


INVALID_CONFIGS = [
    None, [], "path", {"integration_version": True}, {"integration_version": 1.0},
    {"integration_version": 2}, {"integration_version": "1"},
    {"cwd": "C:/private"}, {"api_key": "secret"}, {"approval_mode": "never"},
    {"isolation": False}, {"command": "python"}, {"python_module": "evil"},
    {"profile": None}, {"profile": []}, {"profile": {"mode": "bind"}},
    {"profile": {"mode": "create", "path": "C:/private"}},
    {"profile": {"configuration_template_ref": "C:/private"}},
    {"profile": {"mode": True}}, {"model": "../secret"}, {"model": "C:\\private"},
    {"model": "model;exec"}, {"model": "x" * 129}, {"model": True},
]


@pytest.mark.parametrize("config", INVALID_CONFIGS)
def test_shared_contract_rejects_unknown_or_unsafe_configuration(config):
    with pytest.raises(ValueError):
        validate_runtime_config(config)


def test_create_validation_pending_directory_and_offline_sessions(app_client):
    client, main = app_client
    box, headers, project = machine(client)
    for config in INVALID_CONFIGS:
        response = create(client, box, project, runtime_config=config)
        assert response.status_code == 422, (config, response.text)
        assert "C:/private" not in response.text
    for key in ("cwd", "launch_cmd", "renderer", "runtime_status", "api_key"):
        assert create(client, box, project, **{key: "not-allowed"}).status_code == 422
    assert create(client, box, None).status_code == 422
    response = create(client, box, project, runtime_config={"model": "model-1"})
    assert response.status_code == 200, response.text
    agent = response.json()
    revision = binding_revision(agent["id"], project, agent["runtime_config"])
    assert agent["runtime_status"] == {"state": "pending", "revision": revision}
    assert agent["renderer"] == RENDERER_ID
    assert agent["runtime_config"]["model"] == "model-1"
    directory = client.get("/api/me", headers=headers).json()["agents"]
    assert directory[0]["runtime_status"] == agent["runtime_status"]
    assert directory[0]["renderer"] == RENDERER_ID
    assert client.get("/api/devboxes").json()[0]["agents"][0] == agent
    assert client.get(f"/api/agents/{agent['id']}").json() == agent
    response = client.post(f"/api/agents/{agent['id']}/sessions", json={})
    assert response.status_code == 200
    session = response.json()
    assert session["surface"] == "structured"
    assert session["renderer"] == RENDERER_ID
    assert session["model"] == "model-1"
    assert session["runtime_status"] == agent["runtime_status"]
    persisted = client.get(f"/api/sessions/{session['id']}").json()
    # SQLite drops timezone information on reload, unlike the freshly-created
    # timestamp; compare instants without weakening the runtime-field checks.
    assert dt.datetime.fromisoformat(persisted["created_at"]).replace(tzinfo=dt.timezone.utc) == (
        dt.datetime.fromisoformat(session["created_at"]))
    assert persisted == {**session, "created_at": persisted["created_at"]}
    assert client.get(f"/api/agents/{agent['id']}/sessions").json() == [persisted]
    assert client.post(f"/api/agents/{agent['id']}/sessions", json={"surface": "terminal"}).status_code == 422
    with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
        ws.send_json({"type": "attach", "session_id": session["id"]})
        frames = [ws.receive_json() for _ in range(3)]
        assert next(f for f in frames if f["type"] == "restore")["kind"] == "event"
        status = next(f for f in frames if f["type"] == "status")
        assert status["state"] == "offline" and status["renderer"] == RENDERER_ID
        assert next(f for f in frames if f["type"] == "collaboration")["keyboard"]["required"] is False


def test_permissions_project_isolation_and_retry(app_client):
    client, main = app_client
    box, _, project = machine(client)
    other_box, _, other_project = machine(client, "other")
    assert create(client, box, other_project).status_code == 422
    agent = create(client, box, project).json()
    retry = f"/api/agents/{agent['id']}/runtime/retry"
    assert client.post(retry, json={"api_key": "secret"}).status_code == 422
    with main.models.SessionLocal() as db:
        owner_id = db.get(main.Devbox, box).owner_user_id
        workspace_id = db.get(main.Devbox, box).workspace_id
    from fastapi.testclient import TestClient
    with TestClient(main.app) as outsider:
        assert outsider.post("/api/auth/register", json={
            "username": "outsider", "password": "strong-password"}).status_code == 200
        assert create(outsider, box, project).status_code == 404
        assert outsider.post(retry).status_code == 404
        assert outsider.get(f"/api/agents/{agent['id']}").status_code == 404
    with main.models.SessionLocal() as db:
        membership = db.scalar(main.select(main.Membership).where(
            main.Membership.workspace_id == workspace_id, main.Membership.user_id == owner_id))
        for role in ("viewer", "operator"):
            membership.role = role
            db.commit()
            # Workspace role denials intentionally conceal the resource.
            assert create(client, box, project, handle="blocked").status_code == 404
            assert client.post(retry).status_code == 404
        membership.role = "admin"
        db.commit()
    with patch.object(main, "_push_agent_directory", new_callable=AsyncMock) as push:
        result = client.post(retry)
        assert result.status_code == 200
        assert result.json()["runtime_status"] == agent["runtime_status"]
        push.assert_awaited_once_with(box)


def test_observed_status_ws_spoof_stale_and_sanitization(app_client):
    client, main = app_client
    box, headers, project = machine(client)
    other_box, _, other_project = machine(client, "other")
    agent = create(client, box, project).json()
    other = create(client, other_box, other_project).json()
    generic = create(client, box, project, handle="generic", runtime="codex-cli").json()
    revision = agent["runtime_status"]["revision"]
    with client.websocket_connect("/ws/devbox", headers=headers) as connector:
        assert connector.receive_json()["type"] == "hello"
        assert connector.receive_json()["type"] == "agents"
        with patch.object(main.hub, "to_users", new_callable=AsyncMock) as broadcast:
            invalid = [
                {"state": "ready", "revision": "stale"},
                {"state": "ready", "revision": revision, "path": "private"},
                {"state": "ready", "revision": revision, "code": "C:/secret"},
                {"state": "ready", "revision": revision, "code": "exception text"},
                {"state": "ready", "revision": revision, "code": "x" * 65},
                {"state": "unknown", "revision": revision},
                {"state": [], "revision": revision},
            ]
            for status in invalid:
                connector.send_json({"type": "agent.runtime_status", "agent_id": agent["id"],
                                     "runtime_status": status})
            for target in (other, generic):
                connector.send_json({"type": "agent.runtime_status", "agent_id": target["id"],
                    "runtime_status": {"state": "ready", "revision": (
                        other["runtime_status"]["revision"] if target is other else revision)}})
            connector.send_json({"type": "heartbeat"})
            assert connector.receive_json()["type"] == "heartbeat_ack"
            broadcast.assert_not_awaited()
            assert client.get(f"/api/agents/{agent['id']}").json()["runtime_status"] == agent["runtime_status"]
            status = {"state": "needs_configuration", "code": "missing_credentials", "revision": revision}
            connector.send_json({"type": "agent.runtime_status", "agent_id": agent["id"],
                                 "runtime_status": status, "renderer": "https://evil.invalid"})
            connector.send_json({"type": "heartbeat"})
            assert connector.receive_json()["type"] == "heartbeat_ack"
            assert client.get(f"/api/agents/{agent['id']}").json()["runtime_status"] == status
            broadcast.assert_awaited_once()
            user_ids, notification = broadcast.call_args.args
            with main.models.SessionLocal() as db:
                assert user_ids == {db.get(main.Devbox, box).owner_user_id}
            assert notification["renderer"] == RENDERER_ID
            assert notification["runtime_status"] == status
            # Duplicate observations are idempotent; an old revision cannot
            # overwrite a successfully accepted observation either.
            for observed in (status, {"state": "error", "revision": "stale"}):
                connector.send_json({"type": "agent.runtime_status", "agent_id": agent["id"],
                                     "runtime_status": observed})
            connector.send_json({"type": "heartbeat"})
            assert connector.receive_json()["type"] == "heartbeat_ack"
            broadcast.assert_awaited_once()
        from server.app.hub import DevboxConn
        superseded = DevboxConn(ws=None, devbox_id=box, agent_ids={agent["id"]})
        with main.models.SessionLocal() as db:
            assert asyncio.run(main._accept_runtime_status(db, superseded, {
                "agent_id": agent["id"], "runtime_status": {"state": "error", "revision": revision}})) is False
            # Database ownership is independently enforced even if a cached
            # directory were to contain an agent belonging to another device.
            superseded.agent_ids.add(other["id"])
            with patch.object(main.hub, "is_current_devbox", return_value=True):
                assert asyncio.run(main._accept_runtime_status(db, superseded, {
                    "agent_id": other["id"], "runtime_status": {
                        "state": "ready", "revision": other["runtime_status"]["revision"]}})) is False
    # Persisted readiness survives transport loss and is not conflated with presence.
    assert client.get(f"/api/agents/{agent['id']}").json()["runtime_status"] == status
    assert client.get(f"/api/agents/{other['id']}").json()["runtime_status"] == other["runtime_status"]
    assert client.get(f"/api/agents/{generic['id']}").json()["runtime_status"] is None


def test_binding_immutable_delete_only_pushes_directory_and_generic_unchanged(app_client):
    client, main = app_client
    box, headers, project = machine(client)
    agent = create(client, box, project, runtime_config={"model": "model-1"}).json()
    url = f"/api/agents/{agent['id']}"
    assert client.patch(url, json={"display_name": "Renamed"}).json()["display_name"] == "Renamed"
    for change in ({"local_project_id": "other"}, {"runtime": "codex-cli"},
                   {"runtime_config": {"model": "model-2"}}):
        assert client.patch(url, json=change).status_code == 409
    assert client.patch(url, json={"runtime_config": {"profile": {"mode": "bind"}}}).status_code == 422
    assert client.get(url).json()["runtime_status"] == agent["runtime_status"]
    assert client.post(f"/api/devboxes/{box}/projects", headers=headers, json={"projects": []}).status_code == 409
    generic = create(client, box, project, handle="generic", runtime="codex-cli",
                     runtime_config={"custom": "kept"}, cwd="legacy-local", launch_cmd="custom").json()
    assert generic["runtime_config"] == {"custom": "kept"}
    assert generic["runtime_status"] is None and generic["renderer"] is None
    assert client.post(f"/api/agents/{generic['id']}/sessions", json={}).json()["surface"] is None
    assert client.post(f"/api/agents/{generic['id']}/runtime/retry").status_code == 422
    # Real reconciliation proves deletion emits only desired-directory removal,
    # never a native profile/file-purge instruction.
    with client.websocket_connect("/ws/devbox", headers=headers) as connector:
        assert connector.receive_json()["type"] == "hello"
        assert connector.receive_json()["type"] == "agents"
        late = create(client, box, project, handle="late").json()
        assert late["presence"] == "online"
        assert connector.receive_json()["type"] == "agents"
        assert client.delete(url).status_code == 200
        frame = connector.receive_json()
        assert frame["type"] == "agents"
        assert {a["id"] for a in frame["agents"]} == {generic["id"], late["id"]}
        # Disconnect without another inbound frame: the WebSocket ORM session
        # still holds the deleted agent and has never loaded the new one.
    with main.models.SessionLocal() as db:
        assert db.get(main.Agent, agent["id"]) is None
        assert db.get(main.Agent, generic["id"]).presence == "offline"
        survivor = db.get(main.Agent, late["id"])
        assert survivor.presence == "offline"
        assert survivor.runtime_status == late["runtime_status"]
    assert client.get(url).status_code == 404
    assert client.get("/api/devboxes").json()[0]["projects"][0]["id"] == project


def test_runtime_descriptors_preserve_agent_configuration_and_features(app_client):
    client, main = app_client
    box, headers, _ = machine(client)
    other_box, _, _ = machine(client, "other")
    descriptor = {
        "id": RUNTIME_ID, "available": True, "surface": "structured", "renderer": RENDERER_ID,
        "agent_config": {"integration_version": 1, "profile_modes": ["create"],
                         "local_project_required": True},
        "features": {"agent_binding": True, "native_profile_bind": False},
    }
    capabilities = {"runtimes": [descriptor]}
    assert client.post(f"/api/devboxes/{other_box}/runtimes", headers=headers,
                       json={"capabilities": capabilities}).status_code == 403
    assert client.post(f"/api/devboxes/{box}/runtimes", headers=headers,
                       json={"capabilities": capabilities}).status_code == 200

    def reported():
        return next(d for d in client.get("/api/devboxes").json() if d["id"] == box)["capabilities"]

    assert reported() == capabilities
    descriptor["features"]["native_profile_bind"] = True
    descriptor["agent_config"]["profile_modes"].append("bind")
    with client.websocket_connect("/ws/devbox", headers=headers) as connector:
        assert connector.receive_json()["type"] == "hello"
        assert connector.receive_json()["type"] == "agents"
        connector.send_json({"type": "runtimes", "capabilities": capabilities})
        connector.send_json({"type": "heartbeat"})
        assert connector.receive_json()["type"] == "heartbeat_ack"
        assert reported() == capabilities
    with main.models.SessionLocal() as db:
        assert db.get(main.Devbox, box).capabilities == capabilities
        assert db.get(main.Devbox, other_box).capabilities is None


def test_previous_database_migrates_runtime_status_and_deeporca_surface(app_client):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project).json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={}).json()["id"]
    generic = create(client, box, project, handle="generic", runtime="codex-cli").json()
    generic_sid = client.post(f"/api/agents/{generic['id']}/sessions", json={}).json()["id"]
    from sqlalchemy import inspect, text
    engine = main.models._engine
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE agent DROP COLUMN runtime_status"))
        conn.execute(text("UPDATE session SET surface=NULL"))
    main.models._migrate(engine)
    main.models._migrate(engine)  # additive/idempotent upgrade
    assert "runtime_status" in {c["name"] for c in inspect(engine).get_columns("agent")}
    with main.models.SessionLocal() as db:
        assert db.get(main.Agent, agent["id"]).runtime_status is None
        assert db.get(main.Session, sid).surface == "structured"
        assert db.get(main.Session, generic_sid).surface is None
    assert client.get(f"/api/sessions/{sid}").json()["renderer"] == RENDERER_ID


def test_deeporca_permission_rejected_after_attachment_and_role_authorization(app_client):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project).json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={}).json()["id"]
    permission = {"type": "permission", "session_id": sid,
                  "request_id": "approval-request", "decision": "allow"}
    invalid_input = {"type": "input", "session_id": sid, "data": "hello",
                     "client_input_id": "00000000-0000-0000-0000-000000000001",
                     "options": {"api_key": "sensitive-api-key"}}
    barrier = {"type": "input", "session_id": sid, "client_input_id": "invalid"}
    read_only = {"type": "error", "code": "read_only",
                 "message": "session control requires current operator access and attachment"}
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            for frame in (permission, invalid_input):
                ws.send_json(frame)
                assert ws.receive_json() == read_only
            send.assert_not_awaited()
            attach(ws, sid)
            send.reset_mock()
            for frame in (permission, invalid_input):
                ws.send_json({**frame, "agent_id": "wrong-agent"})
                assert ws.receive_json() == read_only
            for decision in ("allow", "deny"):
                ws.send_json({**permission, "decision": decision})
                ws.send_json(barrier)
                rejected = ws.receive_json()
                assert rejected["type"] == "error"
                assert rejected["code"] == "approval_not_supported"
                assert "approval-request" not in str(rejected)
                assert ws.receive_json()["message"] == "invalid client_input_id"
            send.assert_not_awaited()
            # The same attached socket must reauthorize a downgraded member
            # before disclosing either runtime-specific validation error.
            with main.models.SessionLocal() as db:
                devbox = db.get(main.Devbox, box)
                membership = db.scalar(main.select(main.Membership).where(
                    main.Membership.workspace_id == devbox.workspace_id,
                    main.Membership.user_id == devbox.owner_user_id))
                membership_id = membership.id
                membership.role = "viewer"
                db.commit()
            for frame in (permission, invalid_input):
                ws.send_json(frame)
                rejected = ws.receive_json()
                if frame["type"] == "permission":
                    assert rejected == read_only
                else:
                    assert_input_rejected(rejected, frame, agent["id"], "read_only", read_only["message"])
                assert "sensitive-api-key" not in str(rejected)
            # A removed member must not learn runtime/session metadata, even
            # from a previously attached socket or a malformed submission.
            with main.models.SessionLocal() as db:
                db.delete(db.get(main.Membership, membership_id))
                db.commit()
            for frame in (permission, invalid_input, barrier):
                ws.send_json(frame)
                assert ws.receive_json() == read_only
            send.assert_not_awaited()
            assert main.live_registry.get(sid).pending_inputs == {}


@pytest.mark.parametrize("surface", ["structured", "terminal", None])
def test_generic_permission_and_runtime_specific_input_options_still_forward(app_client, surface):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project, runtime="codex-cli").json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={"surface": surface}).json()["id"]
    frames = [
        {"type": "permission", "session_id": sid, "request_id": "cli-approval", "decision": "allow"},
        {"type": "input", "session_id": sid, "data": "hello",
         "client_input_id": "00000000-0000-0000-0000-000000000001",
         "options": {"permission_mode": "default", "custom": True}, "files": ["cli-file"]},
    ]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            send.reset_mock()
            with patch.object(main.live_registry.get(sid), "queue_input") as queue:
                for fields, message in (
                    ({"client_input_id": "invalid"}, "invalid client_input_id"),
                    ({"data": {"api_key": "sensitive-api-key"}}, "invalid input data"),
                ):
                    ws.send_json({**frames[1], **fields})
                    assert ws.receive_json() == {"type": "error", "message": message}
                queue.assert_not_called()
                send.assert_not_awaited()
            for frame in frames:
                ws.send_json(frame)
                ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
                assert ws.receive_json() == {"type": "error", "message": "invalid client_input_id"}
                send.assert_awaited_once_with(agent["id"], {**frame, "agent_id": agent["id"]})
                send.reset_mock()


@pytest.mark.parametrize("kind", ["input", "stdin"])
def test_deeporca_text_input_options_rejected_before_queue_or_forward(app_client, kind):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project).json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={}).json()["id"]
    frame = {"type": kind, "session_id": sid, "data": "sensitive prompt",
             "client_input_id": "AABBCCDD-0000-0000-0000-000000000001"}
    invalid_options = [
        None, [], "model-1", True, 1, {"unknown": True},
        {"permission_mode": "default"}, {"files": []},
        {"profile": {}}, {"integration_version": 1},
        {"api_key": "sensitive-api-key"}, {"cwd": "C:/private"},
        *({"model": model} for model in (
            None, True, 1, [], {}, "", "../secret", "C:/private", "model;exec", "x" * 129)),
    ]
    invalid_fields = [
        *({"options": options} for options in invalid_options),
        {"permission_mode": "default"}, {"files": []}, {"unknown": True},
        {"api_key": "sensitive-api-key"}, {"files": ["C:/private"]},
    ]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            send.reset_mock()
            with patch.object(main.live_registry.get(sid), "queue_input") as queue:
                for fields in invalid_fields:
                    ws.send_json({**frame, **fields})
                    ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
                    rejected = ws.receive_json()
                    options = fields.get("options")
                    message = ("DeepOrca model must be a safe identifier of at most 128 characters"
                               if isinstance(options, dict) and set(options) == {"model"} else
                               "DeepOrca only supports text input and model options")
                    assert_input_rejected(rejected, frame, agent["id"], "invalid_options", message)
                    for sensitive in ("C:/private", "sensitive-api-key", "sensitive prompt"):
                        assert sensitive not in str(rejected)
                    assert ws.receive_json()["message"] == "invalid client_input_id"
                for data in ([], {}, None, True, 1, {"api_key": "sensitive-api-key"}, ["C:/private"]):
                    ws.send_json({**frame, "data": data})
                    assert_input_rejected(ws.receive_json(), frame, agent["id"],
                                          "invalid_data", "invalid input data")
                queue.assert_not_called()
                send.assert_not_awaited()
                for fields in ({}, {"options": {}}, {"options": {"model": "model-1"}},
                               {"options": {"model": "x" * 128}}):
                    ws.send_json({**frame, **fields})
                    ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
                    assert ws.receive_json()["message"] == "invalid client_input_id"
                    send.assert_awaited_once_with(agent["id"], {
                        **frame, **fields, "agent_id": agent["id"]})
                    queue.assert_called_once_with(frame["client_input_id"], frame["data"])
                    send.reset_mock()
                    queue.reset_mock()
            # No approval transport does not disable ordinary runtime controls.
            for kind in ("interrupt", "terminate"):
                ws.send_json({"type": kind, "session_id": sid})
                ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
                response = ws.receive_json()
                if kind == "terminate":
                    assert response["type"] == "status" and response["state"] == "ended"
                    response = ws.receive_json()
                    # Termination replaces the generation immediately; even
                    # this invalid-input barrier belongs to the old launch.
                    assert response["code"] == "session_changed"
                else:
                    assert response["message"] == "invalid client_input_id"
                expected = {"type": kind, "session_id": sid, "agent_id": agent["id"]}
                if kind == "terminate":
                    expected["launch_id"] = None
                send.assert_awaited_once_with(agent["id"], expected)
                send.reset_mock()


@pytest.mark.parametrize("kind", ["input", "stdin"])
def test_deeporca_invalid_input_ids_are_bounded_correlated_rejections(app_client, kind):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project).json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={}).json()["id"]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            send.reset_mock()
            with patch.object(main.live_registry.get(sid), "queue_input") as queue:
                for input_id in ("invalid", "x" * 4096, "", None, False, 0, 1, [],
                                 {"api_key": "sensitive-api-key"}, ["C:/private"]):
                    frame = {"type": kind, "session_id": sid, "client_input_id": input_id,
                             "data": {"prompt": "sensitive prompt"},
                             "options": {"api_key": "sensitive-api-key"}}
                    ws.send_json(frame)
                    # A different response acts as a barrier to detect duplicate
                    # error frames as well as a rejected ACK for each submission.
                    ws.send_json({"type": "permission", "session_id": sid})
                    rejected = ws.receive_json()
                    assert_input_rejected(rejected, frame, agent["id"],
                                          "invalid_input_id", "invalid client_input_id")
                    assert len(rejected["client_input_id"] or "") <= 128
                    for sensitive in ("sensitive-api-key", "sensitive prompt", "C:/private"):
                        assert sensitive not in str(rejected)
                    assert ws.receive_json()["code"] == "approval_not_supported"
                queue.assert_not_called()
                send.assert_not_awaited()


@pytest.mark.parametrize("runtime", [RUNTIME_ID, "codex-cli"])
def test_native_input_ids_survive_forward_and_connector_ack_without_canonicalization(app_client, runtime):
    client, main = app_client
    box, headers, project = machine(client)
    agent = create(client, box, project, runtime=runtime).json()
    sid = client.post(f"/api/agents/{agent['id']}/sessions", json={"surface": "structured"}).json()["id"]
    with client.websocket_connect("/ws/devbox", headers=headers) as connector:
        assert connector.receive_json()["type"] == "hello"
        assert connector.receive_json()["type"] == "agents"
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            assert connector.receive_json()["type"] == "open"
            for input_id in ("AABBCCDD-0000-0000-0000-000000000001",
                             "aabbccdd000000000000000000000002"):
                frame = {"type": "input", "session_id": sid, "client_input_id": input_id,
                         "data": "hello", "options": {"model": "model-1"}}
                ws.send_json(frame)
                expected_id = input_id if runtime == RUNTIME_ID else str(main.UUID(input_id))
                assert connector.receive_json() == {
                    **frame, "agent_id": agent["id"], "client_input_id": expected_id}
                assert main.live_registry.get(sid).pending_inputs == {expected_id: "hello"}
                ack = {"type": "input_ack", "agent_id": agent["id"], "session_id": sid,
                       "client_input_id": input_id, "status": "rejected", "reason": "session_not_ready"}
                connector.send_json(ack)
                assert ws.receive_json() == {**ack, "client_input_id": expected_id}
                assert main.live_registry.get(sid).pending_inputs == {}

# ---------------------------------------------------------------------------
# Managed settings and sealed credentials
# ---------------------------------------------------------------------------
"""Hermetic Server coverage for editable, sealed DeepOrca profile settings."""
import base64
from copy import deepcopy
from unittest.mock import AsyncMock, patch

import pytest

from agentbridge.integrations.deeporca.contract import binding_revision, validate_runtime_config


def sealed(seed=b"a"):
    # Structural opaque envelopes, not real API keys or native SDK encryption.
    return {"mode": "sealed", "key_id": "a" * 64,
            "wrapped_key": base64.b64encode(seed * 256).decode(),
            "iv": base64.b64encode(seed * 12).decode(),
            "ciphertext": base64.b64encode(seed * 32).decode()}


def config(**llm):
    return validate_runtime_config({
        "llm": {"provider": "openai", "base_url": "https://models.example/v1",
                "model": "vendor/model:latest", "context_window": 128000,
                "reasoning_effort": "", **llm},
        "credential": {"mode": "none"},
    })


def mark_ready(main, agent):
    ready = {"state": "ready", "revision": agent["runtime_status"]["revision"]}
    with main.models.SessionLocal() as db:
        db.get(main.Agent, agent["id"]).runtime_status = ready
        db.commit()
    return ready


def test_create_complete_model_settings_accepts_only_safe_desired_payload(app_client, caplog):
    client, _ = app_client
    box, headers, project = machine(client)
    complete = {**config(), "credential": sealed()}
    invalid = [
        {**complete, "api_key": "sensitive-marker"},
        {**complete, "credential": "sensitive-marker"},
        {**complete, "credential": {"mode": "plaintext", "api_key": "sensitive-marker"}},
        {**complete, "credential": {**sealed(), "api_key": "sensitive-marker"}},
        {**complete, "credential": {"mode": "none", "api_key": "sensitive-marker"}},
        {**complete, "credential": {**sealed(), "ciphertext": "sensitive-marker"}},
        {**complete, "llm": {**complete["llm"], "api_key": "sensitive-marker"}},
        {**complete, "llm": {**complete["llm"], "provider": "unsupported"}},
        {**complete, "llm": {**complete["llm"], "context_window": True}},
        {**complete, "llm": {**complete["llm"], "context_window": 0}},
        {**complete, "llm": {**complete["llm"], "reasoning_effort": "unsupported"}},
        {**complete, "llm": {**complete["llm"], "base_url": "https://sensitive-marker@host/v1"}},
        {**complete, "llm": {**complete["llm"], "base_url": "https://host/v1?key=sensitive-marker"}},
        {"credential": sealed()},
    ]
    for desired in invalid:
        response = create(client, box, project, runtime_config=desired)
        assert response.status_code == 422, response.text
        assert "sensitive-marker" not in response.text
    assert create(client, box, project, api_key="sensitive-marker").status_code == 422
    assert "sensitive-marker" not in caplog.text
    for index, desired in enumerate((complete, config(), {"llm": config()["llm"]}, {})):
        response = create(client, box, project, handle=f"orca-{index}", runtime_config=desired)
        assert response.status_code == 200, response.text
        agent = response.json()
        assert agent["runtime_config"] == validate_runtime_config(desired)
        assert agent["runtime_status"] == {
            "state": "pending", "revision": binding_revision(agent["id"], project, desired)}
        assert client.get(f"/api/agents/{agent['id']}").json()["runtime_config"] == agent["runtime_config"]
    directory = client.get("/api/me", headers=headers).json()["agents"]
    assert directory[0]["runtime_config"]["credential"] == complete["credential"]


def test_settings_update_persists_broadcasts_snapshot_and_rejects_stale_status(app_client):
    client, main = app_client
    box, headers, project = machine(client)
    agent = create(client, box, project, runtime_config=config()).json()
    url = f"/api/agents/{agent['id']}"
    old_ready = mark_ready(main, agent)
    desired = config(model="new/model", context_window=256000, reasoning_effort="high")
    with client.websocket_connect("/ws/devbox", headers=headers) as connector:
        assert connector.receive_json()["type"] == "hello"
        assert connector.receive_json()["type"] == "agents"
        with patch.object(main.hub, "to_users", new_callable=AsyncMock) as broadcast:
            response = client.patch(url, json={"display_name": " Renamed ", "runtime_config": desired})
            assert response.status_code == 200, response.text
            updated = response.json()
            assert updated["display_name"] == "Renamed"
            assert updated["runtime_config"] == desired
            assert updated["runtime_status"] == {
                "state": "pending", "revision": binding_revision(agent["id"], project, desired)}
            assert updated["runtime_status"]["revision"] != old_ready["revision"]
            snapshot = connector.receive_json()
            assert snapshot["type"] == "agents"
            assert snapshot["agents"][0]["runtime_config"] == desired
            assert snapshot["agents"][0]["runtime_status"] == updated["runtime_status"]
            assert client.get(url).json()["runtime_config"] == desired
            broadcast.assert_awaited_once()
            assert broadcast.call_args.args[1]["runtime_status"] == updated["runtime_status"]
            broadcast.reset_mock()
            connector.send_json({"type": "agent.runtime_status", "agent_id": agent["id"],
                                 "runtime_status": {**old_ready, "state": "error", "code": "stale"}})
            connector.send_json({"type": "heartbeat"})
            assert connector.receive_json()["type"] == "heartbeat_ack"
            assert client.get(url).json()["runtime_status"] == updated["runtime_status"]
            broadcast.assert_not_awaited()
            ready = {**updated["runtime_status"], "state": "ready"}
            connector.send_json({"type": "agent.runtime_status", "agent_id": agent["id"],
                                 "runtime_status": ready})
            connector.send_json({"type": "heartbeat"})
            assert connector.receive_json()["type"] == "heartbeat_ack"
            assert client.get(url).json()["runtime_status"] == ready


def test_credential_omission_retains_envelope_without_mutating_input(app_client):
    client, main = app_client
    box, _, project = machine(client)
    original = {**config(), "credential": sealed()}
    agent = create(client, box, project, runtime_config=original).json()
    url = f"/api/agents/{agent['id']}"
    desired = config(model="replacement/model")
    desired.pop("credential")
    before = deepcopy(desired)
    with main.models.SessionLocal() as db:
        record = db.get(main.Agent, agent["id"])
        prepared = main.runtime_policy(record.runtime).validate_agent_update(record, {"runtime_config": desired})
        assert desired == before
        assert record.runtime_config == original
        assert prepared == {**desired, "credential": original["credential"]}
    response = client.patch(url, json={"runtime_config": desired})
    assert response.status_code == 200, response.text
    assert response.json()["runtime_config"] == {**desired, "credential": original["credential"]}
    assert response.json()["runtime_status"]["revision"] != agent["runtime_status"]["revision"]
    # An omitted retained credential on a no-op must not reset observed ready.
    ready = mark_ready(main, response.json())
    with patch.object(main, "_broadcast_runtime_status", new_callable=AsyncMock) as broadcast:
        response = client.patch(url, json={"runtime_config": desired, "display_name": "Independent"})
        assert response.status_code == 200
        assert response.json()["runtime_status"] == ready
        assert response.json()["display_name"] == "Independent"
        broadcast.assert_not_awaited()


def test_endpoint_change_requires_fresh_envelope_or_explicit_no_authentication(app_client):
    client, main = app_client
    box, _, project = machine(client)
    original = {**config(), "credential": sealed()}
    agent = create(client, box, project, runtime_config=original).json()
    url = f"/api/agents/{agent['id']}"
    ready = mark_ready(main, agent)
    redirected = config(base_url="https://different.example/v1")
    redirected.pop("credential")
    with patch.object(main, "_push_agent_directory", new_callable=AsyncMock) as push:
        for desired in (redirected, {**redirected, "credential": sealed()}):
            response = client.patch(url, json={"runtime_config": desired, "display_name": "Must not apply"})
            assert response.status_code == 409
            assert "different.example" not in response.text
            assert "models.example" not in response.text
            assert "new sealed credential" in response.text
        push.assert_not_awaited()
    persisted = client.get(url).json()
    assert persisted["runtime_config"] == original
    assert persisted["runtime_status"] == ready
    assert persisted["display_name"] == agent["display_name"]
    fresh = {**redirected, "credential": sealed(b"b")}
    response = client.patch(url, json={"runtime_config": fresh})
    assert response.status_code == 200, response.text
    assert response.json()["runtime_config"] == fresh
    cleared = config(base_url="http://127.0.0.1:9000/v1")
    response = client.patch(url, json={"runtime_config": cleared})
    assert response.status_code == 200, response.text
    assert response.json()["runtime_config"] == cleared
    # Once explicitly keyless, another endpoint edit can retain mode=none.
    keyless = config(base_url="http://localhost:9001/v1")
    keyless.pop("credential")
    response = client.patch(url, json={"runtime_config": keyless})
    assert response.status_code == 200
    assert response.json()["runtime_config"]["credential"] == {"mode": "none"}


def test_identity_fences_and_plaintext_rejection_apply_to_settings(app_client, caplog):
    client, main = app_client
    box, _, project = machine(client)
    original = config()
    agent = create(client, box, project, runtime_config=original).json()
    url = f"/api/agents/{agent['id']}"
    ready = mark_ready(main, agent)
    for body, status in (
        ({"runtime": "codex-cli"}, 409),
        ({"local_project_id": "another-project"}, 409),
        ({"devbox_id": "another-box"}, 422),
        ({"handle": "another-handle"}, 422),
        ({"cwd": "sensitive-marker"}, 422),
        ({"launch_cmd": "sensitive-marker"}, 422),
        ({"runtime_config": {"model": "legacy-model"}}, 409),
        ({"runtime_config": {**original, "integration_version": 2}}, 422),
        ({"runtime_config": {**original, "profile": {"mode": "bind"}}}, 422),
        ({"runtime_config": {**original, "profile": {"configuration_template_ref": "sensitive-marker"}}}, 422),
        ({"runtime_config": {**original, "credential": {"mode": "plain", "api_key": "sensitive-marker"}}}, 422),
        ({"runtime_config": {**original, "llm": {**original["llm"], "api_key": "sensitive-marker"}}}, 422),
        ({"api_key": "sensitive-marker"}, 422),
        ({"runtime_config": None}, 422),
    ):
        response = client.patch(url, json={"display_name": "Must not apply", **body})
        assert response.status_code == status, response.text
        assert "sensitive-marker" not in response.text
    assert "sensitive-marker" not in caplog.text
    persisted = client.get(url).json()
    assert persisted["runtime_config"] == original
    assert persisted["runtime_status"] == ready
    assert persisted["display_name"] == agent["display_name"]


@pytest.mark.parametrize("activity", ["connector", "idle_attached", "queued_input"])
def test_any_active_conversation_blocks_changes_but_not_noop_or_rename(app_client, activity):
    client, main = app_client
    from server.app.hub import DevboxConn, HumanConn

    box, _, project = machine(client)
    original = config()
    agent = create(client, box, project, runtime_config=original).json()
    url = f"/api/agents/{agent['id']}"
    # Protect ANY session, not merely the requester's last or busy session.
    sessions = [client.post(url + "/sessions", json={}).json() for _ in range(2)]
    sid = sessions[-1]["id"]
    ready = mark_ready(main, agent)
    if activity == "connector":
        conn = DevboxConn(ws=None, devbox_id=box, agent_ids={agent["id"]}, active_session_ids={sid})
        main.hub.devboxes[box] = conn
        main.hub.agent_to_devbox[agent["id"]] = box
    elif activity == "idle_attached":
        main.hub.session_watchers[sid] = {HumanConn(ws=None, user_id="viewer")}
    else:
        main.live_registry.get_or_create(sid, 120, 30).pending_inputs["queued"] = "input"
    with patch.object(main, "_push_agent_directory", new_callable=AsyncMock) as push, patch.object(
            main.hub, "to_devbox", new_callable=AsyncMock) as command, patch.object(
            main, "_broadcast_runtime_status", new_callable=AsyncMock) as broadcast:
        response = client.patch(url, json={"runtime_config": config(model="new-model")})
        assert response.status_code == 409, response.text
        assert "close active conversations" in response.text
        push.assert_not_awaited()
        command.assert_not_awaited()  # never terminate running work for settings
        broadcast.assert_not_awaited()
        response = client.patch(url, json={"runtime_config": original, "display_name": "Still editable"})
        assert response.status_code == 200, response.text
        assert response.json()["runtime_status"] == ready
        assert response.json()["runtime_config"] == original
        assert response.json()["display_name"] == "Still editable"
        broadcast.assert_not_awaited()


def test_real_idle_browser_attachment_blocks_profile_edit_until_detached(app_client):
    client, _ = app_client
    box, _, project = machine(client)
    agent = create(client, box, project, runtime_config=config()).json()
    url = f"/api/agents/{agent['id']}"
    session = client.post(url + "/sessions", json={}).json()
    with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as browser:
        attach(browser, session["id"])
        response = client.patch(url, json={"runtime_config": config(model="new-model")})
        assert response.status_code == 409
    # Disconnected historical sessions have no active work and do not block.
    response = client.patch(url, json={"runtime_config": config(model="new-model")})
    assert response.status_code == 200, response.text


def test_ended_or_other_agents_sessions_do_not_block_settings(app_client):
    client, main = app_client
    from server.app.hub import HumanConn

    box, _, project = machine(client)
    agent = create(client, box, project, runtime_config=config()).json()
    other = create(client, box, project, handle="other", runtime_config=config()).json()
    url = f"/api/agents/{agent['id']}"
    ended = client.post(url + "/sessions", json={}).json()
    unrelated = client.post(f"/api/agents/{other['id']}/sessions", json={}).json()
    for session in (ended, unrelated):
        main.hub.session_watchers[session["id"]] = {HumanConn(ws=None, user_id="viewer")}
    main.live_registry.get_or_create(ended["id"], 120, 30).mark_ended(0)
    response = client.patch(url, json={"runtime_config": config(model="new-model")})
    assert response.status_code == 200, response.text


def test_settings_authorization_precedes_runtime_validation_for_existing_roles(app_client):
    client, main = app_client
    box, _, project = machine(client)
    agent = create(client, box, project, runtime_config=config()).json()
    url = f"/api/agents/{agent['id']}"
    with main.models.SessionLocal() as db:
        devbox = db.get(main.Devbox, box)
        membership = db.scalar(main.select(main.Membership).where(
            main.Membership.workspace_id == devbox.workspace_id,
            main.Membership.user_id == devbox.owner_user_id))
        for role in ("viewer", "operator"):
            membership.role = role
            db.commit()
            with patch.object(main, "runtime_policy", side_effect=AssertionError("policy before ACL")):
                response = client.patch(url, json={"runtime_config": {"credential": "sensitive-marker"}})
                assert response.status_code == 404
                assert "sensitive-marker" not in response.text
        membership.role = "admin"
        db.commit()
    assert client.patch(url, json={"runtime_config": config(model="new-model")}).status_code == 200


def test_legacy_configs_and_ordinary_runtimes_keep_existing_behavior(app_client):
    client, main = app_client
    box, _, project = machine(client)
    legacy = create(client, box, project).json()
    ready = mark_ready(main, legacy)
    url = f"/api/agents/{legacy['id']}"
    assert client.patch(url, json={"runtime_config": {}}).json()["runtime_status"] == ready
    response = client.patch(url, json={"runtime_config": config()})
    assert response.status_code == 200, response.text
    assert response.json()["runtime_status"]["revision"] != ready["revision"]
    fixed = create(client, box, project, handle="legacy-model", runtime_config={"model": "fixed"}).json()
    response = client.patch(f"/api/agents/{fixed['id']}", json={"runtime_config": config()})
    assert response.status_code == 409  # legacy top-level model is identity
    compatible = {**config(model="fixed"), "model": "fixed"}
    response = client.patch(f"/api/agents/{fixed['id']}", json={"runtime_config": compatible})
    assert response.status_code == 200, response.text
    for runtime in ("codex-cli", "claude-code", "codex", "copilot", "future-runtime"):
        agent = create(client, box, project, handle=runtime, runtime=runtime,
                       runtime_config={"custom": "unchanged"}).json()
        url = f"/api/agents/{agent['id']}"
        response = client.patch(url, json={"runtime_config": config()})
        assert response.status_code == 422
        assert "launch_options only supports" in response.json()["detail"]
        response = client.patch(url, json={"display_name": "Ordinary rename"})
        assert response.status_code == 200, response.text
        assert response.json()["runtime_config"] == {"custom": "unchanged"}
        assert response.json()["runtime_status"] is None

# ---------------------------------------------------------------------------
# Shared configuration contract
# ---------------------------------------------------------------------------
"""Browser profile configuration is declarative and contains no raw secrets."""
import base64
from copy import deepcopy

import pytest

from agentbridge.integrations.deeporca.contract import (
    MAX_CONTEXT_WINDOW, REASONING_EFFORTS, binding_identity_revision,
    binding_revision, validate_runtime_config,
)


def llm(**changes):
    return {"provider": "openai", "base_url": "http://127.0.0.1:1234/v1",
            "model": "vendor/model:latest", "context_window": 128000,
            "reasoning_effort": "", **changes}


def envelope(**changes):
    return {"mode": "sealed", "key_id": "a" * 64,
            "wrapped_key": base64.b64encode(b"w" * 256).decode(),
            "iv": base64.b64encode(b"i" * 12).decode(),
            "ciphertext": base64.b64encode(b"c" * 17).decode(), **changes}


def test_legacy_default_and_revision_are_unchanged():
    old = {"integration_version": 1, "profile": {
        "mode": "create", "configuration_template_ref": "connector-default"}}
    assert validate_runtime_config({}) == old
    assert binding_identity_revision("agent", "project", {}) == binding_revision("agent", "project", old)


@pytest.mark.parametrize("effort", REASONING_EFFORTS)
def test_full_configuration_and_native_efforts(effort):
    value = {"llm": llm(reasoning_effort=effort), "credential": envelope()}
    before = deepcopy(value)
    parsed = validate_runtime_config(value)
    assert parsed["llm"] == value["llm"]
    assert parsed["credential"] == value["credential"]
    parsed["llm"]["model"] = "different"
    parsed["credential"]["key_id"] = "b" * 64
    assert value == before


@pytest.mark.parametrize("endpoint", [
    "https://api.openai.com/v1", "http://localhost:11434/v1/",
    "http://[::1]:8000/v1", "https://models.internal/api/v1",
])
def test_private_endpoints_are_supported_without_network_requests(endpoint):
    assert validate_runtime_config({"llm": llm(base_url=endpoint)})["llm"]["base_url"] == endpoint


@pytest.mark.parametrize("endpoint", [
    None, True, "", "file:///tmp/model", "javascript:alert(1)",
    "https://user:secret@host/v1", "https://user@host/v1", "https://host/v1?key=secret",
    "https://host/v1?", "https://host/v1#", "https://host/v1#secret", "https:///v1",
    "https://host:99999/v1", "https://host:0/v1", "https://[invalid/v1",
    "https://host/\\other", "https://host/v1\n", " https://host/v1",
    "https://${LLM_HOST}/v1", "https://host/" + "a" * 2048,
    "https://my_llm.invalid/v1", "https://bad..invalid/v1", "https://-invalid/v1",
    "https://host/v1/%", "https://host/v1/{bad}", "https://éxample.invalid/v1",
])
def test_endpoint_rejections_never_echo_values(endpoint):
    with pytest.raises(ValueError) as error:
        validate_runtime_config({"llm": llm(base_url=endpoint)})
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("window", [None, True, False, 0, -1, 1.5, "128000", MAX_CONTEXT_WINDOW + 1])
def test_context_window_exact_native_type_and_bounds(window):
    with pytest.raises(ValueError):
        validate_runtime_config({"llm": llm(context_window=window)})


@pytest.mark.parametrize("window", [1, 128000, MAX_CONTEXT_WINDOW])
def test_context_window_valid_boundaries(window):
    assert validate_runtime_config({"llm": llm(context_window=window)})["llm"]["context_window"] == window


@pytest.mark.parametrize("model", [None, "", "model with spaces", "${LLM_MODEL}", "m\n", "x" * 257])
def test_invalid_model(model):
    with pytest.raises(ValueError):
        validate_runtime_config({"llm": llm(model=model)})


@pytest.mark.parametrize("model", ["vendor/model@revision", "model+variant"])
def test_provider_model_aliases_match_native_sdk(model):
    assert validate_runtime_config({"llm": llm(model=model)})["llm"]["model"] == model


@pytest.mark.parametrize("bad", [None, [], {"provider": "copilot"}, {"reasoning_effort": "auto"},
                                 {"reasoning_effort": None}, {"api_key": "raw-secret"},
                                 {"command": "do-not-execute"}, {"profile_path": "C:/private"}])
def test_llm_rejects_unknown_or_incomplete_fields(bad):
    value = {"llm": llm(**bad) if isinstance(bad, dict) else bad}
    with pytest.raises(ValueError) as error:
        validate_runtime_config(value)
    assert "raw-secret" not in str(error.value)


@pytest.mark.parametrize("credential", [
    None, "raw-secret", {"mode": "none", "api_key": "raw-secret"},
    {"mode": "plaintext", "api_key": "raw-secret"}, envelope(key_id="x" * 64),
    envelope(iv="not base64!"), envelope(iv=base64.b64encode(b"i" * 11).decode()),
    envelope(wrapped_key=base64.b64encode(b"w" * 257).decode()),
    envelope(ciphertext=base64.b64encode(b"c" * 4113).decode()),
    envelope(ciphertext=base64.b64encode(b"c" * 16).decode()),
    envelope(ciphertext="é"), {**envelope(), "path": "C:/private"},
])
def test_credential_only_accepts_bounded_canonical_ciphertext(credential):
    with pytest.raises(ValueError) as error:
        validate_runtime_config({"llm": llm(), "credential": credential})
    assert "raw-secret" not in str(error.value)


def test_no_auth_explicit_and_credential_requires_model_config():
    assert validate_runtime_config({"llm": llm(), "credential": {"mode": "none"}})["credential"] == {"mode": "none"}
    with pytest.raises(ValueError):
        validate_runtime_config({"credential": envelope()})


def test_desired_revision_changes_without_changing_native_profile_identity():
    initial = {"llm": llm(), "credential": envelope()}
    changed = {"llm": llm(model="new/model", reasoning_effort="high"), "credential": {"mode": "none"}}
    assert binding_revision("agent", "project", initial) != binding_revision("agent", "project", changed)
    assert binding_identity_revision("agent", "project", initial) == binding_identity_revision("agent", "project", changed)
    assert binding_identity_revision("agent", "project", initial) != binding_identity_revision("agent", "other", initial)


def test_legacy_model_override_remains_immutable_and_cannot_conflict():
    assert binding_identity_revision("agent", "project", {"model": "one"}) != binding_identity_revision("agent", "project", {"model": "two"})
    with pytest.raises(ValueError):
        validate_runtime_config({"model": "one", "llm": llm(model="two")})

# ---------------------------------------------------------------------------
# Existing-profile Server policy
# ---------------------------------------------------------------------------
"""Existing-profile references are inventory-scoped and never browser paths."""
import pytest

from agentbridge.integrations.deeporca.contract import binding_identity_revision, validate_runtime_config


EXISTING_PROFILE_REF = 'native-' + 'a' * 32
OTHER = 'native-' + 'b' * 32


def binding(ref=EXISTING_PROFILE_REF, **profile):
    return {'integration_version': 1, 'profile': {
        'mode': 'bind', 'profile_ref': ref, 'native_stopped': True, **profile}}


def advertise(main, box, refs=(EXISTING_PROFILE_REF,), modes=('create', 'bind'), *, legacy=False):
    descriptor = {'runtime': 'deeporca', 'agent_config': {'profile_modes': list(modes),
        'existing_profiles': [{'id': ref, 'label': 'Existing native profile'} for ref in refs]}}
    capabilities = [descriptor]
    if legacy:
        descriptor['id'] = descriptor.pop('runtime')
        capabilities = {'runtimes': [descriptor]}
    with main.models.SessionLocal() as db:
        db.get(main.Devbox, box).capabilities = capabilities
        db.commit()


def test_bind_contract_keeps_exact_opaque_reference_and_consent():
    desired = binding()
    parsed = validate_runtime_config(desired)
    assert parsed == desired
    parsed['profile']['profile_ref'] = OTHER
    assert desired == binding()
    assert binding_identity_revision('agent', 'project', desired) != binding_identity_revision('agent', 'project', binding(OTHER))
    assert binding_identity_revision('agent', 'project', desired) != binding_identity_revision('agent', 'project', {})


@pytest.mark.parametrize('confirmation', [None, False, 0, 1, 'true', {}, []])
def test_bind_requires_explicit_boolean_native_stop_confirmation(confirmation):
    with pytest.raises(ValueError, match='Stop native DeepOrca'):
        validate_runtime_config(binding(native_stopped=confirmation))


@pytest.mark.parametrize('profile', [
    {'mode': 'bind'}, {'mode': 'bind', 'profile_ref': EXISTING_PROFILE_REF},
    {**binding()['profile'], 'home': 'C:/private-home'},
    {**binding()['profile'], 'profile_name': 'secret-name'},
    {**binding()['profile'], 'configuration_template_ref': 'connector-default'},
    {**binding()['profile'], 'profile_ref': 'C:/private-home'},
    {**binding()['profile'], 'profile_ref': 'secret-name'},
    {**binding()['profile'], 'profile_ref': '../private-home'},
])
def test_bind_rejects_names_paths_templates_and_incomplete_configuration(profile):
    with pytest.raises(ValueError) as error:
        validate_runtime_config({'profile': profile})
    assert 'private-home' not in str(error.value)
    assert 'secret-name' not in str(error.value)


@pytest.mark.parametrize('field', ['llm', 'credential', 'model'])
def test_bound_profile_never_accepts_configuration_overrides(field):
    with pytest.raises(ValueError, match='read-only'):
        validate_runtime_config({**binding(), field: 'secret-value'})


@pytest.mark.parametrize('legacy', [False, True])
def test_create_binding_requires_inventory_from_target_machine(app_client, legacy):
    client, main = app_client
    box, _, project = machine(client)
    other, _, _ = machine(client, 'other')
    advertise(main, other)
    response = create(client, box, project, runtime_config=binding())
    assert response.status_code == 422  # A different Machine's catalog is not authority.
    advertise(main, box, modes=('create',))
    assert create(client, box, project, runtime_config=binding()).status_code == 422
    advertise(main, box, refs=(OTHER,))
    assert create(client, box, project, runtime_config=binding()).status_code == 422
    advertise(main, box, legacy=legacy)
    response = create(client, box, project, runtime_config=binding())
    assert response.status_code == 200, response.text
    agent = response.json()
    assert agent['runtime_config'] == binding()
    assert agent['runtime_status']['state'] == 'pending'
    assert create(client, box, None, handle='missing-project', runtime_config=binding()).status_code == 422


@pytest.mark.parametrize('capabilities', [None, {}, {'runtimes': None}, {'runtimes': {}},
    {'runtimes': [None, {'id': 'deeporca', 'agent_config': None}]},
    {'runtimes': [{'id': 'deeporca', 'agent_config': {'profile_modes': 'bind'}}]},
    {'runtimes': [{'id': 'deeporca', 'agent_config': {'profile_modes': ['bind'], 'existing_profiles': None}}]}])
def test_bad_or_old_inventory_fails_safely_but_create_mode_unchanged(app_client, capabilities):
    client, main = app_client
    box, _, project = machine(client)
    with main.models.SessionLocal() as db:
        db.get(main.Devbox, box).capabilities = capabilities
        db.commit()
    assert create(client, box, project, runtime_config=binding()).status_code == 422
    assert create(client, box, project, runtime_config={}).status_code == 200


def test_bound_agent_name_only_and_retry_do_not_edit_native_configuration(app_client):
    client, main = app_client
    box, _, project = machine(client)
    advertise(main, box, refs=(EXISTING_PROFILE_REF, OTHER))
    response = create(client, box, project, runtime_config=binding())
    assert response.status_code == 200
    agent = response.json()
    url = f'/api/agents/{agent["id"]}'
    old_revision = agent['runtime_status']['revision']
    updated = client.patch(url, json={'display_name': 'Renamed', 'runtime_config': binding()})
    assert updated.status_code == 200, updated.text
    assert updated.json()['runtime_status']['revision'] == old_revision
    assert client.patch(url, json={'runtime_config': binding(OTHER)}).status_code == 409
    assert client.patch(url, json={'runtime_config': {}}).status_code == 409
    for field in ('llm', 'model', 'credential'):
        assert client.patch(url, json={'runtime_config': {**binding(), field: 'private-key'}}).status_code == 422
    # Disappearing inventory does not prevent renaming/retrying an immutable
    # binding; the Connector must revalidate its pinned local target on startup.
    advertise(main, box, refs=())
    assert client.patch(url, json={'display_name': 'Still renameable'}).status_code == 200
    retry = client.post(url + '/runtime/retry', json={})
    assert retry.status_code == 200
    assert client.get(url).json()['runtime_config'] == binding()


def test_unauthorized_bind_does_not_disclose_machine_inventory(app_client):
    client, main = app_client
    box, _, project = machine(client)
    advertise(main, box)
    assert client.post('/api/auth/register', json={'username': 'outsider', 'password': 'strong-password'}).status_code == 200
    response = create(client, box, project, runtime_config=binding())
    assert response.status_code == 404
    assert EXISTING_PROFILE_REF not in response.text

# ---------------------------------------------------------------------------
# History actions and continuation policy
# ---------------------------------------------------------------------------
"""Regression coverage for DeepOrca policy combined with native history lifecycle.

All runtime frames are synthetic. No Connector, native SDK, or local profile I/O.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from uuid import UUID

import pytest

from agentbridge.integrations.deeporca.contract import RENDERER_ID
from test_session_surfaces import add_member
from test_session_history_actions import (
    _commands, _connector_frames, _human_frames, _one, _ready,
)


ORIGIN = {"origin": "http://testserver"}
HISTORY_PROFILE_REF = "native-" + "a" * 32


def history(client, main, *, bound=False, runtime="deeporca"):
    box, headers, project = machine(client)
    descriptor = {"runtime": runtime, "agent_config": {
        "profile_modes": ["create", "bind"],
        "existing_profiles": [{"id": HISTORY_PROFILE_REF, "label": "Existing profile"}],
    }, "surfaces": [{"id": "structured", "features": {
        "session_lifecycle": 1, "context": {
            "continuity": "native" if runtime == "deeporca" else "native_resume",
            "available": True, "explicit_resume": runtime != "deeporca",
        },
    }}]}
    with main.models.SessionLocal() as db:
        db.get(main.Devbox, box).capabilities = [descriptor]
        db.commit()
    desired = ({"profile": {"mode": "bind", "profile_ref": HISTORY_PROFILE_REF, "native_stopped": True}}
               if bound else {**config(), "credential": sealed()})
    response = create(client, box, project, runtime=runtime, runtime_config=desired)
    assert response.status_code == 200, response.text
    agent = response.json()
    response = client.post(f"/api/agents/{agent['id']}/sessions", json={"surface": "structured"})
    assert response.status_code == 200, response.text
    session = response.json()
    assert str(UUID(session["id"])) == session["id"]
    with main.models.SessionLocal() as db:
        db.get(main.Session, session["id"]).launch_id = "previous-launch"
        db.commit()
    main.live_registry.get_or_create(session["id"]).mark_ended(0)
    return headers, agent, client.get(f"/api/sessions/{session['id']}").json()


@contextmanager
def connector(client, headers):
    with client.websocket_connect("/ws/devbox", headers=headers) as ws:
        assert ws.receive_json()["type"] == "hello"
        assert ws.receive_json()["type"] == "agents"
        yield ws


def ready(launch):
    return {**_ready(launch), "surface": "structured"}


def resume(client, human, runtime_socket, sid, **overrides):
    current = client.get(f"/api/sessions/{sid}").json()
    frames = _human_frames(human, {"type": "resume", "session_id": sid,
                                   "launch_id": current["launch_id"], **overrides})
    status = _one(frames, "status")
    assert status["state"] == "starting"
    launches = [frame for frame in _commands(_connector_frames(runtime_socket))
                if frame["type"] in {"open", "resume"}]
    assert len(launches) == 1, launches
    launch = launches[0]
    assert launch["launch_id"] == status["launch_id"] != current["launch_id"]
    return launch, frames


@pytest.mark.parametrize("bound", [False, True])
def test_resume_keeps_authorized_binding_and_policy_metadata(app_client, bound):
    client, main = app_client
    headers, agent, session = history(client, main, bound=bound)
    sid = session["id"]
    assert session["surface"] == "structured"
    assert session["renderer"] == RENDERER_ID
    assert session["runtime_status"] == agent["runtime_status"]
    assert session["can_rename"] and session["resume_supported"]
    assert not session["can_resume"]  # Offline, not a policy failure.
    with connector(client, headers) as runtime:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            # Attaching to history must restore, never implicitly launch.
            frames = _human_frames(human, {"type": "attach", "session_id": sid})
            assert _one(frames, "restore")["kind"] == "event"
            status = _one(frames, "status")
            assert status["code"] == "resume_required"
            assert status["renderer"] == RENDERER_ID
            assert status["runtime_status"] == agent["runtime_status"]
            assert not _commands(_connector_frames(runtime))
            # A resume request is not an alternative configuration/update route.
            launch, frames = resume(client, human, runtime, sid,
                runtime="codex-cli", runtime_config={"profile": {"mode": "bind", "profile_ref": "unowned"}},
                credential={"mode": "plaintext", "api_key": "sensitive-marker"},
                local_project_id="other-project", cwd="C:/private-profile", launch_cmd="unsafe")
            assert set(launch) == {"type", "agent_id", "session_id", "launch_id", "cols", "rows", "surface"}
            assert launch["agent_id"] == agent["id"]
            assert launch["type"] == "open"  # SDK continuation, not CLI context adoption.
            assert launch["surface"] == "structured"
            assert _one(frames, "status")["renderer"] == RENDERER_ID
            # Stale Connector frames cannot activate history. Surface facts still
            # pass through policy when the current launch becomes ready.
            _connector_frames(runtime, {**ready(launch), "launch_id": "previous-launch"})
            assert not any(f["type"] == "session.ready" for f in _human_frames(human))
            invalid = _connector_frames(runtime, {**ready(launch), "surface": "terminal"})
            assert _one(invalid, "error")["code"] == "invalid_surface"
            _connector_frames(runtime, ready(launch))
            notification = _one(_human_frames(human), "session.ready")
            assert notification["surface"] == "structured" and notification["renderer"] == RENDERER_ID
            assert client.get(f"/api/sessions/{sid}").json()["state"] == "live"
            renamed = client.patch(f"/api/sessions/{sid}", json={
                "title": "A display title", "expected_title": session["title"]})
            assert renamed.status_code == 200
            assert renamed.json()["renderer"] == RENDERER_ID
            assert renamed.json()["launch_id"] == launch["launch_id"]
            assert renamed.json()["can_resume"]
            assert _one(_human_frames(human), "session.updated")["title"] == "A display title"
    current = client.get(f"/api/agents/{agent['id']}").json()
    for key in ("runtime", "local_project_id", "runtime_config", "runtime_status"):
        assert current[key] == agent[key]


def test_launch_tagged_inputs_keep_deeporca_option_policy_and_native_ids(app_client):
    client, main = app_client
    headers, agent, session = history(client, main)
    sid = session["id"]
    with connector(client, headers) as runtime:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            launch, _ = resume(client, human, runtime, sid)
            assert not _connector_frames(runtime, ready(launch))
            assert _one(_human_frames(human), "session.ready")["launch_id"] == launch["launch_id"]
            input_id = "AABBCCDD-0000-0000-0000-000000000001"
            frame = {"type": "input", "session_id": sid, "launch_id": launch["launch_id"],
                     "client_input_id": input_id, "data": "hello", "options": {"model": "safe-model"}}
            for override in ({"runtime_config": {}}, {"credential": sealed()},
                             {"options": {"profile_ref": HISTORY_PROFILE_REF}}, {"options": {"files": []}}):
                rejection = _one(_human_frames(human, {**frame, **override}), "input_ack")
                assert rejection["reason"] == "invalid_options"
                assert rejection["client_input_id"] == input_id
                assert rejection["launch_id"] == launch["launch_id"]
                assert not main.live_registry.get(sid).pending_inputs
                assert not _connector_frames(runtime)
            for kind in ("resize", "permission"):
                assert _one(_human_frames(human, {"type": kind, "session_id": sid,
                    "launch_id": launch["launch_id"]}), "error")
            stale = _human_frames(human, {**frame, "launch_id": "previous-launch"})
            assert _one(stale, "error")["code"] == "session_changed"
            assert not _connector_frames(runtime)
            assert not _human_frames(human, frame)
            assert _one(_connector_frames(runtime), "input") == {**frame, "agent_id": agent["id"]}
            assert main.live_registry.get(sid).pending_inputs == {input_id: "hello"}
            ack = {"type": "input_ack", "agent_id": agent["id"], "session_id": sid,
                   "launch_id": launch["launch_id"], "client_input_id": input_id, "status": "delivered"}
            _connector_frames(runtime, ack)
            assert _one(_human_frames(human), "input_ack") == ack
            assert not main.live_registry.get(sid).pending_inputs


@pytest.mark.parametrize("revocation", ["viewer", "remove"])
def test_deeporca_history_resume_and_rename_recheck_access(app_client, revocation):
    client, main = app_client
    headers, agent, session = history(client, main, bound=True)
    sid = session["id"]
    member, uid = add_member(client, main, sid, "operator")
    with connector(client, headers) as runtime:
        with member.websocket_connect("/ws/term", headers=ORIGIN) as human:
            _human_frames(human, {"type": "attach", "session_id": sid})
            with main.models.SessionLocal() as db:
                membership = db.query(main.Membership).filter_by(
                    user_id=uid, workspace_id=db.get(main.Session, sid).workspace_id).one()
                if revocation == "remove":
                    db.delete(membership)
                else:
                    membership.role = "viewer"
                db.commit()
            frames = _human_frames(human, {"type": "resume", "session_id": sid,
                "launch_id": session["launch_id"], "runtime_config": config(model="replacement")})
            assert _one(frames, "error")
            assert not _commands(_connector_frames(runtime))
            assert member.patch(f"/api/sessions/{sid}", json={
                "title": "forbidden", "expected_title": session["title"]}).status_code in (403, 404)
    assert client.get(f"/api/sessions/{sid}").json()["launch_id"] == session["launch_id"]
    assert client.get(f"/api/agents/{agent['id']}").json()["runtime_config"] == agent["runtime_config"]


def test_end_allows_only_validated_idle_settings_and_resume_uses_same_identity(app_client):
    client, main = app_client
    headers, agent, session = history(client, main)
    sid, url = session["id"], f"/api/agents/{agent['id']}"
    desired = config(model="replacement/model")
    desired.pop("credential")
    with connector(client, headers) as runtime:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            first, _ = resume(client, human, runtime, sid)
            assert client.patch(url, json={"runtime_config": desired}).status_code == 409
            _connector_frames(runtime, ready(first))
            _human_frames(human)
            assert client.patch(url, json={"runtime_config": desired}).status_code == 409
            stopped = _one(_human_frames(human, {"type": "terminate", "session_id": sid,
                "launch_id": first["launch_id"]}), "status")
            assert stopped["state"] == "ended" and stopped["launch_id"] != first["launch_id"]
            assert _one(_commands(_connector_frames(runtime)), "terminate")["launch_id"] == first["launch_id"]
            assert main.live_registry.get(sid).ended
            for unsafe in ({"api_key": "plaintext"}, {"profile": {"mode": "create", "other": True}}):
                assert client.patch(url, json={"runtime_config": unsafe}).status_code == 422
            redirect = deepcopy(desired)
            redirect["llm"]["base_url"] = "https://other.example/v1"
            assert client.patch(url, json={"runtime_config": redirect}).status_code == 409
            assert client.patch(url, json={"runtime": "codex-cli"}).status_code == 409
            assert client.patch(url, json={"local_project_id": "other"}).status_code == 409
            changed = client.patch(url, json={"runtime_config": desired})
            assert changed.status_code == 200, changed.text
            updated = changed.json()
            assert updated["runtime_config"] == {**desired, "credential": agent["runtime_config"]["credential"]}
            assert updated["runtime_status"]["state"] == "pending"
            assert updated["runtime_status"]["revision"] != agent["runtime_status"]["revision"]
            _connector_frames(runtime)  # Consume only the authorized directory update.
            second, frames = resume(client, human, runtime, sid, runtime_config=agent["runtime_config"])
            assert second["session_id"] == first["session_id"]
            assert _one(frames, "status")["runtime_status"] == updated["runtime_status"]
            assert "runtime_config" not in second
            assert client.get(url).json()["runtime_config"] == updated["runtime_config"]


def test_optional_library_native_data_stays_opaque_across_history_restore(app_client):
    client, main = app_client
    main.live_registry.durable_loader = main._durable_events_loader
    headers, agent, session = history(client, main)
    sid = session["id"]
    with connector(client, headers) as runtime:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            launch, _ = resume(client, human, runtime, sid)
            assert not _connector_frames(runtime, ready(launch))
            assert _one(_human_frames(human), "session.ready")["launch_id"] == launch["launch_id"]
            event = {"type": "message.delta", "runtime": "deeporca", "message_id": "native-id",
                     "native": {"extension": {"unknown": [1, {"text": "native history"}]}}}
            output = {"type": "output", "agent_id": agent["id"], "session_id": sid,
                      "launch_id": launch["launch_id"], "pty_instance_id": ready(launch)["pty_instance_id"], "seq": 1,
                      "kind": "event", "data": json.dumps(event)}
            assert _one(_connector_frames(runtime, output), "ack")["seq"] == 1
            observed = _one(_human_frames(human), "output")
            assert json.loads(observed["data"]) == event
            _human_frames(human, {"type": "terminate", "session_id": sid, "launch_id": launch["launch_id"]})
            _connector_frames(runtime)
            frames = _human_frames(human, {"type": "attach", "session_id": sid})
            assert json.loads(_one(frames, "restore")["data"]) == event
            assert not _commands(_connector_frames(runtime))
