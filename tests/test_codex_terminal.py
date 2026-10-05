"""Codex-specific transport; shared Session semantics remain in the supervisor."""
import asyncio
import json
from uuid import uuid4

import pytest

from connector import codex_terminal as codex
from connector.local_store import LocalProjectStore
from connector.pty_session import PtySession, append_launch_args


@pytest.fixture
def remote(tmp_path, monkeypatch):
    store = LocalProjectStore(str(tmp_path / "state.db"))
    native_id = str(uuid4())
    state = {"commands": [], "rpc": [], "ids": [native_id], "closed": False}

    class Socket:
        async def send(self, message):
            state["rpc"].append(json.loads(message))
        async def recv(self):
            req = state["rpc"][-1]
            result = {}
            if req["method"] == "thread/loaded/list":
                result = {"data": state["ids"], "nextCursor": None}
            if req["method"] == "thread/read":
                if state.get("reject_resume"):
                    return json.dumps({"id": req["id"], "error": {"message": "missing"}})
                result = {"thread": {"id": req["params"]["threadId"]}}
            return json.dumps({"id": req["id"], "result": result})
        async def close(self):
            state["closed"] = True

    async def connect(url, **kwargs):
        assert url.startswith("ws://127.0.0.1:")
        state["auth"] = kwargs["additional_headers"]["Authorization"]
        return Socket()

    async def start(self):
        state["commands"].append(list(self.cmd))
        if self.context_preparing:
            self.context_preparing()
        self._alive = True

    async def wait_closed(self):
        self._alive = False

    monkeypatch.setattr(codex, "connect", connect)
    monkeypatch.setattr(PtySession, "start", start)
    monkeypatch.setattr(PtySession, "wait_closed", wait_closed)
    monkeypatch.setattr(PtySession, "is_alive", lambda self: self._alive and not self._killed)
    monkeypatch.setattr(PtySession, "write", lambda self, data: None)
    yield store, native_id, state
    store.close()


async def noop(_value):
    pass


def test_new_then_resume_uses_exact_native_mapping_and_authenticated_private_server(remote, tmp_path):
    store, native_id, state = remote
    sid = str(uuid4())

    async def run():
        first = codex.CodexTerminal(["codex", "--model", "chosen"], str(tmp_path), noop, noop,
                                    store=store, agent_id="a", session_id=sid)
        first.context_preparing = lambda: store.reserve_native_context("a", sid, "codex-cli", str(tmp_path))
        await first.start()
        await first.capture_task
        assert store.native_context("a", sid).native_id == native_id
        assert "thread/start" not in [r["method"] for r in state["rpc"]]
        assert "resume" not in first.cmd
        assert first.cmd[:3] == ["codex", "--model", "chosen"]
        assert state["auth"] == "Bearer " + first.env["AGENTBRIDGE_CODEX_REMOTE_TOKEN"]
        assert first.env["AGENTBRIDGE_CODEX_REMOTE_TOKEN"] not in first.cmd
        assert first.server.cmd[1:3] == ["--no-daemon", "app-server"]
        first.kill()
        await first.wait_closed()
        assert not first.is_alive() and not first.server.is_alive()
        state["rpc"].clear()
        second = codex.CodexTerminal(["codex", "--sandbox", "read-only"], str(tmp_path), noop, noop,
                                     store=store, agent_id="a", session_id=sid)
        await second.start()
        assert second.cmd[-2:] == ["resume", native_id]
        assert any(r["method"] == "thread/read" and r["params"]["threadId"] == native_id for r in state["rpc"])
        assert all(r["method"] != "thread/loaded/list" for r in state["rpc"])
        second.kill()
        await second.wait_closed()
    asyncio.run(run())


def test_missing_mapping_never_creates_a_replacement(remote, tmp_path):
    store, _, state = remote
    store.reserve_native_context("a", "old", "codex-cli", str(tmp_path))
    with pytest.raises(ValueError, match="not recorded"):
        codex.CodexTerminal(["codex"], str(tmp_path), noop, noop, store=store, agent_id="a", session_id="old")
    assert not state["commands"]


def test_ambiguous_identity_fails_closed_and_binding_is_immutable(remote, tmp_path):
    store, native_id, state = remote
    state["ids"] = [native_id, str(uuid4())]
    output = []
    async def emit(text):
        output.append(text)
    async def run():
        p = codex.CodexTerminal(["codex"], str(tmp_path), emit, noop, store=store, agent_id="a", session_id="s")
        p.context_preparing = lambda: store.reserve_native_context("a", "s", "codex-cli", str(tmp_path))
        await p.start()
        await p.capture_task
        assert p.stopping and "Could not save" in "".join(output)
        assert store.native_context("a", "s").native_id is None
        await p.wait_closed()
    asyncio.run(run())
    store.bind_native_id("a", "s", "codex-cli", native_id)
    store.bind_native_id("a", "s", "codex-cli", native_id)
    with pytest.raises(ValueError, match="changed"):
        store.bind_native_id("a", "s", "codex-cli", str(uuid4()))
    with pytest.raises(ValueError, match="changed"):
        store.bind_native_id("a", "s", "claude-code", native_id)


def test_failed_native_resume_cleans_up_and_does_not_launch_terminal(remote, tmp_path):
    store, native_id, state = remote
    store.reserve_native_context("a", "s", "codex-cli", str(tmp_path))
    store.bind_native_id("a", "s", "codex-cli", native_id)
    state["reject_resume"] = True
    async def run():
        p = codex.CodexTerminal(["codex"], str(tmp_path), noop, noop, store=store, agent_id="a", session_id="s")
        with pytest.raises(ValueError, match="thread/read"):
            await p.start()
        assert len(state["commands"]) == 1
        assert p.stopping and not p.server.is_alive() and state["closed"]
        assert not any(r["method"] == "thread/start" for r in state["rpc"])
    asyncio.run(run())


def test_codex_arguments_keep_config_flags_but_not_identity_or_remote_overrides():
    assert append_launch_args(["codex"], "codex-cli", "-c model=custom -p work") == [
        "codex", "-c", "model=custom", "-p", "work"]
    for args in ("--last", "--remote=ws://other", "--remote-auth-token-env=OTHER", "resume another-id", "fork another-id"):
        with pytest.raises(ValueError):
            append_launch_args(["codex"], "codex-cli", args)


def test_cancelled_start_cleans_up_server_without_creating_terminal(remote, tmp_path, monkeypatch):
    store, _, state = remote
    async def blocked(*args, **kwargs):
        await asyncio.Event().wait()
    monkeypatch.setattr(codex, "connect", blocked)
    async def run():
        p = codex.CodexTerminal(["codex"], str(tmp_path), noop, noop, store=store, agent_id="a", session_id="s")
        task = asyncio.create_task(p.start())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert p.stopping
        assert not p.server.is_alive()
        assert len(state["commands"]) == 1
    asyncio.run(run())


def test_native_binding_survives_local_store_reopen_and_cannot_be_redirected(tmp_path):
    path = str(tmp_path / "state.db")
    native_id = str(uuid4())
    store = LocalProjectStore(path)
    store.reserve_native_context("a", "s", "codex-cli", str(tmp_path))
    store.bind_native_id("a", "s", "codex-cli", native_id)
    store.close()
    store = LocalProjectStore(path)
    try:
        assert store.native_context("a", "s").native_id == native_id
        with pytest.raises(ValueError):
            store.bind_native_id("a", "s", "codex-cli", str(uuid4()))
        assert store.native_context("a", "s").native_id == native_id
    finally:
        store.close()
