"""Local agent-session supervisor (``sessiond``).

The connector can run in one process or split into ``sessiond`` and a transport.
The supervisor starts, feeds, resizes, and stops terminal or structured sessions.
It buffers output while no transport is attached.

Key invariant
-------------
    Detaching or restarting the transport MUST NOT stop a local session. Sessions
    continue buffering until a server ``close`` command arrives or sessiond exits.

Each transport attachment receives a monotonically increasing generation. Output
is bound to the generation captured at enqueue time, so frames from an old
transport cannot leak into a newer attachment. Session output is appended and
fsynced to a per-user disk spool before it is eligible to send. Each frame carries
a per-process sequence number and stable process UUID and is deleted only after an
explicit transport acknowledgement.
"""
from __future__ import annotations

import asyncio
import os
from collections import deque
from uuid import UUID, uuid4

from .ipc import Channel
from .pty_session import PtySession, resolve_cmd
from .agent_session import StructuredAgentSession
from .runtime_probe import availability, probe_family
from .local_store import LocalProjectStore, default_state_root
from .native_writer import NativeWriterError, NativeWriterLease
from . import runtimes
from .spool import InMemorySpool, SpoolBase
from .integrations.deeporca.supervisor import DeepOrcaSupervisorMixin

# Pipelining bounds: how many durable output frames (and their bytes) may
# be in flight to the transport before earlier ACKs return. The disk spool is
# still the durability source of truth; this only bounds send-ahead so a slow or
# disconnected server cannot create unbounded WebSocket / memory pressure.
MAX_INFLIGHT_FRAMES = 64
MAX_INFLIGHT_BYTES = 512 * 1024


class _ContextUnavailable(ValueError):
    """Only fixed, non-secret lifecycle failures may cross the wire."""

    def __init__(self, code="context.not_found"):
        self.code = code
        super().__init__(
            "Native context is unavailable for this session and configuration. "
            "Restore the original local context or start a new session.")


