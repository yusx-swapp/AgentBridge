"""PTY contract/lifecycle tests: fakes plus isolated Python-only native children."""
import asyncio
import base64
import importlib.util
import json
import os
import queue
import re
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import connector.pty_session as P


async def _noop(_value):
    pass


class _Socket:
    def __init__(self, wake=lambda: None):
        self.wake = wake
        self.closed = False
        self.shutdowns = []

    def shutdown(self, how):
        self.shutdowns.append(how)
        self.wake()

    def close(self):
        self.closed = True


class _WinPty:
    def __init__(self, chunks=(), code=7):
        self.chunks = queue.Queue()
        for chunk in chunks:
            self.chunks.put(chunk)
        self.code = code
        self.exitstatus = None
        self.alive = True
        self.closed = False
        self.written = []
        self.sizes = []
        self.terminations = []
        self.read_started = threading.Event()
        self.fileobj = _Socket(lambda: self.chunks.put(EOFError()))
        self._server = _Socket()
        self._thread = SimpleNamespace(join=Mock())

    def read(self, size):
        assert size == P.READ_BYTES
        self.read_started.set()
        chunk = self.chunks.get(timeout=2)
        if isinstance(chunk, EOFError):
            self.alive = False
            self.exitstatus = self.code
            raise chunk
        return chunk

    def write(self, data):
        self.written.append(data)

    def setwinsize(self, rows, cols):
        self.sizes.append((rows, cols))

    def isalive(self):
        return self.alive

    def terminate(self, force=False):
        self.terminations.append(force)
        self.alive = False
        self.code = self.exitstatus = 9
        # Deliberately do not release read: shutdown of the owned socket must.

    def close(self, force=False):
        assert force is True
        self.closed = True


def _fake_win(monkeypatch, proc):
    spawn = Mock(return_value=proc)
    monkeypatch.setattr(P, "IS_WIN", True)
    monkeypatch.setitem(sys.modules, "winpty", SimpleNamespace(
        PtyProcess=SimpleNamespace(spawn=spawn)))
    return spawn


def test_win_argv_is_not_serialized_and_resources_close_on_nonzero_exit(monkeypatch):
    proc = _WinPty(["tail output", EOFError()])
    spawn = _fake_win(monkeypatch, proc)

    async def run():
        output, exits = [], []

        async def on_output(data):
            output.append(data)

        async def on_exit(code):
            exits.append(code)

        argv = [r"C:\Program Files\Native Agent\agent.exe", "-c",
                'print("spaces & literal | < > ^ % !")', "", 'a "quote"',
                r"C:\workspace with spaces" + "\\"]
        cwd = r"C:\local workspace with spaces"
        sess = P.PtySession(argv, cwd, on_output, on_exit, cols=117, rows=31)
        await sess.start()
        assert spawn.call_args.args[0] is argv
        assert spawn.call_args.args == (argv,)
        assert spawn.call_args.kwargs == {"cwd": cwd, "dimensions": (31, 117)}
        sess.write("input & literal\r")
        sess.resize(150, 45)
        assert proc.written == ["input & literal\r"]
        assert proc.sizes == [(45, 150)]
        # A liveness probe must not suppress unread tail output.
        proc.alive = False
        assert not sess.is_alive()
        await asyncio.wait_for(sess._reader_task, 2)
        assert output == ["tail output"]
        assert exits == [7]
        assert proc.closed and proc.fileobj.closed and proc._server.closed
        proc._thread.join.assert_called_once_with(timeout=1.0)
        assert sess._pty is None
        sess.kill()
        sess.kill()
        assert not proc.terminations

    asyncio.run(run())


def test_win_kill_wakes_blocked_read_and_is_idempotent(monkeypatch):
    proc = _WinPty()
    _fake_win(monkeypatch, proc)

    async def run():
        exits = []

        async def on_exit(code):
            exits.append(code)

        sess = P.PtySession(["fake.exe"], None, _noop, on_exit)
        await sess.start()
        assert await asyncio.to_thread(proc.read_started.wait, 1)
        sess.kill()
        await asyncio.wait_for(sess._reader_task, 2)
        sess.kill()
        sess.write("ignored")
        sess.resize(90, 25)
        assert not sess.is_alive()
        assert exits == [9]
        assert proc.terminations == [True]
        assert proc.fileobj.shutdowns
        assert proc.fileobj.closed and proc._server.closed
        assert not proc.written and not proc.sizes
        assert sess._pty is None

    asyncio.run(run())


