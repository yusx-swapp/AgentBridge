"""Local route regressions for surface persistence and controller permissions."""
import importlib
import os
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    # Reload the app with a disposable database, never the developer's data.
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
    client = TestClient(main.app)
    assert client.post("/api/auth/register", json={
        "username": "owner", "password": "strong-password"}).status_code == 200
    with client:
        yield client, main
    for session in main.live_registry._sessions.values():
        session._cast.close()
    models._engine.dispose()


def make_agent(client, name="local"):
    devbox = client.post("/api/devboxes", json={"name": name}).json()
    agent = client.post(f"/api/devboxes/{devbox['devbox']['id']}/agents", json={
        "handle": name, "display_name": name, "runtime": "codex-cli"}).json()
    return devbox, agent["id"]


@pytest.mark.parametrize("surface", ["terminal", "structured", None])
def test_session_surface_create_list_and_get(app_client, surface):
    client, main = app_client
    _, agent_id = make_agent(client)
    response = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": surface})
    assert response.status_code == 200
    created = response.json()
    assert "surface" in created
    assert created["surface"] == surface
    with main.models.SessionLocal() as db:
        assert db.get(main.Session, created["id"]).surface == surface
    assert client.get(f"/api/agents/{agent_id}/sessions").json()[0]["surface"] == surface
    assert client.get(f"/api/sessions/{created['id']}").json()["surface"] == surface


@pytest.mark.parametrize("body", [{"surface": "chat"}, {"surface": []}, [], "bad"])
def test_session_create_rejects_invalid_surface_and_body(app_client, body):
    client, _ = app_client
    _, agent_id = make_agent(client)
    response = client.post(f"/api/agents/{agent_id}/sessions", json=body)
    assert response.status_code == 400
    assert client.get(f"/api/agents/{agent_id}/sessions").json() == []


def attach(ws, session_id, **extra):
    ws.send_json({"type": "attach", "session_id": session_id, **extra})
    return [ws.receive_json() for _ in range(3)]


def test_attach_uses_persisted_surface_and_rejects_switch(app_client):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "terminal"}).json()["id"]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send, \
            patch.object(main.hub, "is_agent_online", return_value=True):
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            assert send.call_args.args[1]["surface"] == "terminal"
            send.reset_mock()
            ws.send_json({"type": "attach", "session_id": sid, "surface": "structured"})
            assert ws.receive_json()["code"] == "surface_mismatch"
            send.assert_not_called()


def test_structured_attach_has_no_keyboard_lease_and_can_send(app_client):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "structured"}).json()["id"]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            frames = attach(ws, sid)
            collaboration = next(f for f in frames if f["type"] == "collaboration")
            assert collaboration["keyboard"]["required"] is False
            assert collaboration["keyboard"]["can_request"] is False
            with main.models.SessionLocal() as db:
                assert main.get_keyboard_lease(db, sid) is None
            send.reset_mock()
            ws.send_json({"type": "input", "session_id": sid, "data": "hello"})
            # Invalid ID is a synchronous barrier after the valid frame.
            ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
            assert ws.receive_json()["message"] == "invalid client_input_id"
            assert send.call_count == 1
            assert send.call_args.args[1]["data"] == "hello"


def test_structured_rest_keyboard_rejected(app_client):
    client, _ = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "structured"}).json()["id"]
    response = client.post(f"/api/sessions/{sid}/keyboard", json={"action": "acquire"})
    assert response.status_code == 400
    assert "structured" in response.json()["detail"]


@pytest.mark.parametrize("kind", ["output", "ready", "exit", "presence", "input_ack",
                                  "process_snapshot", "runtime.unavailable",
                                  "runtime_unavailable", "sessions", "v3_output"])
