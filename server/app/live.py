"""LiveSession — the platform value layer.

For every session we keep:
  - a pyte headless terminal emulator that holds the AUTHORITATIVE current screen
    (so a reconnecting/late viewer can be restored instantly, bounded by screen size)
  - an on-disk asciicast v2 recording (DVR) of every output chunk with timestamps
    (so the full session can be replayed / audited — something a local terminal lacks)
  Watcher routing lives only in Hub; this module owns output and recording state.

Viewers come and go freely; the PTY (the live process) lives on the devbox and is
NOT affected by viewers detaching. This module never touches the PTY directly — it
only records what flows through and broadcasts it.
"""
from __future__ import annotations

import json
import time

import pyte

from .config import settings

DATA_DIR = settings.data_dir / "sessions"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_COLS = 120
DEFAULT_ROWS = 30


def _sgr_prefix(char) -> str:
    """Build an ANSI SGR sequence for a pyte Char's attributes."""
    codes = ["0"]
    fg = char.fg
    bg = char.bg
    if char.bold:
        codes.append("1")
    if char.italics:
        codes.append("3")
    if char.underscore:
        codes.append("4")
    if char.reverse:
        codes.append("7")
    if fg and fg != "default":
        codes.append(_color_code(fg, fgbg="fg"))
    if bg and bg != "default":
        codes.append(_color_code(bg, fgbg="bg"))
    return "\x1b[" + ";".join(c for c in codes if c) + "m"


_NAMED = {
    "black": 0, "red": 1, "green": 2, "brown": 3, "blue": 4,
    "magenta": 5, "cyan": 6, "white": 7,
}


def _color_code(col: str, fgbg: str) -> str:
    base = 30 if fgbg == "fg" else 40
    if col in _NAMED:
        return str(base + _NAMED[col])
    # pyte gives 6-hex-digit truecolor strings for xterm-256/truecolor
    try:
        r = int(col[0:2], 16); g = int(col[2:4], 16); b = int(col[4:6], 16)
        lead = 38 if fgbg == "fg" else 48
        return f"{lead};2;{r};{g};{b}"
    except Exception:
        return ""


def _render_line(line, columns: int) -> str:
    out: list[str] = []
    last = ""
    for col in range(columns):
        ch = line[col]
        pre = _sgr_prefix(ch)
        if pre != last:
            out.append(pre)
            last = pre
        out.append(ch.data or " ")
    out.append("\x1b[0m")
    return "".join(out)


def serialize_screen(screen: pyte.Screen) -> str:
    """Reproduce scrollback + exact current picture in a fresh terminal.

    ED(2) clears only the viewport (not xterm scrollback), so historical lines
    are emitted first, then the viewport is cleared/repainted and cursor placed.
    """
    out: list[str] = []
    history = getattr(screen, "history", None)
    if history:
        for line in history.top:
            out.append(_render_line(line, screen.columns))
            out.append("\r\n")
    out.append("\x1b[2J\x1b[H")  # clear viewport + home, preserve scrollback
    for row in range(screen.lines):
        line = screen.buffer[row]
        out.append(f"\x1b[{row + 1};1H")
        out.append(_render_line(line, screen.columns))
    out.append("\x1b[0m")
    # place cursor where it belongs
    out.append(f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}H")
    return "".join(out)


class _RecordingScreen(pyte.HistoryScreen):
    def report_device_status(self, mode: int = 0, private: bool = False) -> None:
        """Ignore DSR/DEC DSR: this observer never sends replies to the PTY.

        pyte 0.8.2 dispatches DEC DSR with private=True, which its Screen rejects.
        """