def test_terminal_native_writer_is_held_until_process_reaped(monkeypatch):
    proc = _WinPty(["tail", EOFError()])
    spawn = _fake_win(monkeypatch, proc)
    lease = Mock()
    order = []
    lease.acquire.side_effect = lambda: order.append("acquire")
    lease.begin_process.side_effect = lambda: order.append("begin")
    lease.process_reaped.side_effect = lambda: order.append("reaped")
    lease.release.side_effect = lambda: order.append("release")
    spawn.side_effect = lambda *args, **kwargs: (order.append("spawn"), proc)[1]

    async def run():
        sess = P.PtySession(["fake"], None, _noop, _noop)
        sess.writer_lease_factory = lambda: lease
        sess.context_preparing = lambda: order.append("prepare")
        await sess.start()
        await sess._reader_task
        assert order == ["acquire", "prepare", "begin", "spawn", "reaped", "release"]
    asyncio.run(run())


def test_terminal_native_writer_refusal_never_spawns(monkeypatch):
    from connector.native_writer import NativeWriterBusy
    spawn = _fake_win(monkeypatch, _WinPty())
    lease = Mock()
    lease.acquire.side_effect = NativeWriterBusy()

    async def run():
        sess = P.PtySession(["fake"], None, _noop, _noop)
        sess.writer_lease_factory = lambda: lease
        with pytest.raises(NativeWriterBusy):
            await sess.start()
        spawn.assert_not_called()
        lease.begin_process.assert_not_called()
        lease.process_reaped.assert_not_called()
        lease.release.assert_called_once()
    asyncio.run(run())


def test_terminal_cleanup_failure_does_not_clear_native_writer_journal(monkeypatch):
    proc = _WinPty([EOFError()])
    _fake_win(monkeypatch, proc)
    lease = Mock()
    monkeypatch.setattr(P.PtySession, "_close_win", Mock(side_effect=OSError("cleanup failed")))

    async def run():
        sess = P.PtySession(["fake"], None, _noop, _noop)
        sess.writer_lease_factory = lambda: lease
        await sess.start()
        with pytest.raises(OSError, match="cleanup failed"):
            await sess.wait_closed()
        lease.process_reaped.assert_not_called()
        lease.release.assert_called_once()
    asyncio.run(run())


def test_win_spawn_failure_and_kill_before_start_are_safe(monkeypatch):
    spawn = _fake_win(monkeypatch, _WinPty())
    spawn.side_effect = OSError("fake private argv")

    async def run():
        sess = P.PtySession(["fake.exe"], None, _noop, _noop)
        with pytest.raises(OSError):
            await sess.start()
        assert not sess.is_alive()
        assert sess._pty is None and sess._reader_task is None
        sess.kill()
        fresh = P.PtySession(["fake.exe"], None, _noop, _noop)
        fresh.kill()
        with pytest.raises(RuntimeError, match="cannot be restarted"):
            await fresh.start()
        assert spawn.call_count == 1

    asyncio.run(run())


def test_posix_child_chdir_failure_never_executes_in_wrong_workspace(monkeypatch):
    class ChildExit(BaseException):
        pass

    chdir = Mock(side_effect=OSError("private cwd"))
    execute, write, close = Mock(), Mock(), Mock()

    def exit_child(code):
        assert code == 127
        raise ChildExit()

    monkeypatch.setattr(P, "IS_WIN", False)
    monkeypatch.setattr(P, "os", SimpleNamespace(
        pipe=lambda: (10, 11), close=close, chdir=chdir,
        execvp=execute, write=write, _exit=exit_child))
    monkeypatch.setitem(sys.modules, "pty", SimpleNamespace(fork=lambda: (0, -1)))

    async def run():
        sess = P.PtySession(["fake"], "/missing/private", _noop, _noop)
        with pytest.raises(ChildExit):
            await sess._start_posix()
        chdir.assert_called_once_with("/missing/private")
        execute.assert_not_called()
        write.assert_called_once_with(11, b"1")
        close.assert_called_once_with(10)

    asyncio.run(run())