@pytest.mark.parametrize("claimed_agent", ["connector", "session", None])
def test_connector_cannot_modify_another_workspaces_session(app_client, kind, claimed_agent):
    client, main = app_client
    box, agent_id = make_agent(client)
    other = client.__class__(main.app)
    assert other.post("/api/auth/register", json={
        "username": "other", "password": "strong-password"}).status_code == 200
    _, foreign_agent = make_agent(other, "other")
    sid = other.post(f"/api/agents/{foreign_agent}/sessions",
                     json={"surface": "terminal"}).json()["id"]
    ls = main.live_registry.get_or_create(sid)
    frame = {"type": kind, "session_id": sid, "agent_id": agent_id,
             "data": "injected", "surface": "structured", "state": "busy", "code": 42,
             "client_input_id": "00000000-0000-0000-0000-000000000001", "status": "delivered"}
    if claimed_agent == "session":
        frame["agent_id"] = foreign_agent
    elif claimed_agent is None:
        del frame["agent_id"]
    if kind == "sessions":
        frame = {"type": kind, "sessions": [frame]}
    elif kind == "v3_output":
        frame.update(type="output", pty_instance_id="foreign-process", seq=1)
    with patch.object(main.hub, "to_session_humans", new_callable=AsyncMock) as broadcast:
        with client.websocket_connect("/ws/devbox", headers={
                "authorization": f"Bearer {box['token']}"}) as ws:
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json()["type"] == "agents"
            ws.send_json(frame)
            ws.send_json({"type": "heartbeat"})
            error = ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "invalid_session"
            assert ws.receive_json()["type"] == "heartbeat_ack"
            assert sid not in main.hub.devboxes[box["devbox"]["id"]].active_session_ids
            broadcast.assert_not_called()
    assert ls.ended is False
    assert "injected" not in ls.restore_bytes()
    with main.models.SessionLocal() as db:
        assert db.get(main.Session, sid).surface == "terminal"
        assert db.query(main.models.RecordingFrame).count() == 0


@pytest.mark.parametrize("wire_type", ["ready", "sessions", "process_snapshot"])
def test_authenticated_ready_and_snapshot_persist_resolved_surface(app_client, wire_type):
    client, main = app_client
    box, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions").json()["id"]
    item = {"session_id": sid, "agent_id": agent_id, "surface": "structured",
            "pty_instance_id": "current-process"}
    frame = {"type": wire_type, **item} if wire_type != "sessions" else {
        "type": wire_type, "sessions": [item]}
    with patch.object(main.hub, "to_session_humans", new_callable=AsyncMock) as broadcast:
        with client.websocket_connect("/ws/devbox", headers={
                "authorization": f"Bearer {box['token']}"}) as ws:
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json()["type"] == "agents"
            ws.send_json(frame)
            ws.send_json({"type": "heartbeat"})
            assert ws.receive_json()["type"] == "heartbeat_ack"
            assert sid in main.hub.devboxes[box["devbox"]["id"]].active_session_ids
            ready = next(call.args[1] for call in broadcast.call_args_list
                         if call.args[1]["type"] == "session.ready")
            assert ready["surface"] == "structured"
    assert client.get(f"/api/sessions/{sid}").json()["surface"] == "structured"


@pytest.mark.parametrize("endpoint", ["human", "connector"])
def test_websockets_reject_invalid_json_and_nonobject_frames(app_client, endpoint):
    client, _ = app_client
    if endpoint == "connector":
        box, _ = make_agent(client)
        path, headers = "/ws/devbox", {"authorization": f"Bearer {box['token']}"}
    else:
        path, headers = "/ws/term", {"origin": "http://testserver"}
    with client.websocket_connect(path, headers=headers) as ws:
        if endpoint == "connector":
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json()["type"] == "agents"
        for text in ["{invalid", "[]", "null", "42", '"private payload"', '{"type": []}']:
            ws.send_text(text)
            frame = ws.receive_json()
            assert frame["type"] == "error"
            assert frame["code"] == "invalid_frame"
            assert "private payload" not in str(frame)


def add_member(client, main, session_id, role):
    member = client.__class__(main.app)
    username = f"member-{role}"
    assert member.post("/api/auth/register", json={
        "username": username, "password": "strong-password"}).status_code == 200
    with main.models.SessionLocal() as db:
        sess = db.get(main.Session, session_id)
        user = db.query(main.User).filter_by(username=username).one()
        user_id = user.id
        db.add(main.models.Membership(id=main.new_id(), workspace_id=sess.workspace_id,
                                      user_id=user_id, role=role))
        db.commit()
    return member, user_id


