"""HTTP/history lifecycle contracts using only disposable DBs and fake WebSockets.

The barriers below acknowledge *processed frames*, not elapsed time.  In
particular, negative assertions never wait for a launch that must not happen.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch

import pytest

from test_session_surfaces import app_client, make_agent, add_member


ORIGIN = {"origin": "http://testserver"}
NATIVE_MARKER = "original-native-conversation"
COMMANDS = {"open", "resume", "input", "stdin", "permission", "interrupt", "terminate", "resize"}


def _current(client, sid):
    response = client.get(f"/api/sessions/{sid}")
    assert response.status_code == 200, response.text
    return response.json()


def _history(client, main, *, historical=True, surface="structured"):
    box, aid = make_agent(client)
    with main.models.SessionLocal() as db:
        agent = db.get(main.Agent, aid)
        agent.runtime = "fake-runtime"
        agent.runtime_config = {"native_context_id": NATIVE_MARKER}
        db.get(main.Devbox, box["devbox"]["id"]).capabilities = [{
            "runtime": "fake-runtime", "surfaces": [{"id": "structured", "features": {
                "session_lifecycle": 1, "context": {"continuity": "native_resume",
                "available": True, "explicit_resume": True}}}]}]
        db.commit()
    response = client.post(f"/api/agents/{aid}/sessions", json={"surface": surface})
    assert response.status_code == 200, response.text
    assert {"launch_id", "can_rename", "resume_supported", "can_resume", "resume_reason"} <= response.json().keys()
    sid = response.json()["id"]
    if historical:
        with main.models.SessionLocal() as db:
            db.get(main.Session, sid).launch_id = "historical-launch"
            db.commit()
    return box, aid, _current(client, sid)


def _human_frames(ws, frame=None):
    if frame is not None:
        ws.send_json(frame)
    ws.send_json([])  # Guaranteed validation reply, independent of permissions/session state.
    frames = []
    for _ in range(64):
        item = ws.receive_json()
        if item.get("code") == "invalid_frame" and "JSON object" in item.get("message", ""):
            return frames
        frames.append(item)
    pytest.fail(f"human frame barrier was not reached: {frames!r}")


def _connector_frames(ws, *frames):
    for frame in frames:
        ws.send_json(frame)
    ws.send_json({"type": "heartbeat"})
    result = []
    for _ in range(64):
        item = ws.receive_json()
        if item["type"] == "heartbeat_ack":
            return result
        result.append(item)
    pytest.fail(f"connector heartbeat barrier was not reached: {result!r}")


@contextmanager
def _connector(client, box):
    with client.websocket_connect("/ws/devbox", headers={
            "authorization": f"Bearer {box['token']}"}) as ws:
        hello = _connector_frames(ws)
        assert {"hello", "agents"} <= {f["type"] for f in hello}
        yield ws


def _commands(frames):
    return [f for f in frames if f["type"] in COMMANDS]


def _one(frames, kind):
    matches = [f for f in frames if f["type"] == kind]
    assert len(matches) == 1, frames
    return matches[0]


def _resume(client, human, connector, sid):
    previous = _current(client, sid)["launch_id"]
    frames = _human_frames(human, {"type": "resume", "session_id": sid, "launch_id": previous})
    status = _one(frames, "status")
    assert status["state"] == "starting"
    launches = _commands(_connector_frames(connector))
    assert len(launches) == 1, launches
    launch = launches[0]
    assert launch["type"] == "resume"
    assert launch["session_id"] == sid
    assert launch["surface"] == "structured"
    assert launch["launch_id"] == status["launch_id"] == _current(client, sid)["launch_id"]
    assert launch["launch_id"] and launch["launch_id"] != previous
    assert _current(client, sid)["state"] != "live"
    return launch


def _ready(launch, instance="pty-current"):
    return {"type": "ready", "session_id": launch["session_id"],
            "launch_id": launch["launch_id"], "pty_instance_id": instance, "surface": "structured"}


def test_history_json_permissions_generic_capability_and_missing_recording(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    required = {"launch_id", "can_rename", "resume_supported", "can_resume", "resume_reason"}
    assert required <= session.keys()
    assert session["can_rename"] is True
    assert session["resume_supported"] is True
    assert session["can_resume"] is False
    assert session["resume_reason"]
    assert main.live_registry.get(sid) is None  # No recording/live object exists.
    with _connector(client, box):
        current = _current(client, sid)
        assert current["can_resume"] is True
        assert not current["resume_reason"]
        listed = client.get(f"/api/agents/{aid}/sessions").json()
        assert listed == [current]
        viewer, _ = add_member(client, main, sid, "viewer")
        visible = _current(viewer, sid)
        assert required <= visible.keys()
        assert visible["can_rename"] is False
        assert visible["resume_supported"] is True
        assert visible["can_resume"] is False
        assert visible["resume_reason"]


@pytest.mark.parametrize("title", ["x", "界" * 120, '研究 <img src=x onerror="alert(1)"> & 😀'],
                         ids=["minimum", "maximum_unicode", "literal_xss"])
def test_rename_is_literal_metadata_only_and_broadcasts_after_commit(app_client, title):
    client, main = app_client
    _, aid, session = _history(client, main)
    sid = session["id"]
    live = main.live_registry.get_or_create(sid)
    live.feed_output(NATIVE_MARKER)
    live.mark_ended(0)
    recording = live.cast_path.read_bytes()
    with main.models.SessionLocal() as db:
        before = {c.name: getattr(db.get(main.Session, sid), c.name) for c in main.Session.__table__.columns}
        agent_before = deepcopy(db.get(main.Agent, aid).runtime_config)
    viewer, _ = add_member(client, main, sid, "viewer")
    original_broadcast = main.hub.to_session_humans

    async def committed_broadcast(session_id, frame):
        if frame["type"] == "session.updated":
            with main.models.SessionLocal() as db:
                assert db.get(main.Session, sid).title == title
        await original_broadcast(session_id, frame)

    with viewer.websocket_connect("/ws/term", headers=ORIGIN) as human:
        _human_frames(human, {"type": "attach", "session_id": sid})
        with patch.object(main.hub, "to_session_humans", side_effect=committed_broadcast) as broadcast:
            response = client.patch(f"/api/sessions/{sid}", json={
                "title": title, "expected_title": session["title"]})
            assert response.status_code == 200, response.text
            assert response.json()["title"] == title
            update = _one(_human_frames(human), "session.updated")
            assert update["session_id"] == sid and update["title"] == title
            assert broadcast.await_count == 1
    assert _current(client, sid)["title"] == title
    assert client.get(f"/api/agents/{aid}/sessions").json()[0]["title"] == title
    with main.models.SessionLocal() as db:
        after = {c.name: getattr(db.get(main.Session, sid), c.name) for c in main.Session.__table__.columns}
        assert after == {**before, "title": title}
        assert db.get(main.Agent, aid).runtime_config == agent_before
    assert live.ended and live._cast.closed
    assert live.cast_path.read_bytes() == recording


def test_rename_validation_conflicts_and_denials_never_broadcast(app_client):
    client, main = app_client
    _, _, session = _history(client, main)
    sid, title = session["id"], session["title"]
    viewer, _ = add_member(client, main, sid, "viewer")
    outsider = client.__class__(main.app)
    assert outsider.post("/api/auth/register", json={
        "username": "outsider", "password": "strong-password"}).status_code == 200
    bad_bodies = [{"title": value, "expected_title": title} for value in (
        "", " " * 4, "x" * 121, "first\nsecond", "first\rsecond", "a\tb", "a\x00b", "a\u2028b", "a\u2029b", None, 1)]
    bad_bodies += [[], "title", {"title": "new"}, {"expected_title": title},
                   {"title": "new", "expected_title": None}]
    bad_bodies += [{"title": "new", "expected_title": title, field: "injected"}
                   for field in ("id", "agent_id", "surface", "launch_id", "retention")]
    with patch.object(main.hub, "to_session_humans") as broadcast:
        for body in bad_bodies:
            response = client.patch(f"/api/sessions/{sid}", json=body)
            assert response.status_code in (400, 422), (body, response.text)
        assert client.patch(f"/api/sessions/{sid}", json={
            "title": "new", "expected_title": "stale title"}).status_code == 409
        for unauthorized in (viewer, outsider):
            assert unauthorized.patch(f"/api/sessions/{sid}", json={
                "title": "new", "expected_title": title}).status_code in (403, 404)
        assert client.patch("/api/sessions/no-such-session", json={
            "title": "new", "expected_title": title}).status_code == 404
        broadcast.assert_not_called()
    assert _current(client, sid) == session


def test_operator_rename_compare_and_swap_rejects_second_editor_without_broadcast(app_client):
    client, main = app_client
    _, _, session = _history(client, main)
    sid = session["id"]
    operator, _ = add_member(client, main, sid, "operator")
    assert _current(operator, sid)["can_rename"] is True
    with patch.object(main.hub, "to_session_humans") as broadcast:
        first = operator.patch(f"/api/sessions/{sid}", json={
            "title": "operator edit", "expected_title": session["title"]})
        assert first.status_code == 200
        broadcast.assert_awaited_once()
        broadcast.reset_mock()
        stale = client.patch(f"/api/sessions/{sid}", json={
            "title": "lost update", "expected_title": session["title"]})
        assert stale.status_code == 409
        broadcast.assert_not_called()
    assert _current(client, sid)["title"] == "operator edit"
    assert _current(client, sid)["launch_id"] == session["launch_id"]


def test_historical_attach_and_open_alias_never_spawn_even_after_server_reload(app_client, monkeypatch):
    client, main = app_client
    box, _, session = _history(client, main)
    sid = session["id"]
    live = main.live_registry.get_or_create(sid)
    live.feed_output("previous conversation")
    live.mark_ended(0)
    for restarted in (False, True):
        if restarted:
            # Retain the fixture DB/cast, discard only volatile server lifecycle state.
            from server.app.live import LiveRegistry
            from server.app.hub import Hub
            monkeypatch.setattr(main, "live_registry", LiveRegistry())
            monkeypatch.setattr(main, "hub", Hub())
        with _connector(client, box) as connector:
            for kind in ("attach", "open", "attach"):
                with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
                    frames = _human_frames(human, {"type": kind, "session_id": sid})
                    assert "previous conversation" in _one(frames, "restore")["data"]
                    assert _one(frames, "status")["state"] in ("inactive", "ended")
                    assert _commands(_connector_frames(connector)) == []
                    assert _current(client, sid)["launch_id"] == session["launch_id"]


def test_viewer_attach_to_never_started_session_does_not_launch(app_client):
    client, main = app_client
    box, _, session = _history(client, main, historical=False)
    sid = session["id"]
    assert session["launch_id"] is None
    viewer, _ = add_member(client, main, sid, "viewer")
    with _connector(client, box) as connector:
        with viewer.websocket_connect("/ws/term", headers=ORIGIN) as human:
            frames = _human_frames(human, {"type": "attach", "session_id": sid})
            assert _one(frames, "collaboration")["role"] == "viewer"
            assert _one(frames, "status")["state"] != "starting"
            assert _commands(_connector_frames(connector)) == []
            assert _current(client, sid)["launch_id"] is None


@pytest.mark.parametrize("invalid_ready", ["missing_launch", "stale_launch", "missing_instance", "empty_instance"])
def test_resume_starts_same_id_but_only_matching_ready_can_make_it_live(app_client, invalid_ready):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            launch = _resume(client, human, connector, sid)
            invalid = _ready(launch)
            if invalid_ready == "missing_launch":
                invalid.pop("launch_id")
            elif invalid_ready == "stale_launch":
                invalid["launch_id"] = session["launch_id"]
            elif invalid_ready == "missing_instance":
                invalid.pop("pty_instance_id")
            else:
                invalid["pty_instance_id"] = ""
            _connector_frames(connector, invalid)
            assert _current(client, sid)["state"] != "live"
            assert not any(f["type"] == "session.ready" for f in _human_frames(human))
            _connector_frames(connector, _ready(launch))
            ready = _one(_human_frames(human), "session.ready")
            assert ready["launch_id"] == launch["launch_id"]
            assert ready["pty_instance_id"] == "pty-current"
            assert _current(client, sid)["state"] == "live"
            for kind in ("attach", "open"):
                assert _one(_human_frames(human, {"type": kind, "session_id": sid}), "status")["state"] == "live"
            assert _commands(_connector_frames(connector)) == []
            assert [s["id"] for s in client.get(f"/api/agents/{aid}/sessions").json()] == [sid]


@pytest.mark.parametrize("condition", ["viewer", "offline", "old_connector", "not_native", "terminal", "unknown_surface", "missing_token", "stale_token", "wrong_agent", "wrong_surface"])
def test_resume_requires_current_operator_token_surface_and_explicit_native_capability(app_client, condition):
    client, main = app_client
    surface = "terminal" if condition == "terminal" else None if condition == "unknown_surface" else "structured"
    box, _, session = _history(client, main, surface=surface)
    sid = session["id"]
    actor = add_member(client, main, sid, "viewer")[0] if condition == "viewer" else client
    if condition in ("old_connector", "not_native"):
        with main.models.SessionLocal() as db:
            devbox = db.get(main.Devbox, box["devbox"]["id"])
            caps = deepcopy(devbox.capabilities)
            context = caps[0]["surfaces"][0]["features"]["context"]
            if condition == "old_connector":
                context.pop("explicit_resume")
            else:
                context["continuity"] = "fresh"
            devbox.capabilities = caps
            db.commit()
    frame = {"type": "resume", "session_id": sid, "launch_id": session["launch_id"]}
    if condition == "missing_token":
        frame.pop("launch_id")
    elif condition == "stale_token":
        frame["launch_id"] = "not-current"
    elif condition == "wrong_agent":
        frame["agent_id"] = "not-this-agent"
    elif condition == "wrong_surface":
        frame["surface"] = "terminal"
    if condition == "offline":
        with actor.websocket_connect("/ws/term", headers=ORIGIN) as human:
            frames = _human_frames(human, frame)
            assert _one(frames, "status")["state"] == "offline"
    else:
        with _connector(client, box) as connector:
            if condition not in ("missing_token", "stale_token", "wrong_agent", "wrong_surface"):
                assert _current(actor, sid)["can_resume"] is False
                assert _current(actor, sid)["resume_reason"]
            with actor.websocket_connect("/ws/term", headers=ORIGIN) as human:
                frames = _human_frames(human, frame)
                assert any(f["type"] in ("error", "runtime.unavailable") for f in frames), frames
                assert not any(f.get("state") in ("starting", "live") for f in frames)
                assert _commands(_connector_frames(connector)) == []
    assert _current(client, sid)["launch_id"] == session["launch_id"]


@pytest.mark.parametrize("revocation", ["remove", "downgrade"])
def test_existing_socket_resume_and_http_rename_recheck_membership(app_client, revocation):
    client, main = app_client
    box, _, session = _history(client, main)
    sid = session["id"]
    member, uid = add_member(client, main, sid, "operator")
    with _connector(client, box) as connector:
        with member.websocket_connect("/ws/term", headers=ORIGIN) as human:
            _human_frames(human, {"type": "attach", "session_id": sid})
            with main.models.SessionLocal() as db:
                membership = db.query(main.models.Membership).filter_by(
                    user_id=uid, workspace_id=db.get(main.Session, sid).workspace_id).one()
                if revocation == "remove":
                    db.delete(membership)
                else:
                    membership.role = "viewer"
                db.commit()
            frames = _human_frames(human, {"type": "resume", "session_id": sid,
                                          "launch_id": session["launch_id"]})
            assert _one(frames, "error")
            assert _commands(_connector_frames(connector)) == []
            assert member.patch(f"/api/sessions/{sid}", json={
                "title": "forbidden", "expected_title": session["title"]}).status_code in (403, 404)
    assert _current(client, sid)["launch_id"] == session["launch_id"]


def test_concurrent_resume_with_same_expected_launch_queues_only_once(app_client):
    client, main = app_client
    box, _, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as first:
            with client.websocket_connect("/ws/term", headers=ORIGIN) as second:
                barrier = Barrier(2)

                def compete(ws):
                    barrier.wait(timeout=5)
                    return _human_frames(ws, {"type": "resume", "session_id": sid,
                                              "launch_id": session["launch_id"]})

                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(compete, (first, second)))
                frames = [frame for result in results for frame in result]
                assert sum(f.get("state") == "starting" for f in frames) == 1
                assert sum(f.get("code") == "session_changed" for f in frames) == 1
                commands = _commands(_connector_frames(connector))
                assert len(commands) == 1 and commands[0]["type"] == "resume"
                assert commands[0]["session_id"] == sid
                assert _current(client, sid)["state"] != "live"


def test_native_prepare_failure_is_reported_without_fresh_open_fallback(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            launch = _resume(client, human, connector, sid)
            _connector_frames(connector, {**_ready(launch), "type": "runtime.unavailable",
                "runtime": "fake-runtime", "code": "native_context_missing"})
            failure = _one(_human_frames(human), "runtime.unavailable")
            assert failure["code"] == "native_context_missing"
            assert _current(client, sid)["state"] != "live"
            for kind in ("attach", "open"):
                frames = _human_frames(human, {"type": kind, "session_id": sid})
                assert _one(frames, "status")["state"] not in ("starting", "live")
            assert _commands(_connector_frames(connector)) == []
            assert [s["id"] for s in client.get(f"/api/agents/{aid}/sessions").json()] == [sid]


def test_end_then_fresh_resume_reuses_live_session_and_appends_without_replaying_input(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            first = _resume(client, human, connector, sid)
            _connector_frames(connector, _ready(first, "pty-old"), {
                "type": "output", "session_id": sid, "launch_id": first["launch_id"],
                "data": "before resume\r\n"})
            _human_frames(human)
            live = main.live_registry.get(sid)
            pending_id = "00000000-0000-0000-0000-000000000123"
            _human_frames(human, {"type": "input", "session_id": sid,
                "launch_id": first["launch_id"], "client_input_id": pending_id, "data": "never replay me"})
            assert _one(_commands(_connector_frames(connector)), "input")["data"] == "never replay me"
            assert pending_id in live.pending_inputs
            frames = _human_frames(human, {"type": "terminate", "session_id": sid,
                                          "launch_id": first["launch_id"]})
            ended_token = _current(client, sid)["launch_id"]
            assert ended_token != first["launch_id"]
            assert _one(frames, "status")["state"] == "ended"
            assert _one(_commands(_connector_frames(connector)), "terminate")["launch_id"] == first["launch_id"]
            assert live.ended and live._cast.closed
            prior_cast = live.cast_path.read_bytes()
            second = _resume(client, human, connector, sid)
            assert second["launch_id"] not in (first["launch_id"], ended_token)
            _connector_frames(connector, _ready(second, "pty-new"))
            _human_frames(human)
            assert main.live_registry.get(sid) is live
            assert not live.ended and not live._cast.closed
            assert not live.pending_inputs
            _connector_frames(connector, {"type": "output", "session_id": sid,
                "launch_id": second["launch_id"], "data": "after resume\r\n"})
            assert live.cast_path.read_bytes().startswith(prior_cast)
            assert "before resume" in live.restore_bytes() and "after resume" in live.restore_bytes()
            assert "never replay me" not in live.cast_path.read_text(encoding="utf-8")
            for token in (first["launch_id"], ended_token, None):
                for kind in ("input", "stdin", "permission", "interrupt", "resize", "terminate"):
                    frames = _human_frames(human, {"type": kind, "session_id": sid,
                        "launch_id": token, "data": "stale", "decision": "allow"})
                    assert _one(frames, "error")["code"] == "session_changed"
            assert _commands(_connector_frames(connector)) == []
            assert _current(client, sid)["state"] == "live"
            assert _current(client, sid)["launch_id"] == second["launch_id"]
    with main.models.SessionLocal() as db:
        assert db.get(main.Agent, aid).runtime_config["native_context_id"] == NATIVE_MARKER


@pytest.mark.parametrize("kind", ["ready", "exit", "process_snapshot", "sessions"])
def test_end_durable_token_rejects_old_connector_frames_after_memory_loss(app_client, kind):
    client, main = app_client
    box, _, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            launch = _resume(client, human, connector, sid)
            _connector_frames(connector, _ready(launch, "pty-old"))
            _human_frames(human)
            _human_frames(human, {"type": "terminate", "session_id": sid,
                                  "launch_id": launch["launch_id"]})
            _connector_frames(connector)
            ended = _current(client, sid)["launch_id"]
            assert ended != launch["launch_id"]
            # Model a reload losing the ended flag; the DB token is the fence.
            main.live_registry.drop(sid)
            assert not main.live_registry.get_or_create(sid).ended
            old = {**_ready(launch, "pty-old"), "type": kind, "code": 0}
            if kind == "sessions":
                old = {"type": kind, "sessions": [_ready(launch, "pty-old")]}
            _connector_frames(connector, old)
            assert _current(client, sid)["state"] != "live"
            assert _current(client, sid)["launch_id"] == ended
            assert not main.live_registry.get(sid).ended  # Stale exit must not mutate it either.
            frames = _human_frames(human, {"type": "open", "session_id": sid})
            assert _one(frames, "status")["state"] != "starting"
            assert _commands(_connector_frames(connector)) == []
            # The same stale notification must not stop or replace a newer run.
            current = _resume(client, human, connector, sid)
            _connector_frames(connector, _ready(current, "pty-new"))
            _human_frames(human)
            assert _current(client, sid)["state"] == "live"
            _connector_frames(connector, old)
            assert _current(client, sid)["state"] == "live"
            assert _current(client, sid)["launch_id"] == current["launch_id"]
            assert not main.live_registry.get(sid).ended
            assert not any(f["type"] in ("session.ready", "exit") for f in _human_frames(human))
            assert _commands(_connector_frames(connector)) == []


def test_launch_migration_marks_legacy_rows_once_and_leaves_new_rows_unstarted(app_client):
    client, main = app_client
    _, aid, session = _history(client, main)
    # Only the disposable fixture database is changed; simulate a pre-column schema.
    with main.models._engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE session DROP COLUMN launch_id")
    main.models._migrate(main.models._engine)
    assert _current(client, session["id"])["launch_id"] == "legacy"
    response = client.post(f"/api/agents/{aid}/sessions", json={"surface": "structured"})
    assert response.status_code == 200
    assert response.json()["launch_id"] is None
    main.models._migrate(main.models._engine)
    assert _current(client, response.json()["id"])["launch_id"] is None
    assert _current(client, session["id"])["launch_id"] == "legacy"


@pytest.mark.parametrize(("frame_type", "code", "text"), [
    ("error", "start_failed", "CLI could not be started"),
    ("runtime.unavailable", "spawn_failed", "CLI could not be started"),
    ("runtime.unavailable", "context.not_found", "No local native-context record"),
    ("runtime.unavailable", "context.runtime_mismatch", "original runtime"),
    ("runtime.unavailable", "context.cwd_mismatch", "original local project"),
    ("runtime.unavailable", "context.recovery_required", "explicit local recovery"),
    ("runtime.unavailable", "runtime_not_authenticated", "authentication check reported not signed in"),
    ("runtime.unavailable", "runtime_auth_probe_failed", "could not check runtime authentication"),
    ("error", "runtime_not_authenticated", "authentication check reported not signed in"),
    ("error", "runtime_auth_probe_failed", "could not check runtime authentication"),
])
def test_resume_failure_is_visible_sanitized_and_stale_failure_cannot_break_retry(
        app_client, frame_type, code, text):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            current = _resume(client, human, connector, sid)
            raw = "C:/private-project/raw-stderr-secret"
            failure = {"type": frame_type, "agent_id": aid, "session_id": sid,
                       "launch_id": current["launch_id"], "code": code, "message": raw}
            _connector_frames(connector, failure)
            visible = _human_frames(human)
            event = _one(visible, frame_type)
            assert text in event["message"]
            assert event["code"] == code
            assert raw not in str(visible)
            assert _current(client, sid)["state"] != "live"
            # Failure never creates a replacement Session or retries implicitly.
            rows = client.get(f"/api/agents/{aid}/sessions").json()
            assert [row["id"] for row in rows] == [sid]
            assert _commands(_connector_frames(connector)) == []
            retry = _resume(client, human, connector, sid)
            _connector_frames(connector, _ready(retry, "pty-retry"))
            _human_frames(human)
            stale = _connector_frames(connector, failure)
            assert any(frame.get("code") == "stale_launch" for frame in stale)
            assert _human_frames(human) == []
            assert _current(client, sid)["state"] == "live"


def test_snapshot_duplicate_rows_cannot_overwrite_current_instance(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            current = _resume(client, human, connector, sid)
            ready = _ready(current, "pty-current")
            _connector_frames(connector, ready)
            _human_frames(human)
            replies = _connector_frames(connector, {
                "type": "sessions", "sessions": [ready, {**ready, "launch_id": "older"}]})
            assert any(frame.get("code") == "invalid_session" for frame in replies)
            assert _current(client, sid)["state"] == "live"
            owner = main.hub.devboxes[main.hub.agent_to_devbox[aid]]
            assert owner.session_instances[sid] == "pty-current"


def test_end_during_resume_startup_invalidates_late_ready_and_allows_explicit_retry(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            starting = _resume(client, human, connector, sid)
            status = _one(_human_frames(human, {
                "type": "terminate", "session_id": sid, "launch_id": starting["launch_id"]}), "status")
            assert status["state"] == "ended"
            terminate = _one(_commands(_connector_frames(connector)), "terminate")
            assert terminate["launch_id"] == starting["launch_id"]
            assert status["launch_id"] != starting["launch_id"]
            _connector_frames(connector, _ready(starting, "pty-late"))
            assert not any(f.get("type") == "session.ready" for f in _human_frames(human))
            assert _current(client, sid)["state"] != "live"
            retry = _resume(client, human, connector, sid)
            assert retry["session_id"] == sid and retry["launch_id"] != status["launch_id"]


def test_legacy_end_targets_the_legacy_connector_generation_not_the_server_backfill(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with main.models.SessionLocal() as db:
        db.get(main.Session, sid).launch_id = "legacy"
        db.commit()
    with _connector(client, box) as connector:
        _connector_frames(connector, _ready({"agent_id": aid, "session_id": sid,
                                           "launch_id": None}, "pty-legacy"))
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            _human_frames(human, {"type": "attach", "session_id": sid, "surface": "structured"})
            ended = _human_frames(human, {"type": "terminate", "session_id": sid, "launch_id": "legacy"})
            assert _one(ended, "status")["state"] == "ended"
            terminate = _one(_commands(_connector_frames(connector)), "terminate")
            assert terminate["launch_id"] is None


def test_explicit_resume_reattaches_a_now_live_process_without_rotating_or_queueing_open(app_client):
    client, main = app_client
    box, aid, session = _history(client, main)
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as first:
            starting = _resume(client, first, connector, sid)
            _connector_frames(connector, _ready(starting, "pty-live"))
            _human_frames(first)
            with client.websocket_connect("/ws/term", headers=ORIGIN) as second:
                frames = _human_frames(second, {
                    "type": "resume", "session_id": sid, "launch_id": starting["launch_id"]})
                status = _one(frames, "status")
                assert status["state"] == "live" and status["reattached"] is True
                assert status["launch_id"] == starting["launch_id"]
                assert _current(client, sid)["launch_id"] == starting["launch_id"]
                assert _commands(_connector_frames(connector)) == []


def test_terminal_device_status_query_keeps_connector_live_and_keyboard_working(app_client):
    client, main = app_client
    box, aid, session = _history(client, main, historical=False, surface="terminal")
    sid = session["id"]
    with _connector(client, box) as connector:
        with client.websocket_connect("/ws/term", headers=ORIGIN) as human:
            _human_frames(human, {"type": "open", "session_id": sid})
            launch = _one(_commands(_connector_frames(connector)), "open")
            _connector_frames(connector, {**_ready(launch), "surface": "terminal"})
            _human_frames(human)
            data = "before\x1b[?6nafter"
            replies = _connector_frames(connector, {
                "type": "output", "session_id": sid, "agent_id": aid,
                "launch_id": launch["launch_id"], "pty_instance_id": "pty-current",
                "seq": 1, "data": data})
            assert _one(replies, "ack")["session_id"] == sid
            assert _one(_human_frames(human), "output")["data"] == data
            assert _current(client, sid)["state"] == "live"
            assert "beforeafter" in main.live_registry.get(sid).restore_bytes()
            for kind, payload in (("resize", {"cols": 100, "rows": 30}), ("stdin", {"data": "x"})):
                frames = _human_frames(human, {"type": kind, "session_id": sid,
                    "launch_id": launch["launch_id"], **payload})
                assert not any(frame["type"] == "error" for frame in frames)
                command = _one(_commands(_connector_frames(connector)), kind)
                assert all(command[key] == value for key, value in payload.items())
            assert _commands(replies) == []  # The recording screen never answers terminal queries.
