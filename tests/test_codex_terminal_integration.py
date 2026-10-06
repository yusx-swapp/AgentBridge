"""Opt-in real Codex TUI, with an isolated home and a local (no-cost) model."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import threading
from uuid import uuid4

import pytest

from connector.codex_terminal import CodexTerminal
from connector.local_store import LocalProjectStore
from connector.native_writer import NativeWriterLease


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "AGENTBRIDGE_RESUME_OK", "annotations": []}]}
        events = [
            {"type": "response.created", "response": {"id": "resp_1", "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "output": [item],
             "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
        ]
        body = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.mark.skipif(os.environ.get("AGENTBRIDGE_TEST_CODEX") != "1" or not shutil.which("codex"),
                    reason="Set AGENTBRIDGE_TEST_CODEX=1 with Codex 0.160.0+ installed")
def test_real_terminal_turn_survives_restart_with_same_native_id(tmp_path, monkeypatch):
    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    thread = threading.Thread(target=model.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    (tmp_path / "config.toml").write_text(
        'model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\n'
        f'base_url="http://127.0.0.1:{model.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'
        f'[projects.{json.dumps(str(tmp_path))}]\ntrust_level="trusted"\n', encoding="utf-8")
    store = LocalProjectStore(str(tmp_path / "bridge.db"))
    sid = str(uuid4())
    outputs = []

    async def output(data):
        outputs.append(data)

    async def exited(_code):
        pass

    async def until(predicate):
        async with asyncio.timeout(30):
            while not predicate():
                await asyncio.sleep(.1)

    async def run():
        first_id = None
        for resume in (False, True):
            outputs.clear()
            p = CodexTerminal([shutil.which("codex")], str(tmp_path), output, exited,
                              store=store, agent_id="a", session_id=sid)
            p.writer_lease_factory = lambda: NativeWriterLease(str(tmp_path / "locks"), "codex-cli", sid)
            if not resume:
                p.context_preparing = lambda: store.reserve_native_context("a", sid, "codex-cli", str(tmp_path))
            try:
                await p.start()
                await until(lambda: p.native_id is not None)
                assert p.native_id == store.native_context("a", sid).native_id
                if not resume:
                    first_id = p.native_id
                    await asyncio.sleep(3)
                    p.write("Say hello")
                    await asyncio.sleep(1)  # Separate typing from Enter; avoid the CLI paste detector.
                    p.write("\r")
                await until(lambda: "AGENTBRIDGE_RESUME_OK" in "".join(outputs))
                assert p.native_id == first_id
                assert p.is_alive()
            finally:
                p.kill()
                await p.wait_closed()
                assert not p.is_alive() and not p.server.is_alive()

    try:
        asyncio.run(run())
    finally:
        store.close()
        model.shutdown()
        model.server_close()
        thread.join()