@pytest.mark.parametrize("role", ["operator", "admin", "owner"])
def test_structured_controllers_share_input_without_leases(app_client, role):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "structured"}).json()["id"]
    member, _ = add_member(client, main, sid, role)
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with member.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            frames = attach(ws, sid)
            assert next(f for f in frames if f["type"] == "collaboration")["role"] == role
            send.reset_mock()
            for kind in ("input", "stdin", "permission", "interrupt", "terminate"):
                ws.send_json({"type": kind, "session_id": sid, "data": "hello", "decision": "allow"})
                if kind == "terminate":
                    ended = ws.receive_json()
                    assert ended["type"] == "status" and ended["state"] == "ended"
                ws.send_json({"type": "input", "session_id": sid, "client_input_id": "invalid"})
                rejected = ws.receive_json()
                if kind == "terminate":
                    assert rejected["code"] == "session_changed"
                else:
                    assert rejected["message"] == "invalid client_input_id"
                assert send.call_args.args[1]["type"] == kind
            assert send.call_count == 5
            with main.models.SessionLocal() as db:
                assert main.get_keyboard_lease(db, sid) is None
            ws.send_json({"type": "keyboard_acquire", "session_id": sid})
            assert ws.receive_json()["code"] == "keyboard_not_supported"


def test_viewer_cannot_send_structured_control_but_can_replay(app_client):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "structured"}).json()["id"]
    viewer, _ = add_member(client, main, sid, "viewer")
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with viewer.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            frames = attach(ws, sid)
            assert next(f for f in frames if f["type"] == "collaboration")["keyboard"]["can_request"] is False
            send.reset_mock()
            for kind in ("stdin", "input", "permission", "interrupt", "resize", "terminate"):
                ws.send_json({"type": kind, "session_id": sid, "data": "no"})
                assert ws.receive_json()["code"] == "read_only"
            send.assert_not_called()
    assert viewer.get(f"/api/sessions/{sid}/replay").status_code == 200


@pytest.mark.parametrize("surface", ["terminal", None])
def test_terminal_and_unknown_sessions_retain_exclusive_keyboard(app_client, surface):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": surface}).json()["id"]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            frames = attach(ws, sid)
            assert next(f for f in frames if f["type"] == "collaboration")["keyboard"]["required"] is True
            ws.send_json({"type": "keyboard_release", "session_id": sid})
            assert ws.receive_json()["type"] == "collaboration"
            send.reset_mock()
            for kind in ("stdin", "input", "permission", "interrupt", "resize", "terminate"):
                ws.send_json({"type": kind, "session_id": sid, "data": "no"})
                assert ws.receive_json()["code"] == "keyboard_lease_required"
                assert ws.receive_json()["type"] == "collaboration"
            send.assert_not_called()


@pytest.mark.parametrize("surface", ["terminal", "structured"])
@pytest.mark.parametrize("revocation", ["remove", "downgrade", "disable"])
def test_live_role_and_user_revocation_prevent_all_control(app_client, surface, revocation):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": surface}).json()["id"]
    member, user_id = add_member(client, main, sid, "operator")
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with member.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            attach(ws, sid)
            with main.models.SessionLocal() as db:
                sess = db.get(main.Session, sid)
                membership = db.query(main.models.Membership).filter_by(
                    workspace_id=sess.workspace_id, user_id=user_id).one()
                if revocation == "remove":
                    db.delete(membership)
                elif revocation == "downgrade":
                    membership.role = "viewer"
                else:
                    db.get(main.User, user_id).disabled_at = main.now()
                db.commit()
            send.reset_mock()
            if revocation == "disable":
                ws.send_json({"type": "input", "session_id": sid, "data": "no"})
                assert ws.receive_json()["code"] == "read_only"
                send.assert_not_called()
                assert member.get(f"/api/sessions/{sid}/replay").status_code in (401, 403, 404)
                return
            for kind in ("stdin", "input", "permission", "interrupt", "resize", "terminate"):
                ws.send_json({"type": kind, "session_id": sid, "data": "no"})
                assert ws.receive_json()["code"] == "read_only"
            for kind in ("keyboard_acquire", "keyboard_renew", "keyboard_release", "keyboard_handoff"):
                ws.send_json({"type": kind, "session_id": sid, "target_user_id": user_id})
                assert ws.receive_json()["type"] == "error"
            send.assert_not_called()
            if revocation != "downgrade":
                assert member.get(f"/api/sessions/{sid}/replay").status_code in (401, 403, 404)


