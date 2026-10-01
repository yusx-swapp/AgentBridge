"""PTY session manager: spawns and drives one interactive CLI per session.

Cross-platform:
  - Windows: pywinpty (ConPTY)
  - POSIX:   built-in pty + os.fork via pty.spawn-like manual loop

Each PtySession exposes write/resize/kill and async output/exit callbacks.
"""
from __future__ import annotations

import asyncio
import codecs
import os
import socket
import sys
import shlex

from . import runtimes

IS_WIN = sys.platform == "win32"
# Reads return what is already buffered, so bursts become fewer frames.
READ_BYTES = 16 * 1024


def resolve_cmd(runtime: str, launch_cmd: str | None,
                model: str | None = None,
                permission_mode: str | None = None) -> list[str]:
    """Resolve the launch argv for an agent.

    An explicit ``launch_cmd`` override still wins (split without a shell and
    validated). Otherwise the runtime adapter registry builds the exact argv
    for ``(runtime, model, permission_mode)``. Unknown runtimes raise the
    registry's error rather than silently launching a different agent.
    """
    if launch_cmd:
        argv = shlex.split(launch_cmd, posix=not IS_WIN)
        return runtimes.validate_argv(argv)
    return runtimes.build_command(runtime, model=model,
                                  permission_mode=permission_mode)