def test_posix_start_failure_closes_error_pipe_master_and_reaps_child(monkeypatch):
    close, kill = Mock(), Mock()
    monkeypatch.setattr(P, "IS_WIN", False)
    monkeypatch.setattr(P, "os", SimpleNamespace(
        pipe=lambda: (10, 11), close=close, read=Mock(return_value=b"1"),
        kill=kill, WNOHANG=1, waitpid=Mock(return_value=(77, 127 << 8)),
        waitstatus_to_exitcode=lambda _status: 127))
    monkeypatch.setitem(sys.modules, "pty", SimpleNamespace(fork=lambda: (77, 12)))

    async def run():
        sess = P.PtySession(["fake"], "/missing", _noop, _noop)
        loop = SimpleNamespace(
            create_future=asyncio.get_running_loop().create_future,
            add_reader=lambda _fd, callback: callback(), remove_reader=Mock())
        start_posix = sess._start_posix

        async def start_with_fake_fds():
            sess._loop = loop
            await start_posix()

        sess._start_posix = start_with_fake_fds
        with pytest.raises(RuntimeError, match="workspace"):
            await sess.start()
        assert [call.args[0] for call in close.call_args_list] == [11, 10, 12]
        kill.assert_called_once_with(77, 9)
        assert sess._reader_task.done()
        assert sess._pid is None and sess._fd is None
        assert sess._exit_code == 127 and not sess.is_alive()
        sess.kill()
        kill.assert_called_once_with(77, 9)

    asyncio.run(run())


def test_posix_reader_preserves_split_utf8_reaps_signal_and_closes_fd(monkeypatch):
    kill, close = Mock(), Mock()
    monkeypatch.setattr(P, "IS_WIN", False)
    monkeypatch.setattr(P, "os", SimpleNamespace(
        WNOHANG=1, waitpid=Mock(return_value=(77, 9)),
        waitstatus_to_exitcode=lambda _status: -9, close=close, kill=kill))

    async def run():
        output, exits = [], []

        async def on_output(data):
            output.append(data)

        async def on_exit(code):
            exits.append(code)

        chunks = iter([b"\xe4\xbd", b"\xa0\r\n", b""])

        async def read_chunk():
            return next(chunks)

        sess = P.PtySession(["fake"], None, on_output, on_exit)
        sess._loop = SimpleNamespace(remove_reader=Mock())
        sess._pid, sess._fd, sess._alive = 77, 12, True
        sess._read_posix = read_chunk
        await sess._posix_reader()
        assert "".join(output) == "\u4f60\r\n"
        assert exits == [-9]
        assert sess._pid is None and sess._fd is None
        close.assert_called_once_with(12)
        sess.kill()
        kill.assert_not_called()  # Never signal an already-reaped/recycled PID.

    asyncio.run(run())


def test_posix_kill_wakes_readiness_wait_and_only_signals_owned_child(monkeypatch):
    kill, close, read = Mock(), Mock(), Mock()
    monkeypatch.setattr(P, "IS_WIN", False)
    monkeypatch.setattr(P, "os", SimpleNamespace(
        WNOHANG=1, waitpid=Mock(return_value=(77, 9)),
        waitstatus_to_exitcode=lambda _status: -9,
        close=close, kill=kill, read=read))

    async def run():
        sess = P.PtySession(["fake"], None, _noop, _noop)
        sess._loop = SimpleNamespace(
            create_future=asyncio.get_running_loop().create_future,
            add_reader=Mock(), remove_reader=Mock())
        sess._pid, sess._fd, sess._alive = 77, 12, True
        sess._reader_task = asyncio.create_task(sess._posix_reader())
        await asyncio.sleep(0)
        assert sess._read_ready is not None
        sess.kill()
        await asyncio.wait_for(sess._reader_task, 1)
        sess.kill()
        kill.assert_called_once_with(77, 9)
        close.assert_called_once_with(12)
        read.assert_not_called()
        assert sess._read_ready is None and sess._pid is None

    asyncio.run(run())


_WINDOWS_PTY = sys.platform == "win32" and importlib.util.find_spec("winpty") is not None
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