class LiveSession:
    def __init__(self, session_id: str, cols: int, rows: int):
        self.session_id = session_id
        self.cols = cols
        self.rows = rows
        self.screen = _RecordingScreen(cols, rows, history=5000)
        self.stream = pyte.ByteStream(self.screen)
        self.ended = False
        self.exit_code: int | None = None
        self.delivered_input_ids: set[str] = set()
        self.pending_inputs: dict[str, str] = {}
        self.start_time = time.time()
        self.cast_path = DATA_DIR / f"{session_id}.cast"
        self._open_cast()

    # ---- DVR (asciicast v2) ----
    def _open_cast(self):
        new = not self.cast_path.exists()
        self._cast = open(self.cast_path, "a", encoding="utf-8")
        if new:
            header = {"version": 2, "width": self.cols, "height": self.rows,
                      "timestamp": int(self.start_time), "env": {"TERM": "xterm-256color"}}
            self._cast.write(json.dumps(header) + "\n")
            self._cast.flush()

    def _record(self, kind: str, data: str):
        t = round(time.time() - self.start_time, 6)
        self._cast.write(json.dumps([t, kind, data]) + "\n")
        self._cast.flush()

    def replay_into_screen(self):
        """Rebuild current screen from an existing .cast (used after server restart)."""
        if not self.cast_path.exists():
            return
        with open(self.cast_path, encoding="utf-8") as fp:
            first = True
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                if first:
                    first = False  # header
                    continue
                try:
                    _, kind, data = json.loads(line)
                except Exception:
                    continue
                if kind == "o":
                    self.stream.feed(data.encode("utf-8", "replace"))

    def cast_events(self) -> list:
        """Read legacy .cast output events as [t, kind, data] lists."""
        events: list = []
        if not self.cast_path.exists():
            return events
        with open(self.cast_path, encoding="utf-8") as fp:
            first = True
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                if first:
                    first = False  # header
                    continue
                try:
                    t, kind, data = json.loads(line)
                except Exception:
                    continue
                events.append([t, kind, data])
        return events

    def feed_durable_events(self, events) -> None:
        """Feed committed v3 output frames into the screen (no .cast write)."""
        for _t, kind, data in events:
            if kind == "o":
                self.stream.feed(data.encode("utf-8", "replace"))

    def feed_live_output(self, data: str) -> None:
        """A durable v3 chunk was persisted: update the screen only.

        The DB is the record of truth for v3 output, so this deliberately does
        NOT write to the legacy .cast (no dual-write). Broadcasting to viewers
        is the caller's responsibility.
        """
        self.stream.feed(data.encode("utf-8", "replace"))

    # ---- live path ----
    def feed_output(self, data: str):
        """A chunk of PTY output arrived: update screen + record + (caller broadcasts)."""
        self.stream.feed(data.encode("utf-8", "replace"))
        self._record("o", data)

    def queue_input(self, client_input_id: str, data: str) -> None:
        """Remember input content until the connector confirms PTY delivery."""
        if client_input_id not in self.delivered_input_ids:
            self.pending_inputs.setdefault(client_input_id, data)

    def acknowledge_input(self, client_input_id: str, status: str = "delivered") -> bool:
        """Record confirmed delivery; discard rejected input without recording it."""
        if status not in {"delivered", "rejected"} or client_input_id in self.delivered_input_ids:
            return False
        data = self.pending_inputs.pop(client_input_id, None)
        if data is None or status != "delivered":
            return False
        self.delivered_input_ids.add(client_input_id)
        self._record("i", data)
        return True

    def resize(self, cols: int, rows: int):
        if cols == self.cols and rows == self.rows:
            return
        self.cols, self.rows = cols, rows
        self.screen.resize(rows, cols)
        self._record("r", f"{cols}x{rows}")

    def restore_bytes(self) -> str:
        return serialize_screen(self.screen)

    def mark_resumed(self):
        """Confirmed same-session resume reopens append-only recording, not history."""
        if self.ended:
            if self._cast.closed:
                self._open_cast()
            self.pending_inputs.clear()  # never replay queued user input after End
            self.ended = False
            self.exit_code = None

    def mark_ended(self, code: int | None):
        self.ended = True
        self.exit_code = code
        try:
            self._record("x", str(code))
            self._cast.close()
        except Exception:
            pass