class PtySession:
    def __init__(self, cmd: list[str], cwd: str | None, on_output, on_exit,
                 cols: int = 120, rows: int = 30):
        self.cmd = cmd
        self.cwd = cwd or None
        self.on_output = on_output   # async fn(str)
        self.on_exit = on_exit       # async fn(int)
        self.cols = cols
        self.rows = rows
        self._loop = None
        self._alive = False
        self._killed = False
        self._started = False
        self._pty = None
        self._pid = None
        self._fd = None
        self._exit_code = None
        self._read_ready = None
        self._reader_task = None

    async def start(self):
        if self._started or self._killed:
            raise RuntimeError("PTY session cannot be restarted")
        self._started = True
        self._loop = asyncio.get_running_loop()
        try:
            if IS_WIN:
                await self._start_win()
            else:
                await self._start_posix()
        except BaseException:
            self.kill()
            if self._reader_task is not None:
                await asyncio.shield(self._reader_task)
            raise

    # -------- Windows (pywinpty) --------
    async def _start_win(self):
        import winpty  # type: ignore
        # PtyProcess accepts argv directly. Serializing with list2cmdline first
        # makes pywinpty split and quote it again, corrupting paths with spaces.
        self._pty = winpty.PtyProcess.spawn(
            self.cmd, cwd=self.cwd, dimensions=(self.rows, self.cols))
        self._alive = True
        self._reader_task = asyncio.create_task(self._win_reader())

    async def _win_reader(self):
        proc = self._pty
        code = -1
        try:
            while not self._killed:
                try:
                    # pywinpty exposes a blocking read; kill() also shuts down
                    # its reader socket so no executor read remains parked.
                    data = await asyncio.to_thread(proc.read, READ_BYTES)
                except EOFError:
                    break
                if data:
                    await self.on_output(data)
                elif not proc.isalive():
                    break
                else:
                    await asyncio.sleep(0.01)
        except (Exception, asyncio.CancelledError):
            # Reader/callback failure must not leave an unowned native child.
            self.kill()
        finally:
            self._alive = False
            try:
                await asyncio.to_thread(self._close_win, proc)
                status = proc.exitstatus
                if status is not None:
                    code = int(status)
            finally:
                self._pty = None
                self._exit_code = code
                await self.on_exit(code)

    @staticmethod
    def _wake_win_reader(proc):
        # pywinpty 2.x reads via an owned socket. Closing a socket alone does
        # not reliably wake recv in another thread; shutdown does.
        stream = getattr(proc, "fileobj", None)
        if stream is not None:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except (OSError, AttributeError):
                pass

    @classmethod
    def _close_win(cls, proc):
        try:
            proc.close(force=True)
        finally:
            # pywinpty's isalive() sets closed on process exit, causing close()
            # to skip the sockets. Release only resources owned by this PTY.
            cls._wake_win_reader(proc)
            for name in ("fileobj", "_server"):
                stream = getattr(proc, name, None)
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            thread = getattr(proc, "_thread", None)
            if thread is not None:
                thread.join(timeout=1.0)

    # -------- POSIX (pty) --------
    async def _start_posix(self):
        import pty
        # CLOEXEC pipe: EOF proves exec succeeded; a byte means chdir/exec
        # failed. Never continue in the supervisor's workspace on chdir error.
        error_fd, child_error_fd = os.pipe()
        try:
            pid, fd = pty.fork()
        except BaseException:
            os.close(error_fd)
            os.close(child_error_fd)
            raise
        if pid == 0:  # child
            try:
                os.close(error_fd)
                if self.cwd:
                    os.chdir(self.cwd)
                os.execvp(self.cmd[0], self.cmd)
            except BaseException:
                try:
                    os.write(child_error_fd, b"1")
                finally:
                    os._exit(127)
        os.close(child_error_fd)
        self._pid = pid
        self._fd = fd
        ready = self._loop.create_future()

        def readable():
            if not ready.done():
                ready.set_result(None)

        try:
            self._loop.add_reader(error_fd, readable)
            await ready
            if os.read(error_fd, 1):
                raise RuntimeError("PTY could not enter the workspace or execute the runtime")
        finally:
            self._loop.remove_reader(error_fd)
            os.close(error_fd)
        if self._killed:
            return
        self._alive = True
        self.resize(self.cols, self.rows)
        self._reader_task = asyncio.create_task(self._posix_reader())

    async def _read_posix(self):
        fd = self._fd
        if fd is None:
            return b""
        ready = self._loop.create_future()
        self._read_ready = ready

        def readable():
            if not ready.done():
                ready.set_result(None)

        self._loop.add_reader(fd, readable)
        try:
            await ready
            # kill() can close the fd while we await readiness. Do not read a
            # recycled descriptor, nor leave a blocking executor read behind.
            if self._fd != fd or self._killed:
                return b""
            return os.read(fd, READ_BYTES)
        finally:
            if self._fd == fd:
                self._loop.remove_reader(fd)
            self._read_ready = None

    def _poll_posix_exit(self):
        if self._pid is not None:
            try:
                pid, status = os.waitpid(self._pid, os.WNOHANG)
            except ChildProcessError:
                self._pid = None
                self._exit_code = -1
            else:
                if pid:
                    # Reap and clear ownership in the same event-loop tick:
                    # a later kill must never signal a recycled child PID.
                    self._pid = None
                    self._exit_code = os.waitstatus_to_exitcode(status)
        return self._exit_code

    def _close_posix_fd(self):
        fd, self._fd = self._fd, None
        if fd is not None:
            self._loop.remove_reader(fd)
            try:
                os.close(fd)
            except OSError:
                pass
        if self._read_ready is not None and not self._read_ready.done():
            self._read_ready.set_result(None)

    async def _posix_reader(self):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            while not self._killed:
                try:
                    data = await self._read_posix()
                except OSError:
                    break  # Linux PTYs report EIO rather than EOF.
                if not data:
                    break
                text = decoder.decode(data)
                if text:
                    await self.on_output(text)
            tail = decoder.decode(b"", final=True)
            if tail and not self._killed:
                await self.on_output(tail)
        except (Exception, asyncio.CancelledError):
            self.kill()
        finally:
            self._alive = False
            self._close_posix_fd()
            code = self._poll_posix_exit()
            while code is None:
                await asyncio.sleep(0.01)
                code = self._poll_posix_exit()
            await self.on_exit(code)

    def is_alive(self) -> bool:
        """Return whether the child behind this PTY is still running."""
        if not self._alive:
            return False
        try:
            if IS_WIN:
                alive = bool(self._pty.isalive())
            else:
                alive = self._poll_posix_exit() is None and self._pid is not None
        except (OSError, ProcessLookupError):
            alive = False
        if not alive:
            self._alive = False
        return alive

    def write(self, data: str):
        if not self.is_alive():
            return
        if IS_WIN:
            self._pty.write(data)
        else:
            os.write(self._fd, data.encode())

    def resize(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        try:
            if IS_WIN:
                self._pty.setwinsize(rows, cols)
            else:
                import fcntl, termios, struct
                fcntl.ioctl(self._fd, termios.TIOCSWINSZ,
                            struct.pack("HHHH", rows, cols, 0, 0))
        except Exception:
            pass

    def kill(self):
        self._killed = True
        self._alive = False
        try:
            if IS_WIN:
                if self._pty is not None:
                    self._pty.terminate(force=True)
            else:
                if self._pid is not None:
                    os.kill(self._pid, 9)
        except Exception:
            pass
        if IS_WIN and self._pty is not None:
            self._wake_win_reader(self._pty)
        if not IS_WIN:
            self._close_posix_fd()
            if self._pid is not None and self._reader_task is None:
                self._reader_task = asyncio.create_task(self._posix_reader())