def test_input_and_keyboard_commands_require_attachment_and_matching_agent(app_client):
    client, main = app_client
    _, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "structured"}).json()["id"]
    with patch.object(main.hub, "to_devbox", new_callable=AsyncMock, return_value=True) as send:
        with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as ws:
            for kind in ("input", "resize", "permission", "interrupt", "terminate", "keyboard_acquire"):
                ws.send_json({"type": kind, "session_id": sid, "data": "no"})
                assert ws.receive_json()["type"] == "error"
            send.assert_not_called()
            attach(ws, sid)
            send.reset_mock()
            ws.send_json({"type": "input", "session_id": sid, "agent_id": "wrong", "data": "no"})
            assert ws.receive_json()["code"] == "read_only"
            send.assert_not_called()


def test_invitation_api_still_defaults_to_viewer(app_client):
    client, _ = app_client
    workspace = client.get("/api/workspaces").json()[0]
    result = client.post(f"/api/workspaces/{workspace['id']}/invitations",
                         json={"email": "viewer@example.com"})
    assert result.status_code == 200
    assert result.json()["role"] == "viewer"


def test_connector_rejects_wrong_agent_and_whole_mixed_snapshot(app_client):
    client, main = app_client
    box, agent_id = make_agent(client)
    second = client.post(f"/api/devboxes/{box['devbox']['id']}/agents", json={
        "handle": "second", "display_name": "second", "runtime": "codex-cli"}).json()["id"]
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "terminal"}).json()["id"]
    other_sid = client.post(f"/api/agents/{second}/sessions", json={"surface": "terminal"}).json()["id"]
    with patch.object(main.hub, "to_session_humans", new_callable=AsyncMock) as broadcast:
        with client.websocket_connect("/ws/devbox", headers={
                "authorization": f"Bearer {box['token']}"}) as ws:
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json()["type"] == "agents"
            for kind in ("output", "input_ack", "ready", "exit", "presence", "process_snapshot",
                         "runtime.unavailable", "runtime_unavailable"):
                ws.send_json({"type": kind, "session_id": sid, "agent_id": second,
                              "surface": "structured", "data": "injected"})
                assert ws.receive_json()["code"] == "invalid_session"
            ws.send_json({"type": "sessions", "sessions": [
                {"session_id": sid, "agent_id": agent_id, "surface": "structured"},
                {"session_id": other_sid, "agent_id": agent_id, "surface": "structured"},
            ]})
            assert ws.receive_json()["code"] == "invalid_session"
            assert main.hub.devboxes[box["devbox"]["id"]].active_session_ids == set()
            broadcast.assert_not_called()
    assert client.get(f"/api/sessions/{sid}").json()["surface"] == "terminal"


def test_resolved_structured_ready_clears_old_unknown_keyboard_lease(app_client):
    client, main = app_client
    box, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions").json()["id"]
    with client.websocket_connect("/ws/term", headers={"origin": "http://testserver"}) as human:
        attach(human, sid)
        with main.models.SessionLocal() as db:
            assert main.get_keyboard_lease(db, sid) is not None
        with client.websocket_connect("/ws/devbox", headers={
                "authorization": f"Bearer {box['token']}"}) as connector:
            assert connector.receive_json()["type"] == "hello"
            assert connector.receive_json()["type"] == "agents"
            connector.send_json({"type": "ready", "session_id": sid,
                                 "agent_id": agent_id, "surface": "structured"})
            frames = [human.receive_json(), human.receive_json()]
            ready = next(frame for frame in frames if frame["type"] == "session.ready")
            assert ready["type"] == "session.ready"
            assert ready["surface"] == "structured"
            collaboration = next(frame for frame in frames if frame["type"] == "collaboration")
            assert collaboration["keyboard"]["required"] is False
            assert collaboration["keyboard"]["holder_user_id"] is None
            with main.models.SessionLocal() as db:
                assert main.get_keyboard_lease(db, sid) is None