class SessionSupervisor(DeepOrcaSupervisorMixin):
    """Owns every local agent session, independent of any transport."""

    def __init__(self, agents: dict[str, dict] | None = None,
                 spool: SpoolBase | None = None,
                 local_store: LocalProjectStore | None = None,
                 deeporca_store=None, deeporca_worker_factory=None,
                 native_lock_root: str | None = None):
        self.local_store = local_store
        # User-scoped, never agent/DB/cwd-scoped. Tests inject disposable roots.
        self._native_lock_root = native_lock_root or os.path.join(default_state_root(), "native-writers")
        self.agents: dict[str, dict] = {}
        self._project_migrations: dict[str, dict] = {}
        self.replace_agents(agents or {})
        # ``ptys`` is retained as a compatibility name for terminal and structured sessions.
        self.ptys: dict[tuple[str, str], PtySession | StructuredAgentSession] = {}
        self.pty_instances: dict[tuple[str, str], str] = {}
        self.pty_surfaces: dict[tuple[str, str], str] = {}
        self.pty_launch_ids: dict[tuple[str, str], object] = {}
        # Test/embedded callers may omit the local store. Production persists
        # these records in LocalProjectStore so a sessiond restart can resume.
        self._memory_native_contexts: dict[tuple[str, str], tuple[str, str | None]] = {}
        self._open_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._open_users: dict[tuple[str, str], int] = {}
        self._open_requests: dict[tuple[str, str], object] = {}
        self._open_generations: dict[tuple[str, str], tuple] = {}
        self._stopped = False
        self._close_tasks: set[asyncio.Task] = set()
        # Durable, sequence-numbered store of unacknowledged session output. Tests
        # may inject an InMemorySpool; the CLI injects a DiskSpool.
        self._spool: SpoolBase = spool if spool is not None else InMemorySpool()
        # Control frames are deliberately ephemeral: stale ready/presence/exit
        # frames must not be replayed after a supervisor restart.
        self._controls: deque[tuple[str, dict]] = deque()
        self._next_control_id = 0
        self.pending_event = asyncio.Event()
        # A frame remains queued until the transport confirms WebSocket send.
        # The IPC delivery_id carried to the transport IS the durable seq, so an
        # ACK maps exactly back to the persisted record.
        # Bounded pipelining allows multiple durable frames to be in flight
        # to the transport at once instead of one-frame-per-RTT stop-and-wait.
        # ``_inflight_ids`` maps every delivery_id currently handed to the
        # transport but not yet acknowledged (control:N ids and spool ``ord``
        # ints) to its payload byte size. A frame is never re-sent while its id
        # is in this map; on attach the map is cleared so a fresh transport
        # replays the whole backlog in order.
        self._inflight_ids: dict[int | str, int] = {}
        self._inflight_bytes = 0
        # The currently attached transport channel, or None when detached.
        self._channel: Channel | None = None
        self._init_runtime_extension(deeporca_store, deeporca_worker_factory)
        # Un-acked frames recovered from a prior run are immediately eligible.
        if self._spool.pending_records():
            self.pending_event.set()

    @property
    def pending(self) -> list[dict]:
        """Snapshot of pending frames; only delivery ACKs advance the spool."""
        return ([dict(frame) for _delivery_id, frame in self._controls]
                + [dict(frame) for _delivery_id, frame
                   in self._spool.pending_records()])

    # -- local project resolution -----------------------------------------

    def _resolve_agents(self, agents) -> dict[str, dict]:
        if isinstance(agents, dict):
            values = []
            for agent_id, value in agents.items():
                item = dict(value)
                item.setdefault("id", agent_id)
                values.append(item)
        else:
            values = list(agents)
        if self.local_store is None:
            return {agent["id"]: dict(agent) for agent in values}
        resolved, migrations = self.local_store.resolve_agents(values)
        for migration in migrations:
            self._project_migrations[migration["agent_id"]] = migration
        return resolved

    def replace_agents(self, agents) -> None:
        self.agents = self._resolve_agents(agents)
        self._schedule_runtime_reconciliation()

    def pending_project_migrations(self) -> list[dict]:
        return list(self._project_migrations.values())

    def clear_project_migrations(self, migrations: list[dict]) -> None:
        for migration in migrations:
            agent_id = migration.get("agent_id")
            if self._project_migrations.get(agent_id) == migration:
                self._project_migrations.pop(agent_id, None)

    # -- provider-owned context markers ------------------------------------

    def _recorded_context(self, agent_id: str,
                          session_id: str) -> tuple[str, str | None] | None:
        """Return ``(runtime_id, cwd)`` when this session already has context."""
        if self.local_store is not None:
            record = self.local_store.native_context(agent_id, session_id)
            return (record.runtime_id, os.path.normcase(record.cwd)
                    if record.cwd else None) if record else None
        return self._memory_native_contexts.get((agent_id, session_id))

    def _record_context(self, agent_id: str, session_id: str,
                        runtime_id: str, cwd: str | None) -> None:
        if self.local_store is not None:
            self.local_store.establish_native_context(
                agent_id, session_id, runtime_id, cwd)
        else:
            self._memory_native_contexts[(agent_id, session_id)] = (runtime_id, cwd)

    def _reserve_context(self, agent_id, session_id, runtime_id, cwd) -> None:
        if self.local_store is not None:
            self.local_store.reserve_native_context(agent_id, session_id, runtime_id, cwd)
        else:
            self._record_context(agent_id, session_id, runtime_id, cwd)

    # -- transport attach/detach ------------------------------------------

    def attach(self, channel: Channel) -> None:
        """Bind a transport channel. Existing sessions are untouched.

        Any frames buffered while detached are re-signalled so the transport's
        drain loop resends them in order.
        """
        self._channel = channel
        # A fresh transport has no memory of what the previous one sent. Clear
        # the in-flight window so drain_to replays every un-acked frame in order.
        self._inflight_ids.clear()
        self._inflight_bytes = 0
        if self.pending:
            self.pending_event.set()
        self._schedule_runtime_reconciliation()

    def detach(self) -> None:
        """Unbind the transport. Sessions keep running and buffering output."""
        self._channel = None

    @property
    def attached(self) -> bool:
        return self._channel is not None

    # -- outbound buffering ------------------------------------------------

    def emit(self, frame: dict) -> None:
        """Queue an outbound frame without blocking on WebSocket I/O.

        Session output is committed to the durable spool first. Control frames are
        kept only in memory because replaying stale lifecycle state after a
        supervisor restart would be incorrect.
        """
        if frame.get("type") == "output":
            self._spool.enqueue_output(frame)
        else:
            self._next_control_id += 1
            delivery_id = f"control:{self._next_control_id}"
            self._controls.append((delivery_id, dict(frame)))
        self.pending_event.set()

    async def drain_to(self, channel: Channel) -> None:
        """Forward buffered frames to ``channel`` with bounded pipelining.

        Instead of one-frame-per-RTT stop-and-wait, up to
        ``MAX_INFLIGHT_FRAMES`` / ``MAX_INFLIGHT_BYTES`` durable frames may be in
        flight to the transport before their ACKs return. Durable outputs carry
        their spool row ``ord`` as ``delivery_id``; ephemeral controls carry a
        process-local ``control:N`` ID. A frame is never re-sent while its id is
        already in ``_inflight_ids``; the spool stays the durability source of
        truth, so any un-acked frame replays in order on the next attach.
        """
        while True:
            sent_any = False
            # Controls take priority (lifecycle / input_ack) and are cheap.
            for delivery_id, frame in list(self._controls):
                if delivery_id in self._inflight_ids:
                    continue
                if len(self._inflight_ids) >= MAX_INFLIGHT_FRAMES:
                    break
                self._inflight_ids[delivery_id] = 0
                await channel.send({
                    "type": "ipc_delivery",
                    "delivery_id": delivery_id,
                    "frame": frame,
                })
                sent_any = True
            # Durable outputs, strictly in global ``ord`` order.
            for delivery_id, frame in self._spool.pending_records():
                if delivery_id in self._inflight_ids:
                    continue
                size = len(str(frame.get("data", "")))
                if self._inflight_ids and (
                    len(self._inflight_ids) >= MAX_INFLIGHT_FRAMES
                    or self._inflight_bytes + size > MAX_INFLIGHT_BYTES
                ):
                    # Window full: stop scanning; an ACK will free room and
                    # re-set pending_event so we resume from the same tail.
                    break
                self._inflight_ids[delivery_id] = size
                self._inflight_bytes += size
                await channel.send({
                    "type": "ipc_delivery",
                    "delivery_id": delivery_id,
                    "frame": frame,
                })
                sent_any = True
            if sent_any:
                # More rows may now fit (or new frames arrived); re-scan.
                continue
            self.pending_event.clear()
            if self._has_sendable():
                continue
            await self.pending_event.wait()

    def _has_sendable(self) -> bool:
        """True if any pending frame is not yet in the in-flight window."""
        if len(self._inflight_ids) >= MAX_INFLIGHT_FRAMES:
            return False
        for delivery_id, _ in self._controls:
            if delivery_id not in self._inflight_ids:
                return True
        for delivery_id, _ in self._spool.pending_records():
            if delivery_id not in self._inflight_ids:
                return True
        return False

    def _release_inflight(self, delivery_id) -> None:
        """Drop one delivery_id from the window and re-arm the sender."""
        size = self._inflight_ids.pop(delivery_id, None)
        if size:
            self._inflight_bytes -= size
        self.pending_event.set()

    def _reconcile_inflight_after_fence(self) -> None:
        """Drop in-flight ids whose durable or control frame was purged."""
        valid_durable = {ordv for ordv, _ in self._spool.pending_records()}
        valid_controls = {delivery_id for delivery_id, _ in self._controls}
        for delivery_id in list(self._inflight_ids):
            if isinstance(delivery_id, str) and delivery_id.startswith("control:"):
                valid = delivery_id in valid_controls
            else:
                valid = delivery_id in valid_durable
            if not valid:
                size = self._inflight_ids.pop(delivery_id, 0)
                if size:
                    self._inflight_bytes -= size


    # -- control handling --------------------------------------------------

    async def handle_control(self, frame: dict) -> None:
        """Apply one control frame received from a transport."""
        t = frame.get("type")
        if t == "ipc_delivery_ack":
            self._apply_ack(frame.get("delivery_id"))
            return
        if t == "fence":
            # The server ruled this pty_instance's durable output stream forked.
            # Purge its spool tail so the single-inflight delivery loop stops
            # retrying poison rows, and release any inflight delivery that was
            # waiting on one of the purged rows so newer output can drain.
            sid_f = frame.get("session_id")
            pid_f = frame.get("pty_instance_id")
            if sid_f and pid_f:
                self._spool.fence(sid_f, pid_f)
                # Drop any in-flight durable ids the fence just purged so the
                # window frees up and newer output can drain.
                self._reconcile_inflight_after_fence()
                self.pending_event.set()
            return
        if t == "agents":
            # Hot directory refresh pushed after mutations and every transport
            # connect. Keep the same id -> config shape populated by /api/me.
            # Invalid payloads are ignored so a malformed frame cannot erase
            # the directory. Sessions belonging to a deleted agent are stopped
            # locally as part of authoritative directory reconciliation.
            agents = frame.get("agents")
            if not isinstance(agents, list):
                return
            # The directory is authoritative, so an empty list intentionally
            # removes every agent. Reject a partly malformed list as a whole,
            # though, rather than interpreting bad input as mass deletion.
            if any(not isinstance(agent, dict)
                   or not isinstance(agent.get("id"), str)
                   or not agent["id"].strip()
                   for agent in agents):
                return
            updated = self._resolve_agents(agents)
            removed_agent_ids = (set(self.agents) | self._runtime_bound_agent_ids()) - set(updated)
            self.agents = updated
            if removed_agent_ids:
                for removed_agent_id in removed_agent_ids:
                    await self._retire_runtime_agent(removed_agent_id)
                for key in list(self._open_locks):
                    if key[0] in removed_agent_ids:
                        self._invalidate_open(key)
                removed_streams: set[tuple[str, str]] = set()
                for _delivery_id, pending in self._spool.pending_records():
                    session_id = pending.get("session_id")
                    pty_instance_id = pending.get("pty_instance_id")
                    if (pending.get("agent_id") in removed_agent_ids
                            and isinstance(session_id, str)
                            and isinstance(pty_instance_id, str)):
                        removed_streams.add((session_id, pty_instance_id))
                for key, pty_instance_id in self.pty_instances.items():
                    if key[0] in removed_agent_ids:
                        removed_streams.add((key[1], pty_instance_id))
                for session_id, pty_instance_id in removed_streams:
                    self._spool.fence(session_id, pty_instance_id)
                self._controls = deque(
                    (delivery_id, pending)
                    for delivery_id, pending in self._controls
                    if pending.get("agent_id") not in removed_agent_ids
                )
                self._reconcile_inflight_after_fence()
                for key, pty in list(self.ptys.items()):
                    if key[0] in removed_agent_ids:
                        try:
                            self._stop_session(pty)
                        except Exception:
                            pass
                        self.ptys.pop(key, None)
                        self.pty_instances.pop(key, None)
                        self.pty_surfaces.pop(key, None)
                        self.pty_launch_ids.pop(key, None)
                # Inventory omission must not erase native history. Re-adding
                # an agent must not turn an old ID into a create request.
            self._schedule_runtime_reconciliation()
            return
        aid = frame.get("agent_id")
        sid = frame.get("session_id")
        key = (aid, sid)
        if t in {"input", "interrupt", "resize", "permission", "close", "terminate"}:
            pending = self._open_generations.get(key)
            active = self.pty_launch_ids.get(key)
            target = pending[0] if pending is not None else active
            # Missing/None tokens are compatible only with tokenless legacy
            # sessions. Never let a delayed control cross a Resume generation.
            if frame.get("launch_id") != target:
                return
            if t in {"input", "interrupt", "resize", "permission"} and target != active:
                return  # The pending generation does not own the live child yet.
        if t == "input":
            try:
                client_input_id = str(UUID(str(frame.get("client_input_id"))))
            except (TypeError, ValueError, AttributeError):
                return
            frame = {**frame, "client_input_id": client_input_id}
        if await self._handle_runtime_control(frame):
            return
        if t in {"open", "resume"}:
            await self.open_pty(
                aid, sid, frame.get("cols", 120), frame.get("rows", 30),
                surface=frame.get("surface"), launch_id=frame.get("launch_id"),
                resume=t == "resume")
        elif t == "input":
            p = self.ptys.get((aid, sid))
            if p:
                reason = None
                if not p.is_alive():
                    reason = "runtime_not_running"
                elif not isinstance(frame.get("data", ""), str):
                    reason = "invalid_input"
                elif (callable(getattr(p, "can_accept_turn", None))
                      and not p.can_accept_turn()):
                    p.write_turn(frame.get("data", ""), frame.get("options"))
                    reason = "turn_queue_full"
                if reason:
                    # Do not record a delivery receipt for rejected input.
                    # Retrying its id after capacity returns must still work.
                    self.emit({
                        "type": "input_ack", "agent_id": aid,
                        "session_id": sid, "client_input_id": client_input_id,
                        "status": "rejected", "reason": reason,
                        "launch_id": frame.get("launch_id"),
                    })
                    return
                first_delivery = self._spool.record_input_once(client_input_id)
                if first_delivery:
                    writer = getattr(p, "write_turn", None)
                    if callable(writer):
                        writer(frame.get("data", ""), frame.get("options"))
                    else:
                        p.write(frame.get("data", ""))
                self.emit({
                    "type": "input_ack",
                    "agent_id": aid,
                    "session_id": sid,
                    "client_input_id": client_input_id,
                    "status": "delivered",
                    "launch_id": frame.get("launch_id"),
                })
        elif t == "interrupt":
            p = self.ptys.get((aid, sid))
            if p is not None:
                p.write("\x03")
        elif t == "resize":
            p = self.ptys.get((aid, sid))
            if p:
                p.resize(frame.get("cols", 80), frame.get("rows", 24))
        elif t == "permission":
            # Answer a pending permission.ask for a structured agent. Idempotent
            # and best-effort: only structured sessions expose this method.
            p = self.ptys.get((aid, sid))
            if p is not None and hasattr(p, "respond_permission"):
                p.respond_permission(str(frame.get("request_id", "")),
                                     bool(frame.get("allow")))
        elif t in ("close", "terminate"):
            self._invalidate_open(key)
            p = self.ptys.pop(key, None)
            if p:
                self._stop_session(p)
            self.pty_instances.pop(key, None)
            self.pty_surfaces.pop(key, None)
            self.pty_launch_ids.pop(key, None)
        elif t == "list_sessions":
            self.emit(self.sessions_frame())

    def _apply_ack(self, delivery_id) -> None:
        """Advance the exact acknowledged control or durable output row.

        With bounded pipelining several ids are in flight at once, so the ACK
        need not match a single gate; it must match an id we actually sent
        (present in ``_inflight_ids``). Spool advancement stays strict and
        per-stream contiguous — ``spool.ack`` only removes the row when its seq
        is the smallest AND ``last_acked + 1`` — so a stale or out-of-order ACK
        can never delete the wrong row.
        """
        if delivery_id is None or delivery_id not in self._inflight_ids:
            return
        if isinstance(delivery_id, str) and delivery_id.startswith("control:"):
            # Controls ACK in order; only release when it is the head control.
            if not self._controls or self._controls[0][0] != delivery_id:
                return
            self._controls.popleft()
            self._release_inflight(delivery_id)
            return
        # Durable output: let the spool enforce contiguity. It returns False if
        # this ord is not the next deletable row, leaving the spool untouched.
        if self._spool.ack(delivery_id):
            self._release_inflight(delivery_id)

    def sessions_frame(self) -> dict:
        return {
            "type": "sessions",
            "sessions": [{
                "agent_id": aid,
                "session_id": sid,
                "pty_instance_id": self.pty_instances[(aid, sid)],
                "surface": self.pty_surfaces.get((aid, sid), "terminal"),
                "launch_id": self.pty_launch_ids.get((aid, sid)),
            } for aid, sid in self.ptys.keys()],
        }

    async def open_pty(self, agent_id: str, session_id: str,
                       cols: int = 120, rows: int = 30,
                       surface: str | None = None, launch_id=None,
                       *, resume: bool = False) -> None:
        if self._stopped or agent_id not in self.agents:
            return
        key = (agent_id, session_id)
        pending = self._open_generations.get(key)
        if launch_id is None and (self.pty_launch_ids.get(key) is not None
                                  or (pending is not None and pending[0] is not None)):
            # An old tokenless reconnect must not downgrade an already modern
            # live/pending session and enable legacy controls against it.
            return
        lock = self._open_locks.setdefault(key, asyncio.Lock())
        self._open_users[key] = self._open_users.get(key, 0) + 1
        generation = (launch_id, resume)
        if self._open_generations.get(key) != generation:
            self._open_generations[key] = generation
            self._open_requests[key] = object()
        request = self._open_requests[key]

        def current():
            return (not self._stopped and agent_id in self.agents
                    and self._open_locks.get(key) is lock
                    and self._open_requests.get(key) is request)

        def emit(frame):
            if current():
                self.emit({**frame, "launch_id": launch_id})

        try:
            async with lock:
                if not current():
                    return
                try:
                    await self._open_pty(
                        agent_id, session_id, cols, rows, surface, current,
                        emit, launch_id, resume)
                except (_ContextUnavailable, NativeWriterError) as exc:
                    emit({"type": "runtime.unavailable", "agent_id": agent_id,
                          "session_id": session_id, "surface": surface,
                          "code": exc.code, "message": str(exc)})
                except Exception:
                    # Exceptions can contain executable paths, argv, environment
                    # values or provider credentials. Never forward their text.
                    if current():
                        emit({
                            "type": "runtime.unavailable",
                            "agent_id": agent_id,
                            "session_id": session_id,
                            "code": "spawn_failed",
                            "surface": surface,
                            "message": (
                                "Could not start the runtime. Check that the CLI "
                                "is installed, executable and authenticated, and "
                                "that the local workspace is accessible, then retry."),
                        })
        finally:
            if self._open_locks.get(key) is lock:
                self._open_users[key] -= 1
                if not self._open_users[key]:
                    self._invalidate_open(key)

    def _invalidate_open(self, key) -> None:
        # In-flight callers retain the old lock, but may no longer launch or
        # register a child after close, retirement or shutdown (even on re-add).
        self._open_locks.pop(key, None)
        self._open_users.pop(key, None)
        self._open_requests.pop(key, None)
        self._open_generations.pop(key, None)

    async def _open_pty(self, agent_id, session_id, cols, rows, surface,
                        current, emit, launch_id, resume) -> None:
        key = (agent_id, session_id)
        existing = self.ptys.get(key)
        if existing and existing.is_alive():
            confirmed = self.pty_surfaces.get(key, "terminal")
            if surface and surface != confirmed:
                emit({
                    "type": "runtime.unavailable",
                    "agent_id": agent_id,
                    "session_id": session_id,
                    "code": "surface_mismatch",
                    "surface": surface,
                    "available_surfaces": [confirmed],
                })
                return
            if resume:
                if (confirmed != "structured"
                        or not isinstance(existing, StructuredAgentSession)
                        or existing._context_preparing is None
                        or existing._writer_lease_factory is None):
                    raise _ContextUnavailable()
                existing.require_existing_context = True
                existing.prepare_context()
            self.pty_launch_ids[key] = launch_id
            emit({"type": "ready", "agent_id": agent_id,
                       "session_id": session_id,
                       "pty_instance_id": self.pty_instances[key],
                       "surface": confirmed,
                       "structured": confirmed == "structured",
                       **({"context_resume": "pending"} if resume else {})})
            return
        if existing:
            # A child can stop outside the supervisor while its reader is blocked.
            # Do not advertise that stale handle as ready.
            self.ptys.pop(key, None)
            self.pty_instances.pop(key, None)
            self.pty_surfaces.pop(key, None)
            self.pty_launch_ids.pop(key, None)
            try:
                self._stop_session(existing)
                waiter = getattr(existing, "wait_closed", None)
                if waiter is not None:
                    await waiter()
            except Exception:
                pass
            if not current():
                return
        pty_instance_id = str(uuid4())
        info = self.agents.get(agent_id)
        if not info:
            return
        if info.get("project_error"):
            emit({
                "type": "runtime.unavailable",
                "agent_id": agent_id,
                "session_id": session_id,
                "runtime": info.get("runtime") or "",
                "code": "project_unavailable",
                "message": "Local project is unavailable. Restore or rebind the workspace, then retry.",
            })
            return
        info = dict(info)  # snapshot across asynchronous availability probing
        configured_runtime = info.get("runtime")
        try:
            if surface:
                if configured_runtime in runtimes.runtime_ids():
                    family = runtimes.get(configured_runtime).family_id
                else:
                    family = configured_runtime
                adapter = runtimes.get_for_surface(family, surface)
            elif configured_runtime in runtimes.runtime_ids():
                # Compatibility for old agents/browsers during the rolling
                # migration: an exact legacy adapter id keeps its old surface.
                adapter = runtimes.get(configured_runtime)
            else:
                candidates = [item for item in runtimes.all_adapters()
                              if item.family_id == configured_runtime]
                adapter = next((item for item in candidates
                                if item.default_surface), candidates[0])
        except (runtimes.UnknownRuntimeError, IndexError):
            if resume:
                raise _ContextUnavailable() from None
            emit({
                "type": "runtime.unavailable",
                "agent_id": agent_id,
                "session_id": session_id,
                "code": "surface_unavailable",
                "runtime": configured_runtime,
                "surface": surface,
                "message": "This runtime does not support the requested surface. Choose an available runtime and surface.",
            })
            return
        runtime_id = adapter.id
        confirmed_surface = adapter.surface_id
        if resume and (not adapter.structured or adapter.context_control is None):
            raise _ContextUnavailable()

        # The server-side capability blob is a cached self-report, not an auth
        # gate. Re-probe installation/auth/compatibility immediately before every
        # spawn and return a structured, non-secret failure when unavailable.
        capability = await asyncio.to_thread(
            probe_family, adapter.family_id, include_models=False)
        if not current():
            return
        if self.agents.get(agent_id) != info:
            emit({"type": "runtime.unavailable", "agent_id": agent_id,
                       "session_id": session_id, "code": "configuration_changed",
                       "message": "Agent configuration changed during startup. Retry."})
            return
        can_spawn, reason = availability(capability, confirmed_surface)
        if not can_spawn:
            emit({
                "type": "runtime.unavailable",
                "agent_id": agent_id,
                "session_id": session_id,
                "code": reason,
                "runtime": adapter.family_id,
                "surface": confirmed_surface,
                "installation": capability["installation"]["status"],
                "compatibility": capability["compatibility"]["status"],
                "authentication": capability["authentication"]["status"],
            })
            return
        if await self._open_runtime_session(
                adapter, agent_id, session_id, confirmed_surface, pty_instance_id,
                current, launch_id=launch_id):
            return
        runtime_config = (info.get("runtime_config")
                          if isinstance(info.get("runtime_config"), dict)
                          else {})
        cmd = resolve_cmd(
            runtime_id, info.get("launch_cmd"),
            model=runtime_config.get("model", info.get("model")),
            permission_mode=runtime_config.get(
                "permission_mode", info.get("permission_mode")))
        structured = adapter.structured

        async def on_output(data: str):
            if self._stopped or agent_id not in self.agents:
                return
            if self.ptys.get(key) is not p and not current():
                return
            frame = {"type": "output", "agent_id": agent_id,
                     "session_id": session_id,
                     "pty_instance_id": pty_instance_id,
                     "data": data}
            if structured:
                # Canonical event stream (not terminal bytes). The server
                # persists/fans this out unchanged; the browser renders chat.
                frame["kind"] = "event"
            self.emit(frame)

        async def on_exit(code: int):
            # A stale reader may finish after open_pty has replaced its dead session.
            # Only the currently registered instance may close the server session.
            if self.ptys.get(key) is not p:
                return
            self.ptys.pop(key, None)
            exit_launch_id = self.pty_launch_ids.pop(key, None)
            self.emit({"type": "exit", "agent_id": agent_id,
                       "session_id": session_id,
                       "pty_instance_id": pty_instance_id,
                       "code": code, "launch_id": exit_launch_id})
            self.pty_instances.pop(key, None)
            self.pty_surfaces.pop(key, None)

        if structured:
            attachment = runtimes.attachment_control(runtime_id)
            context_control = adapter.context_control
            effective_cwd = os.path.normcase(os.path.realpath(os.path.abspath(
                info.get("cwd") or os.getcwd())))
            recorded = None
            resume_context = False
            context_error = None

            def refresh_context(*, strict=False) -> None:
                nonlocal recorded, resume_context, context_error
                if strict:
                    if self.local_store is None:
                        raise _ContextUnavailable()
                    try:
                        marker = self.local_store.native_context(agent_id, session_id)
                    except Exception:
                        raise _ContextUnavailable() from None
                    if (marker is None or marker.state not in {"attempted", "established"}
                            or marker.cwd is None):
                        raise _ContextUnavailable()
                    try:
                        recorded_adapter = runtimes.get(marker.runtime_id)
                    except runtimes.UnknownRuntimeError:
                        raise _ContextUnavailable() from None
                    if not recorded_adapter.structured or recorded_adapter.context_control is None:
                        raise _ContextUnavailable()
                    recorded = (marker.runtime_id, os.path.normcase(os.path.realpath(os.path.abspath(marker.cwd))))
                else:
                    recorded = self._recorded_context(agent_id, session_id)
                resume_context = recorded is not None
                context_error = None
                if recorded is not None and recorded[0] != runtime_id:
                    if strict:
                        raise _ContextUnavailable("context.runtime_mismatch")
                    context_error = (
                        "This session's agent runtime changed, so its earlier context "
                        "cannot be resumed. Start a new session.")
                elif (recorded is not None and context_control.resume_scope == "cwd"
                      and recorded[1] != effective_cwd):
                    if strict:
                        raise _ContextUnavailable("context.cwd_mismatch")
                    context_error = (
                        "This session's local project changed, so its earlier context "
                        "cannot be resumed. Restore the original project or start a new session.")

            if context_control is not None and not resume:
                refresh_context()

            def prepare_context() -> None:
                # Called only while holding native writer ownership. Open-time
                # state alone cannot decide between create and resume.
                refresh_context(strict=getattr(p, "require_existing_context", resume))
                if context_error:
                    raise ValueError(context_error)
                if self._stopped or self.agents.get(agent_id) != info:
                    if getattr(p, "require_existing_context", resume):
                        raise _ContextUnavailable("configuration_changed")
                    raise ValueError("Agent configuration changed. Reopen the session before sending.")
                if recorded is None:
                    try:
                        self._reserve_context(agent_id, session_id, runtime_id, effective_cwd)
                    except Exception:
                        raise ValueError(
                            "Could not reserve native conversation state. No agent process was started.") from None

            async def context_started() -> None:
                nonlocal resume_context
                # Strict resumes may update an existing marker, never create one.
                if getattr(p, "require_existing_context", resume):
                    refresh_context(strict=True)
                # Machine-scoped recovery preserves the original binding marker.
                self._record_context(
                    agent_id, session_id, runtime_id,
                    recorded[1] if recorded is not None else effective_cwd)
                resume_context = True

            def sanitize_options(value):
                merged = dict(runtime_config)
                if isinstance(value, dict):
                    merged.update(value)
                return runtimes.sanitize_options(runtime_id, merged)

            def build_turn_command(options, attachment_paths):
                if context_error is not None:
                    raise ValueError(context_error)
                model = (options.get("model") or runtime_config.get("model")
                         or info.get("model"))
                base = resolve_cmd(
                    runtime_id, info.get("launch_cmd"), model=model,
                    permission_mode=(options.get("permission_mode")
                                     or info.get("permission_mode")))
                return base + runtimes.control_argv(
                    runtime_id, options, attachment_paths,
                    session_id=session_id if context_control is not None else None,
                    resume_context=resume_context)

            from .agent_session import TRANSLATORS
            p = StructuredAgentSession(
                cmd, effective_cwd if context_control else info.get("cwd"),
                on_output, on_exit, cols=cols, rows=rows,
                translate=TRANSLATORS.get(runtime_id),
                per_turn=adapter.per_turn,
                prompt_argv=list(adapter.prompt_argv),
                lazy_start=True,
                command_builder=build_turn_command,
                option_sanitizer=sanitize_options,
                attachment_key=attachment.key if attachment else None,
                attachment_mode=("flag" if attachment and attachment.flag
                                 else "prompt" if attachment else None),
                attachment_max_files=attachment.max_files if attachment else 0,
                attachment_max_bytes=(attachment.max_total_bytes
                                      if attachment else 0),
                session_option_keys=tuple(
                    (["model"] if adapter.model_scope == "session" else []) +
                    [control.key for control in adapter.controls
                     if control.scope == "session"]),
                live_control_builder=(
                    (lambda previous, current: runtimes.live_control_requests(
                        adapter.id, previous, current))
                    if adapter.live_controls else None),
                context_started=(context_started if context_control else None),
                context_preparing=(prepare_context if context_control else None),
                writer_lease_factory=(lambda: NativeWriterLease(
                    self._native_lock_root, adapter.family_id, session_id)) if context_control else None,
                require_existing_context=resume)
        else:
            p = PtySession(cmd, info.get("cwd"), on_output, on_exit,
                           cols=cols, rows=rows)
        try:
            if resume:
                p.prepare_context()
            await p.start()
            if not current():
                return
            if not p.is_alive():
                raise RuntimeError("Runtime exited during startup")
            self.ptys[key] = p
            self.pty_instances[key] = pty_instance_id
            self.pty_surfaces[key] = confirmed_surface
            self.pty_launch_ids[key] = launch_id
        finally:
            if self.ptys.get(key) is not p:
                # start() can raise or be cancelled after creating a child.
                try:
                    self._stop_session(p)
                    waiter = getattr(p, "wait_closed", None)
                    if waiter is not None:
                        await waiter()
                except Exception:
                    pass
        emit({"type": "ready", "agent_id": agent_id,
                   "session_id": session_id,
                   "pty_instance_id": pty_instance_id,
                   "surface": confirmed_surface,
                   "structured": structured,
                   **({"context_resume": "pending"} if resume else {})})
        self.emit({"type": "presence", "agent_id": agent_id, "state": "online"})

    def status(self) -> dict:
        """Machine-readable supervisor status for CLI/doctor surfaces."""
        spool_status = self._spool.status()
        return {
            "attached": self.attached,
            "sessions": [{
                "agent_id": aid,
                "session_id": sid,
                "pty_instance_id": self.pty_instances[(aid, sid)],
                "surface": self.pty_surfaces.get((aid, sid), "terminal"),
                "launch_id": self.pty_launch_ids.get((aid, sid)),
            } for aid, sid in self.ptys.keys()],
            **spool_status,
        }

    async def aclose(self) -> None:
        """Settle extension sessions before closing the durable spool."""
        await self._close_runtime_sessions()
        self.shutdown()
        await self.wait_closed()
        self._close_runtime_storage()

    def _stop_session(self, session) -> None:
        session.kill()
        waiter = getattr(session, "wait_closed", None)
        if waiter is not None:
            task = asyncio.create_task(waiter())
            self._close_tasks.add(task)
            task.add_done_callback(self._close_tasks.discard)

    async def wait_closed(self) -> None:
        """Drain reapers before closing the event loop or local SQLite store."""
        while self._close_tasks:
            await asyncio.gather(*tuple(self._close_tasks), return_exceptions=True)

    def shutdown(self) -> None:
        """Stop all sessions on supervisor exit. Never called on detach."""
        if self._stopped:
            return
        self._stopped = True
        self._open_locks.clear()
        self._open_users.clear()
        self._open_requests.clear()
        self._open_generations.clear()
        sessions = list(self.ptys.values())
        self.ptys.clear()
        self.pty_instances.clear()
        self.pty_surfaces.clear()
        self.pty_launch_ids.clear()
        for p in sessions:
            try:
                self._stop_session(p)
            except Exception:
                pass
        self._spool.close()