@pytest.mark.skipif(not _WINDOWS_PTY, reason="native Windows pywinpty only")
@pytest.mark.parametrize("exit_code", [0, 7])
def test_native_windows_python_pty_argv_input_resize_exit_cleanup(tmp_path, exit_code):
    workspace = tmp_path / "isolated workspace with spaces"
    workspace.mkdir()
    argument = 'literal spaces "quotes" & | < > ^ % ! backslash\\'
    script = (
        "import base64,json,os,sys; print('PTY_READY',flush=True); "
        "line=input(); size=os.get_terminal_size(); "
        "data=base64.b64encode(json.dumps({'cwd':os.getcwd(),'arg':sys.argv[1],"
        "'input':line,'size':[size.columns,size.lines]}).encode()).decode(); "
        "[print('DATA:'+data[i:i+70],flush=True) for i in range(0,len(data),70)]; "
        "sys.exit(int(sys.argv[2]))"
    )

    async def run():
        output, exits = [], []
        ready, exited = asyncio.Event(), asyncio.Event()

        async def on_output(data):
            output.append(data)
            if "PTY_READY" in "".join(output):
                ready.set()

        async def on_exit(code):
            exits.append(code)
            exited.set()

        sess = P.PtySession(
            [sys.executable, "-I", "-S", "-u", "-c", script, argument, str(exit_code)],
            str(workspace), on_output, on_exit, cols=111, rows=31)
        proc = None
        try:
            await sess.start()
            proc = sess._pty
            await asyncio.wait_for(ready.wait(), 15)
            sess.resize(137, 43)
            sess.write("hello collaborator\r")
            await asyncio.wait_for(exited.wait(), 15)
            clean = _ANSI.sub("", "".join(output))
            payload = "".join(re.findall(r"DATA:([A-Za-z0-9+/=]+)", clean))
            result = json.loads(base64.b64decode(payload))
            assert os.path.normcase(result["cwd"]) == os.path.normcase(str(workspace))
            assert result["arg"] == argument
            assert result["input"] == "hello collaborator"
            assert result["size"] == [137, 43]
            assert exits == [exit_code]
            assert not sess.is_alive() and sess._pty is None
            assert proc.fileobj.fileno() == -1 and proc._server.fileno() == -1
            assert not proc._thread.is_alive()
        finally:
            sess.kill()
            if sess._reader_task is not None:
                await asyncio.wait_for(asyncio.shield(sess._reader_task), 5)

    asyncio.run(run())


@pytest.mark.skipif(not _WINDOWS_PTY, reason="native Windows pywinpty only")
def test_native_windows_kill_isolated_idle_python_releases_reader(tmp_path):
    async def run():
        ready = asyncio.Event()
        output, exits = [], []

        async def on_output(data):
            output.append(data)
            if "PTY_READY" in "".join(output):
                ready.set()

        async def on_exit(code):
            exits.append(code)

        sess = P.PtySession(
            [sys.executable, "-I", "-S", "-u", "-c",
             "import time; print('PTY_READY',flush=True); time.sleep(60)"],
            str(tmp_path), on_output, on_exit)
        try:
            await sess.start()
            proc = sess._pty
            await asyncio.wait_for(ready.wait(), 15)
            sess.kill()
            await asyncio.wait_for(asyncio.shield(sess._reader_task), 5)
            assert len(exits) == 1 and exits[0] != 0
            assert sess._pty is None and not proc.isalive()
            assert proc.fileobj.fileno() == -1 and proc._server.fileno() == -1
            assert not proc._thread.is_alive()
        finally:
            sess.kill()
            if sess._reader_task is not None:
                await asyncio.wait_for(asyncio.shield(sess._reader_task), 5)

    asyncio.run(run())


@pytest.mark.skipif(os.name != "posix", reason="POSIX fork/exec handshake")
def test_native_posix_missing_cwd_fails_closed_and_reaps(tmp_path):
    async def run():
        marker = tmp_path / "must-not-run"
        sess = P.PtySession(
            [sys.executable, "-I", "-S", "-c",
             f"from pathlib import Path; Path({str(marker)!r}).write_text('bad')"],
            str(tmp_path / "missing workspace"), _noop, _noop)
        try:
            with pytest.raises(RuntimeError, match="workspace"):
                await sess.start()
            assert not marker.exists()
            assert sess._pid is None and sess._fd is None
            assert sess._reader_task.done()
        finally:
            sess.kill()

    asyncio.run(run())