def test_legacy_ready_does_not_infer_surface_from_runtime(app_client):
    client, main = app_client
    box, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions").json()["id"]
    with patch.object(main.hub, "to_session_humans", new_callable=AsyncMock) as broadcast:
        with client.websocket_connect("/ws/devbox", headers={
                "authorization": f"Bearer {box['token']}"}) as ws:
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json()["type"] == "agents"
            ws.send_json({"type": "ready", "session_id": sid, "runtime": "claude-code"})
            ws.send_json({"type": "heartbeat"})
            assert ws.receive_json()["type"] == "heartbeat_ack"
            assert broadcast.call_args.args[1]["surface"] is None
    assert client.get(f"/api/sessions/{sid}").json()["surface"] is None


def test_current_instance_rejects_stale_control_but_keeps_recording_replay(app_client):
    client, main = app_client
    box, agent_id = make_agent(client)
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "terminal"}).json()["id"]
    ls = main.live_registry.get_or_create(sid)
    with client.websocket_connect("/ws/devbox", headers={
            "authorization": f"Bearer {box['token']}"}) as ws:
        assert ws.receive_json()["type"] == "hello"
        assert ws.receive_json()["type"] == "agents"
        ws.send_json({"type": "sessions", "sessions": [{
            "session_id": sid, "agent_id": agent_id,
            "surface": "terminal", "pty_instance_id": "current"}]})
        for kind in ("exit", "presence", "input_ack", "runtime.unavailable"):
            ws.send_json({"type": kind, "session_id": sid, "pty_instance_id": "previous"})
            assert ws.receive_json()["code"] == "stale_instance"
        # Old-instance replay is still durably recorded/ACKed, not mistaken for
        # live process control. Existing recording cursor/hash protections apply.
        ws.send_json({"type": "output", "session_id": sid, "agent_id": agent_id,
                      "pty_instance_id": "previous", "seq": 1, "data": "history"})
        assert ws.receive_json()["type"] == "ack"
        assert sid in main.hub.devboxes[box["devbox"]["id"]].active_session_ids
    assert ls.ended is False
    with main.models.SessionLocal() as db:
        assert db.query(main.models.RecordingFrame).count() == 1


def test_replaced_connector_cannot_process_next_frame(app_client):
    from starlette.websockets import WebSocketDisconnect

    client, main = app_client
    box, agent_id = make_agent(client)
    bid = box["devbox"]["id"]
    sid = client.post(f"/api/agents/{agent_id}/sessions", json={"surface": "terminal"}).json()["id"]
    receive = main._receive_ws_object
    replacement = None

    async def replace_after_receive(ws, send):
        nonlocal replacement
        frame = await receive(ws, send)
        old = main.hub.devboxes[bid]
        replacement = main.DevboxConn(devbox_id=bid, ws=old.ws, agent_ids={agent_id})
        main.hub.devboxes[bid] = replacement
        await ws.close(code=4000)
        return frame

    with patch.object(main, "_receive_ws_object", side_effect=replace_after_receive):
        with patch.object(main.hub, "to_session_humans", new_callable=AsyncMock) as broadcast:
            with client.websocket_connect("/ws/devbox", headers={
                    "authorization": f"Bearer {box['token']}"}) as ws:
                assert ws.receive_json()["type"] == "hello"
                assert ws.receive_json()["type"] == "agents"
                ws.send_json({"type": "ready", "session_id": sid, "surface": "structured"})
                with pytest.raises(WebSocketDisconnect):
                    ws.receive_json()
            broadcast.assert_not_called()
    assert main.hub.devboxes[bid] is replacement
    assert client.get(f"/api/sessions/{sid}").json()["surface"] == "terminal"
