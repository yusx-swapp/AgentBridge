# Session Persistence

This document describes how AgentBridge keeps agent sessions alive across disconnects,
how it records them for replay, and where every piece of state actually lives.
It reflects the current implementation; see
[`implementation.md`](implementation.md) for the wider architecture.

The repository/installer rename does not rename state, authentication, database,
spool or IPC identifiers. Fresh installation homes use `~/.agentbridge`; existing
`.deepbox` installations are reused for compatibility without automatic migration.
See [the repository/installation contract](agentbridge.md).

## 1. What persistence buys us

A local terminal session dies with its window. AgentBridge separates the session's
*execution*, its *durable record*, and its *viewers* so that:

- The agent process lives on the connector (the user's own machine) and keeps
  running when the browser tab closes.
- The server keeps a durable, replayable record of the session.
- A browser can detach and re-attach — from another tab, device, or after a
  network drop — and immediately see the current screen (terminal) or the
  reconstructed timeline (structured chat).

The design distinguishes two needs:

1. **"What does the screen look like now?"** — needed on re-attach. Handled by a
   headless terminal emulator (pyte) on the server that keeps the current screen
   state and serializes a small redraw. Bounded by screen size, independent of
   session length.
2. **"What happened over the whole session?"** — needed for replay/audit.
   Handled by durable recording rows in the server database, exportable as
   asciicast v2 or as an events/checkpoints replay stream.

The recording-only screen ignores standard and DEC-private device-status queries
(DSR), including split sequences, without generating terminal input. This avoids
pyte 0.8.2's unsupported `private` argument during live output or replay. Original
terminal bytes still reach the browser and durable recording unchanged.

## 2. Ownership: who stores what

| State | Owner | Storage |
|---|---|---|
| Live agent process (PTY or structured CLI) | Connector | In-memory / OS process |
| Un-acknowledged output frames | Connector | Local SQLite spool (`connector/spool.py`) |
| Input dedup receipts | Connector | Same spool (`input_receipts` table) |
| Local project metadata, skills | Connector | Local SQLite state DB (`connector/local_store.py`) |
| Users, workspaces, devboxes, agents, sessions | Server | Server SQLite (`server/app/models.py`) |
| Durable recording frames + checkpoints | Server | Server SQLite (`recording_frame`, `recording_checkpoint`) |
| Current terminal screen / structured tail | Server | In-memory live registry (rebuilt from durable rows) |

Model intelligence and API keys never leave the connector machine. The server
stores terminal bytes / canonical event JSON and non-secret metadata only; it
never holds model credentials.

`session.surface` is an additive nullable column. New explicit choices are stored;
validated ready/snapshot frames establish the resolved `terminal` or `structured`
surface. Existing rows are not guessed from runtime names. Attaching or reconnecting
does not silently switch a known surface, and the browser never reuses an unknown
legacy session for an explicit Terminal choice.

`Session.title` is display metadata only: Rename uses an expected-title
compare-and-swap and never changes the session/agent/native ID or local marker.
New session IDs are canonical UUID strings; existing IDs stay unchanged.
`Session.launch_id` is one durable, opaque lifecycle token, not a native-context
handle or a process-reaping receipt. It fences controls/ready/exit/snapshots across
initial launch, explicit Resume, and logical End; stale snapshot entries cannot
downgrade a newer active generation. See [the lifecycle contract](design.md#55-restore-and-reconnect).

## 3. Connector-side persistence

### 3.1 Durable output spool (`connector/spool.py`)

Output frames are made durable *before* they are sent. `DiskSpool` uses the
standard-library `sqlite3` module in WAL mode with `synchronous=FULL`, so a
committed row survives power loss. Three tables:

- **`outbox`** — one row per emitted output/event frame that has not yet been
  acknowledged. The per-`(session_id, pty_instance_id)` sequence number (`seq`)
  is assigned inside the same `BEGIN IMMEDIATE` transaction that inserts the row,
  as `max(last_acked_seq, max(existing outbox seq)) + 1`. It is always positive,
  monotonic per stream, and never reused across ACK or restart. A separate
  autoincrementing `ord` column records global insertion order so pending frames
  replay in exactly the order emitted, even across interleaved sessions.
- **`ack_state`** — the high-water `last_acked_seq` per
  `(session_id, pty_instance_id)`. ACK is strict, contiguous FIFO: only the
  current smallest pending seq — which must equal `last_acked_seq + 1` — can
  advance. Any stale, future, or unknown seq is rejected without mutating state.
- **`input_receipts`** — deduplication ledger for inbound `client_input_id`
  values so a given input is applied at most once, even across a restart.

Server-side pending input is recorded only after `input_ack(status="delivered")`.
`status="rejected"` clears the pending input without recording it; an unknown status
is not treated as delivery. The connector's `TransportSession` is the only sender
path; the obsolete sender facade and its duplicate queue view have been removed.

Frames are serialized as canonical compact JSON with the assigned `seq` injected
before serialization, so the persisted payload is exactly what is emitted.

**Isolation and secrecy.** `spool_namespace()` derives a deterministic, opaque
directory/file identity from the canonicalized server URL plus a SHA-256 of the
token. The raw token is never written. Different URLs or tokens map to different
databases; equivalent URLs canonicalize to the same one.

**Ownership.** Exactly one live process may own a spool. A sibling lock file is
acquired non-blocking (`fcntl` on POSIX, `msvcrt` on Windows); a second opener
raises `SpoolInUseError`.

**Failure handling.** A file that is not a valid SQLite database raises
`SpoolCorruptionError` rather than being silently reset (fail-closed).

The disk spool is only opened in real CLI mode via `open_spool(server_url,
token)`. A plain `SessionSupervisor(...)` / `Connector(...)` constructed in tests
or as a library defaults to an in-memory spool and creates no spool files.
Native conversation launches independently acquire the on-disk guard in §3.3;
tests must inject a disposable `native_lock_root` for those launches.

### 3.2 Local project and skill state (`connector/local_store.py`)

`LocalProjectStore` uses a connector-state SQLite database (`state.db`). The
state root is `%LOCALAPPDATA%/deepbox` on Windows and
`${XDG_STATE_HOME:-~/.local/state}/deepbox` on macOS/Linux. The DB is opened
with WAL, `synchronous=FULL`, and a 5-second `busy_timeout`; cross-process
mutations are serialized with a sibling `.lock` file, and on Unix the directory
and DB are created `0700`/`0600` where possible.

- `local_project(id, name, path, created_at, updated_at)` — project paths are
  canonicalized and de-duplicated locally. Only `{id, name}` (plus a legacy
  migration mapping) is reported to the server; **paths never leave the
  connector.**
- `local_skill` — records local source/store/binding paths. Skill content lives
  only on the connector; the server keeps at most a sanitized inventory and
  never receives paths.
- `native_context(agent_id, session_id, runtime_id, cwd, established_at,
  updated_at, state)` — an `attempted` reservation precedes first spawn;
  `established_at` is empty until a successful turn promotes it to `established`.
  Old rows migrate as established. Both states require resume on later launches,
  never silent recreation. The table stores no prompts/replies/provider event
  IDs. `cwd` is machine-private, including the effective inherited cwd, and is
  checked for directory-scoped recovery. Original bindings are immutable and
  retained when agents disappear from an inventory; omission is not deletion of
  native history. `BEGIN IMMEDIATE` makes reservation conflicts atomic.

Explicit Resume requires this existing marker under native-writer ownership,
before logical ready and again before each spawn. The `attempted`/`established`
states and runtime/cwd bindings are unchanged. A marker is not proof that the
provider's transcript still exists: a lazy/per-turn resume may discover its loss
only on the next real message. Server recordings restore a view, never reconstruct
a provider prompt/history or authorize a replacement conversation. Missing or
unreadable markers fail visibly with safe guidance, without local path/error text.

### 3.3 Native conversation writer ownership (`connector/native_writer.py`)

The shared user-state `native-writers/` directory contains one stable hashed lock
file per runtime-family/session pair. It is independent of the connector DB,
agent binding, project path, server URL, and transport. Files are never unlinked:
replacing their inode could split ownership. Windows uses a non-blocking byte
lock, POSIX `flock`; tests inject disposable roots. Creating an embedded supervisor
alone does not write a guard, but starting a native conversation does.

An active JSON journal (random owner, supervisor PID, start timestamp; no prompt,
path, credential, or transcript) is flushed before spawn. A known-reaped child
clears it; OS lock release alone does not. A crash during a turn can leave a child
alive, so neither elapsed time nor a dead supervisor PID permits takeover. A
malformed journal fails closed. Retention of output recordings does not erase
these local guards or the provider's transcripts.

After **personally confirming the previous CLI and any transcript writers have
stopped**, inspect and release an abandoned guard on that same machine:

```text
agentbridge context status claude-code <session-id>
agentbridge context release claude-code <session-id> --owner <owner-from-status> --confirm-writer-stopped
```

Use `copilot-cli` for that family. These commands make no network requests and do
not start/resume/delete a conversation. The exact-owner check prevents a stale
operator command from clearing a newer journal; release never breaks a live OS
lock. The confirmation is a user assertion, not a process-tree safety proof. Do
not delete lock files or clear a guard merely because its supervisor PID is gone.
Malformed journals require investigation or a new session, not an automatic reset.
Only cooperating updated connectors using this shared state root are covered;
manual/older CLI launchers and separate OS users/machines are outside the lock.

## 4. Server-side persistence (`server/app/`)

### 4.1 Schema and engine (`models.py`)

SQLAlchemy Core models cover users, organizations, workspaces/memberships,
workspace invitations, devboxes, agents, sessions, participants, keyboard
leases, recording frames/checkpoints, structured messages, tasks, and path-free
local-project metadata.

For SQLite URLs, `init_db()` registers a per-connection PRAGMA listener setting
`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`,
and `wal_autocheckpoint=1000`. On a networked disk (for example Azure App
Service `/home`), the SQLite default (`journal_mode=DELETE` +
`synchronous=FULL`) forces multiple fsync round-trips per commit; WAL collapses
each commit into a single sequential append and defers sync to checkpoint. This
remains crash-safe: under WAL + `NORMAL` only the last few committed
transactions may be lost on power loss, and those frames are re-sent from the
connector's durable spool on reconnect, so nothing is permanently lost.
`tests/test_db_pragmas.py` asserts the PRAGMAs actually take effect.

### 4.2 Recording model (`recording.py`)

Durable recording lives in two tables:

- **`recording_frame(session_id, pty_instance_id, seq, kind, data, payload_hash,
  elapsed, timestamp, redacted_at, ...)`** — one row per output/event frame.
  `kind="output"` carries terminal bytes; `kind="event"` carries a canonical
  event JSON object. The `(session_id, pty_instance_id, seq)` identity plus
  `payload_hash` is the Protocol v3 dedup ledger.
- **`recording_checkpoint`** — periodic full terminal-screen snapshots that bound
  how much output must be replayed to seek to a point in time.

Stored sequences are contiguous per PTY, so the frontier uses indexed `MAX(seq)`.
Checkpoint ordinals count all session frames, including redacted ones, starting
from an earlier checkpoint with a positive `event_index`. If none exists, the
ordinal is counted from the start.

Persistence is split into a pure in-memory `classify_output()` (reads the ledger
and returns NEW / DUPLICATE / GAP / CONFLICT / INVALID, building an uncommitted
`RecordingFrame` for NEW) and a durable `commit_new()` (`db.add` + `db.commit`,
which is the ACK boundary). This lets the server broadcast a current NEW frame
to browsers before the disk commit completes, then commit and only then ACK the
connector. For generation-fenced structured sessions, delayed old-instance output
is still committed/ACKed but is not fanned into the new live conversation. The
launch token does not replace the durable stream identity or reset its ledger.

Structured re-attach uses `LiveRegistry.event_restore()`, which selects the most
recent complete `kind="event"` rows up to 4 MiB, reconstructs original order into
JSONL, and hands the browser a bounded, authoritative replay window. A corrupt
row is isolated and does not swallow later valid events.

### 4.3 Migrations (`_migrate()`)

Schema migrations are additive. `_migrate()` runs idempotent `ALTER TABLE ... ADD
COLUMN` statements for new nullable columns, separately creates tables/unique
indexes that SQLite cannot add via `ALTER`, and calls `_backfill_workspaces()` to
give existing users a personal workspace, backfill `Devbox.workspace_id` /
`Session.workspace_id`, and guarantee an owner membership. Nullable
`workspace_id` columns exist only to make that backfill lossless. When adding
`session.launch_id`, existing rows are backfilled with `'legacy'` so History does
not mistake them for never-started sessions. New rows start with a null token.
Existing session IDs are not rewritten; migrations never rewrite the recording
ledger, connector spool, or native-context bindings. Two other example columns
added this way: `session.retention` and `recording_frame.redacted_at`.

## 5. Delivery guarantees (end to end)

Output moves through three durability points, each strictly ordered:

1. **Spool first, then send.** The supervisor commits a frame to the connector
   spool before it can be sent.
2. **Persist, then ACK.** The server durably commits (`commit_new`) before it
   ACKs the connector. Eligible current frames are live-broadcast before the disk
   commit, so on-screen echo never waits on a network-disk fsync, but the ACK
   itself means "server has persisted", not "this frame belongs to the live run".
3. **ACK, then drop.** The connector removes a spooled frame only after a precise
   `seq` ACK for that stream.

Recovery cases:

- **Duplicate ACK** — same `(session_id, pty_instance_id, seq)` and identical
  payload is an idempotent re-ACK; nothing is rewritten.
- **Gap** — a missing seq yields `resend(expected_seq)`; no ACK is advanced.
- **Fork (fence, not error)** — a matching triple with a conflicting payload
  (CONFLICT), or a seq below the persisted frontier with no matching row
  (INVALID "below persisted frontier"), maps to a recoverable `fence`. The
  connector clears that stream's outstanding rows and continues from the newer
  local session instance; it does not tear down the transport.
- **Genuine error** — only truly malformed frames or writes targeting a devbox
  the connection does not own remain terminal errors. The server enforces
  devbox/agent ownership; a connection cannot write another machine's history.

Because each hop is durable and idempotent, a transport crash before ACK, a
WebSocket drop after persist but before ACK, or a full machine restart all leave
the spool rows in place; on reconnect they replay by `ord` and the server
de-duplicates precisely.

Transport reattachment preserves surviving providers and does not request native
resume. Nonlive History remains read-only until explicit, capability-gated Resume;
already-live attach does not send a duplicate CLI open. End is logical; only local
confirmed reap can clear an active native-writer journal.

## 6. Retention and secure erase

Retention is per session (`session.retention`), one of `none | 7d | 30d |
permanent` (default `30d`).

The workbench displays saved history as a read-only final transcript or terminal
screen, not a timed recording player. It no longer exposes recording download,
retention, or deletion controls. This UI change does not change existing data,
retention policies, frame/checkpoint persistence, reconnect restore, or the
authorized recording export/PATCH/DELETE APIs.

Enforcement lives in `RecordingStore`:

- `redact_expired()` walks each session and, for frames older than the policy
  window (`none` = redact immediately; `permanent` = never), blanks `data` to a
  fixed placeholder and stamps `redacted_at`. The seq/hash **identity row is
  preserved**, so a duplicate ACK after data loss can still be safely re-ACKed.
  Checkpoints capturing now-redacted content are deleted.
- `set_retention()` updates the policy and immediately runs `redact_expired()`.
  Under `none`, subsequent output is redacted eagerly as it is persisted.
- Secure erase (`DELETE /api/sessions/{id}/recording`, workspace admin/owner)
  blanks every frame payload for a session and stamps `redacted_at`, keeping the
  identity ledger, and deletes checkpoints. It is idempotent (a second call
  redacts nothing new), and unauthorized / cross-workspace targets get an opaque
  404.

Redacted payloads never leak: replay/export queries exclude redacted rows unless
an internal `include_redacted` flag is set.

## 7. Backup and restore (`server/ops/backup.py`)

The server database can be backed up and restored with a small operator tool:

- **Backup** uses SQLite's online backup API for a consistent snapshot even under
  concurrent writes, runs `PRAGMA integrity_check`, and removes the copy if the
  check fails. Files are written as `deepbox-backup-<timestamp>.db`.
- **Restore** validates the backup (SQLite header + integrity check), refuses to
  overwrite a database that appears to be in use unless `--force` is given,
  preserves the current database as a `.pre-restore` sidecar, and atomically
  swaps the new file into place with `os.replace`.

The connector spool and local state DB are per-machine and are not part of the
server backup. Retained spool rows replay after reconnect; back up `state.db`
separately if local project and skill configuration must survive machine loss.

## 8. Bounds and limitations

- Terminal re-attach cost is bounded by screen size (tens of KB), not session
  length; structured re-attach returns at most 4 MiB of the latest events.
- pyte memory is bounded (current screen plus limited scrollback).
- Durable recording rows grow linearly with session length and sit on the ACK
  path to provide delivery semantics; retention keeps this bounded over time.
- The live registry and keyboard-lease coordination assume one server process;
  horizontal scale-out is not supported today.
- New password hashes use Argon2id. Legacy salted-SHA-256 hashes remain readable
  only so a successful sign-in can replace them with Argon2id.
