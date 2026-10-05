"""One Codex Terminal and its private, authenticated app-server."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
from uuid import UUID

from websockets.asyncio.client import connect

from .pty_session import PtySession
from .native_writer import NativeWriterError


class CodexSessionError(NativeWriterError):
    code = "context.codex_unavailable"

    def __init__(self, message):
        self.message = message
        super().__init__()


class CodexTerminal(PtySession):
    def __init__(self, *args, store, agent_id, session_id, **kwargs):
        super().__init__(*args, **kwargs)
        if store is None:
            raise CodexSessionError("Codex Resume requires the Connector local store")
        self.store, self.agent_id, self.session_id = store, agent_id, session_id
        marker = store.native_context(agent_id, session_id)
        self.native_id = marker.native_id if marker else None
        if marker and not self.native_id:
            raise CodexSessionError("Codex native ID was not recorded; the original session cannot be resumed")
        self.server = None
        self.connection = None
        self.capture_task = None
        self.request_id = 0
        self.stopping = False
        self.base_cmd = list(self.cmd)
        self.exited = self.on_exit
        self.on_exit = self._terminal_exited

    async def _rpc(self, method, params):
        self.request_id += 1
        number = self.request_id
        await self.connection.send(json.dumps({"id": number, "method": method, "params": params}))
        async with asyncio.timeout(15):
            while True:
                response = json.loads(await self.connection.recv())
                if response.get("id") == number:
                    if "error" in response:
                        raise CodexSessionError(f"Codex {method} failed; check native history and update Codex")
                    return response["result"]

    async def start(self):
        token = secrets.token_hex(32)
        env_key = "AGENTBRIDGE_CODEX_REMOTE_TOKEN"
        self.env = {**os.environ, env_key: token}
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        async def ignore_output(_data):
            pass  # app-server diagnostics may contain credentials; never relay them.

        async def server_exited(_code):
            if not self.stopping:
                await self.on_output("\r\nAgentBridge: Codex app-server exited. Reconnect or Resume the session.\r\n")
                self.kill()

        self.server = PtySession(
            [self.cmd[0], "--no-daemon", "app-server", "--listen", url,
             "--ws-auth", "capability-token", "--ws-token-sha256",
             hashlib.sha256(token.encode()).hexdigest()],
            self.cwd, ignore_output, server_exited)
        # The server owns the native conversation even if the terminal exits.
        self.server.writer_lease_factory, self.writer_lease_factory = self.writer_lease_factory, None
        self.server.context_preparing, self.context_preparing = self.context_preparing, None
        try:
            await self.server.start()
            async with asyncio.timeout(20):
                while not self.stopping:
                    if not self.server.is_alive():
                        raise CodexSessionError("Codex app-server unavailable; update Codex")
                    try:
                        self.connection = await connect(
                            url, additional_headers={"Authorization": f"Bearer {token}"},
                            open_timeout=1, close_timeout=2, max_size=1024 * 1024)
                        break
                    except OSError:
                        await asyncio.sleep(.1)
                if self.stopping:
                    raise ValueError("Codex startup cancelled")
                await self._rpc("initialize", {"clientInfo": {"name": "agentbridge", "version": "1"}})
                await self.connection.send(json.dumps({"method": "initialized", "params": {}}))
                if self.native_id:
                    result = await self._rpc("thread/read", {"threadId": self.native_id, "includeTurns": False})
                    if result["thread"]["id"] != self.native_id:
                        raise CodexSessionError("Codex returned a different native session")
            self.cmd = self.base_cmd + ["--remote", url, "--remote-auth-token-env", env_key]
            if self.native_id:
                self.cmd += ["resume", self.native_id]
            await super().start()
            if self.native_id:
                await self.connection.close()
            else:
                self.capture_task = asyncio.create_task(self._capture_id())
        except BaseException as exc:
            self.kill()
            await self.wait_closed()
            if isinstance(exc, (OSError, TimeoutError)):
                raise CodexSessionError("Codex app-server could not start or respond. Update Codex and retry.") from None
            raise

    async def _capture_id(self):
        try:
            while not self.stopping:
                result = await self._rpc("thread/loaded/list", {})
                ids = result["data"]
                if ids:
                    if len(ids) != 1 or result.get("nextCursor"):
                        raise ValueError("Ambiguous Codex native session")
                    native_id = str(UUID(ids[0]))
                    self.store.bind_native_id(self.agent_id, self.session_id, "codex-cli", native_id)
                    self.native_id = native_id
                    await self.connection.close()
                    return
                await asyncio.sleep(.2)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.stopping:
                await self.on_output("\r\nAgentBridge: Could not save the Codex native session ID. Session stopped to avoid resuming the wrong conversation.\r\n")
                self.kill()

    async def _terminal_exited(self, code):
        self.kill()
        await self._close_server()
        await self.exited(code)

    def kill(self):
        was_stopping = self.stopping
        self.stopping = True
        super().kill()
        if self.capture_task and self.capture_task is not asyncio.current_task():
            self.capture_task.cancel()
        if self.server and not was_stopping:
            self.server.write("\x03")

    async def _close_server(self):
        if self.server:
            try:
                await asyncio.wait_for(self.server.wait_closed(), 5)
            except TimeoutError:
                self.server.kill()
                await self.server.wait_closed()

    async def wait_closed(self):
        await super().wait_closed()
        if self.capture_task and self.capture_task is not asyncio.current_task():
            await asyncio.gather(self.capture_task, return_exceptions=True)
        if self.connection:
            await self.connection.close()
        await self._close_server()