class LiveRegistry:
    def __init__(self, durable_loader=None):
        self._sessions: dict[str, LiveSession] = {}
        # Optional callback: session_id -> list of [t, kind, data] events read
        # from durable v3 storage. Kept as a callback so the registry never
        # holds a long-lived request Session; it opens its own short-lived one.
        self.durable_loader = durable_loader

    def get(self, session_id: str) -> LiveSession | None:
        return self._sessions.get(session_id)

    def _load_durable(self, session_id: str):
        if self.durable_loader is None:
            return []
        try:
            return self.durable_loader(session_id) or []
        except Exception:
            return []

    def get_or_create(self, session_id: str, cols: int = DEFAULT_COLS,
                      rows: int = DEFAULT_ROWS) -> LiveSession:
        ls = self._sessions.get(session_id)
        if ls is None:
            ls = LiveSession(session_id, cols, rows)
            # server restarted but session had prior history → rebuild screen
            # from both the legacy .cast history and durable v3 frames.
            try:
                if ls.cast_path.exists() and ls.cast_path.stat().st_size > 0:
                    ls.replay_into_screen()
                ls.feed_durable_events(self._load_durable(session_id))
            except Exception:
                pass
            self._sessions[session_id] = ls
        return ls

    def merged_events(self, session_id: str) -> list:
        """Legacy .cast events followed by durable v3 events, each once.

        Returns a list of [t, kind, data]. Deterministic order: all legacy
        cast events first (as recorded), then durable frames in committed row
        order with a monotonic clock. Used to serve a valid merged asciicast v2
        recording without mutating the old .cast.
        """
        ls = self._sessions.get(session_id)
        cast = ls.cast_events() if ls is not None else _read_cast_events(session_id)
        durable = self._load_durable(session_id)
        base = cast[-1][0] if cast else 0.0
        merged = list(cast)
        for ev in durable:
            t = ev[0] if ev[0] is not None else 0.0
            merged.append([round(base + float(t), 6), ev[1], ev[2]])
        return merged

    def event_restore(self, session_id: str, max_bytes: int = 4 * 1024 * 1024):
        """Return a bounded JSONL restore payload for structured chat events.

        Terminal restore is a pyte screen snapshot, which cannot reconstruct a
        structured chat timeline.  Canonical events already live in the same
        durable recording stream under ``kind == "event"``; replay their tail
        verbatim so the browser can fold it through the normal chat reducer.
        Invalid rows are ignored rather than poisoning a WebSocket attach.
        """
        if self.durable_loader is None or max_bytes <= 0:
            return ""
        rows = self._load_durable(session_id)
        kept = []
        size = 0
        for _elapsed, kind, data in reversed(rows):
            if kind != "event" or not isinstance(data, str):
                continue
            try:
                parsed = json.loads(data)
            except (TypeError, ValueError):
                continue
            if not isinstance(parsed, dict):
                continue
            encoded = json.dumps(parsed, separators=(",", ":"), ensure_ascii=False)
            row_size = len(encoded.encode("utf-8")) + 1
            if size + row_size > max_bytes:
                # The replay is a contiguous suffix. Once a valid row no
                # longer fits, older rows must not leapfrog it into the tail.
                break
            kept.append(encoded)
            size += row_size
        kept.reverse()
        return "\n".join(kept)

    def drop(self, session_id: str):
        ls = self._sessions.pop(session_id, None)
        if ls:
            try:
                ls._cast.close()
            except Exception:
                pass

    def delete(self, session_id: str):
        self.drop(session_id)
        path = DATA_DIR / f"{session_id}.cast"
        if path.resolve().parent != DATA_DIR.resolve():
            raise ValueError("Invalid session recording path")
        path.unlink(missing_ok=True)


def _read_cast_events(session_id: str) -> list:
    path = DATA_DIR / f"{session_id}.cast"
    events: list = []
    if not path.exists():
        return events
    with open(path, encoding="utf-8") as fp:
        first = True
        for line in fp:
            line = line.strip()
            if not line:
                continue
            if first:
                first = False
                continue
            try:
                t, kind, data = json.loads(line)
            except Exception:
                continue
            events.append([t, kind, data])
    return events


live_registry = LiveRegistry()


def cast_header(session_id: str, cols: int = DEFAULT_COLS,
                rows: int = DEFAULT_ROWS) -> dict:
    ls = live_registry.get(session_id)
    if ls is not None:
        return {"version": 2, "width": ls.cols, "height": ls.rows,
                "timestamp": int(ls.start_time), "env": {"TERM": "xterm-256color"}}
    path = DATA_DIR / f"{session_id}.cast"
    if path.exists():
        with open(path, encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if line:
                    try:
                        return json.loads(line)
                    except Exception:
                        break
    return {"version": 2, "width": cols, "height": rows,
            "timestamp": int(time.time()), "env": {"TERM": "xterm-256color"}}
