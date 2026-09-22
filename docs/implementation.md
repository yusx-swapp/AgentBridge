# AgentBridge Implementation Guide

This is a practical map of the local AgentBridge draft: how the parts fit
together, what each module does, the protocol surfaces, and how to run the
tests. For product intent see [`design.md`](design.md) and
[`product-design.md`](product-design.md); for persistence internals see
[`persistence.md`](persistence.md); for operations see
[`operations.md`](operations.md) and [`remote-deployment.md`](remote-deployment.md).

**Status:** the user has authorized release of this implementation to the existing
`deepbox-webdata-du` app. Static design exploration remains separate. Verify the
deployment and `/api/version` rather than inferring a rollout from this module map.
Integration results belong in the [review record](review.md).

**AgentBridge** is the human-facing display name (`DISPLAY_NAME`), including the
FastAPI title. `NAME = "agentbridge"` remains the lowercase CLI/package and
service/logger identifier, with `AGENTBRIDGE_*` environment keys. `LEGACY_NAME`
and auth/cookie/hash/IPC/storage identities remain unchanged. This is not a migration.
The canonical repository and production installation source is
[yusx-swapp/AgentBridge](https://github.com/yusx-swapp/AgentBridge);
`yusx-microsoft/AgentBridge` is only a fork. Develop on feature branches from
canonical `upstream/main` and target PRs there, never directly on `main`.
Repository/installer branding does not migrate Azure resources/domains, Entra
identities, installed data or the `C:\Code\deepbox` worktree. See
[the rename contract](agentbridge.md) for publication and compatibility boundaries.

## 1. Architecture at a glance

Three cooperating parts:

- **Server** (`server/`) — FastAPI + SQLite. Handles identity, workspaces,
  devboxes, agents, sessions, keyboard leases, durable recording, and relaying
  frames between browsers and connectors. It never runs models or holds model
  credentials.
- **Connector** (`connector/`) — a Python client the user runs on their own
  machine. It launches the actual CLI agents (Claude Code, Copilot CLI, Codex
  CLI, or a mock), owns the PTYs / structured sessions, and streams output back
  over a durable spool. Model keys and LocalProject source paths stay local;
  terminal bytes or canonical events are relayed through the server.
- **Web** (`web/`) — a static single-page app. Native structured chat for
  runtimes that support JSON output, with an xterm.js terminal fallback for
  TUI runtimes or an explicit Terminal choice. Independent panes share a small
  workbench shell, not a singleton session controller. Model keys stay local;
  one-time connector tokens appear only in management dialog memory/DOM.

`agentbridge/product.py` centralizes product naming, `AGENTBRIDGE_*`/`DEEPBOX_*`
lookup, and install-home compatibility. Canonical variables win by presence,
including explicit empties; existing `.deepbox` and custom roots are not moved.
Fresh installs use `~/.agentbridge`; `.deepbox` in existing-install output is
compatibility, not the fresh-install name.
See [the exact compatibility contract](agentbridge.md#environment-and-home-compatibility).
This is not a server micro-framework rewrite: the FastAPI routes, Hub, leases,
durability pipeline, and provider registry remain.

Wire protocol version is `3` (`PROTOCOL_VERSION` in `server/app/models.py` and
`connector/transport.py`); the server validates it during the WebSocket hello,
and connector diagnostics compare it with `/api/health`.

### Data flow

```
Browser  <--WSS /ws/term-->  Server  <--WSS /ws/devbox-->  Connector  -->  CLI agent (PTY / structured)
   |            (relay + durable recording + leases)             |
   +-- REST /api/* (identity, fleet, sessions, replay) ----------+
```

1. The connector authenticates to `/ws/devbox` with a bearer devbox token,
   reports its runtimes/projects/skills (paths stripped), and holds the agent
   processes.
2. A browser opens `/ws/term` for a session; the server relays input frames to
   the owning connector and output/event frames back to the browser.
3. Every output/event frame is made durable on the connector (spool) and on the
   server (recording) with strict per-stream sequencing, so re-attach and replay
   are lossless. See [`persistence.md`](persistence.md).

## 2. Server (`server/app/`)

- **`main.py`** — FastAPI app: all REST routes, both WebSocket endpoints, static
  hosting of the SPA, and health/readiness. Registers an explicit
  `application/javascript` MIME type so Windows MIME-registry quirks plus
  `nosniff` cannot block the SPA.
- **`models.py`** — SQLAlchemy ORM schema and `init_db()` (per-connection SQLite
  PRAGMAs: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`,
  `wal_autocheckpoint`). Holds `PROTOCOL_VERSION`, retention constants, and the
  additive schema migrations / workspace backfill. `Session.surface` stores `terminal`
  or `structured`; migrated sessions remain unknown until a validated ready or
  snapshot establishes their surface. No runtime-name inference is needed. The
  SQL table is still **`session`**; `/api/devboxes` retains its domain identity.
  New session IDs use canonical UUID text. `Session.launch_id` is the lightweight
  lifecycle fence; migration marks old rows `legacy` without changing their IDs.
- **`hub.py`** — in-memory `Hub`: routes frames between connected browsers and
  connectors, per-devbox bounded send queues, hello ordering, duplicate-connection
  retirement, and presence.
- **`live.py`** — `LiveRegistry`: current terminal screen (pyte) per session and
  the bounded structured `event_restore()` tail used on re-attach.
- **`recording.py`** — `RecordingStore`: the durable frame/checkpoint ledger,
  Protocol v3 classification (NEW/DUPLICATE/GAP/CONFLICT/INVALID), asciicast v2
  and replay export, retention enforcement, and secure erase.
- **`security.py`, `identity.py`, `util.py`** — request authentication, session
  cookies, Argon2id password hashing with legacy salted-SHA-256 upgrade, and
  Microsoft Easy Auth mapping (`local | hybrid | microsoft` modes, tenant
  allowlist in production).
- **`config.py`** — environment/`.env` config; production mode refuses dev
  secrets, an empty Origin allowlist, and non-Secure cookies.
- **`version.py`, `capacity.py`, `logging.py`** — build provenance, capacity
  thresholds, and structured JSON logging.
- **`server/ops/backup.py`, `server/ops/smoke.py`** — validated online SQLite
  backup/restore and a post-restart smoke check.

## 3. REST and WebSocket surfaces

All REST routes are under `/api`. Authorization is by workspace membership and a
four-level role ladder `viewer < operator < admin < owner`; access is aggregated
across all of the caller's memberships. Highlights:

- **Health/ops:** `GET /api/health`, `GET /api/ready`, `GET /api/version`,
  `GET /api/admin/version`, `GET /api/admin/capacity`.
- **Auth/identity:** `GET /api/auth/config`, `POST /api/auth/register`,
  `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me/user`,
  `GET /api/me`, Microsoft `start`/`callback`/`logout`, and
  bootstrap-status/bootstrap.
- **Workspaces & members:** `GET|POST /api/workspaces`,
  `GET|POST /api/workspaces/{id}/members`,
  `PATCH|DELETE /api/workspaces/{id}/members/{user_id}` (last owner protected).
- **Invitations:** workspace invitations
  (`GET|POST /api/workspaces/{id}/invitations`, `DELETE ...`), plus email-bound,
  single-use, expiring `POST /api/workspace-invitations/preview` and `/accept`.
- **Fleet:** `GET|POST /api/devboxes`, `DELETE /api/devboxes/{id}`, devbox tokens
  (`GET|POST|DELETE`), agents (`POST /api/devboxes/{id}/agents`,
  `DELETE /api/agents/{id}`), and connector inventory intake
  (`POST /api/devboxes/{id}/runtimes|projects|skills`, bearer authenticated).
- **Sessions & replay:** `GET|POST /api/agents/{id}/sessions`,
  `GET /api/sessions/{id}` (current title, launch token and action availability),
  `GET /api/sessions/{id}/messages`, `GET /api/sessions/{id}/recording`
  (asciicast v2), `GET /api/sessions/{id}/replay` (header/events/checkpoints/
  duration/metadata), `DELETE /api/sessions/{id}/recording` (workspace admin/owner
  secure erase), `PATCH /api/sessions/{id}/retention`
  (`none|7d|30d|permanent`, workspace admin/owner). All enforce session ownership
  for legacy sessions or workspace RBAC for workspace sessions.
- **Rename:** `PATCH /api/sessions/{id}` accepts only `{title, expected_title}`.
  The trimmed title must be a single line of 1–120 characters without controls.
  Current Operator/Admin/Owner access is required; an atomic title compare-and-swap
  returns 409 on conflict. Only display metadata changes, with `session.updated`
  notifying attached views; no CLI command, identity or context change occurs.

WebSockets:

- **`/ws/devbox`** — connector transport. Bearer token via the `Authorization`
  header only (never query string). Carries the `hello`, inventory, control, and
  durable output/event frames.
- **`/ws/term`** — browser session channel. Origin-checked; cookie-authenticated.
  Carries attach, explicit resume, input, resize, keyboard-lease, and the relayed
  output/event stream. Nonlive History is read-only; only an authorized initial
  attach to a never-started row may launch automatically. Already-live attach
  sends no duplicate connector `open`. Resume requires the observed `launch_id`,
  current Operator/Admin/Owner access, and installed generic native-resume support
  (`context.explicit_resume` plus `session_lifecycle: 1`); it keeps the same
  session/agent/native ID, with no create fallback. Terminal/unsupported historical
  restart is refused. See [the lifecycle contract](design.md#55-restore-and-reconnect).

Session create/list and ready/snapshot frames carry the generic `surface` value.
An attach cannot silently change an existing session's surface. Structured
`stdin`/`input`, permission replies, and interrupts require Operator or above,
but not the terminal keyboard lease. Terminal input, resize, and termination
require the keyboard holder, including for an Admin/Owner. Structured keyboard
REST requests return 400; browser keyboard frames return `keyboard_not_required`.
Structured termination requires current Operator/Admin/Owner access without a
keyboard lease. Closing a pane only detaches its viewer.

Every input checks current identity, membership, and attachment. Every connector
session frame checks the current devbox connection, session's owning agent, and
instance fence—including legacy output, ready, exit and process snapshots, not
just durable v3 frames. Malformed frames return an error instead of tearing down
the connection. Valid legacy wire forms remain supported at this boundary.
For lifecycle-capable sessions, `launch_id` fences controls, ready, exit, and
snapshots; stale snapshot entries cannot downgrade a newer active generation.
Old structured-instance output is still committed and ACKed, but not live-fanned.
End marks the session logically ended, not locally reaped. Session-scoped connector
`error` and `runtime.unavailable` frames use safe server guidance, not raw connector
exception/stderr text; no replacement session is created.

## 4. Connector (`connector/`)

- **`cli.py`** — installed `agentbridge` command and legacy `deepbox` alias:
  explicit connect, diagnostics, project/skill management, and upgrade actions.
  Shared product helpers select compatible environment values and install roots.
- **`client.py` / `Connector.run()`** — top-level loop: `GET /api/me`, report
  projects/skills/runtimes, run a ~2s inventory watcher, open `/ws/devbox`,
  handle handshake and heartbeats (every 20s), and reconnect with backoff after
  abnormal closes, resuming un-ACKed frames from the spool.
- **`supervisor.py`** — `SessionSupervisor` owns the sessions and PTYs
  (session-authoritative). `attach()`/`detach()` connect and disconnect a
  transport without killing the PTY; output is emitted into the durable spool and
  drained to the transport by strict `seq`.
- **`transport.py`** — the WebSocket-facing side. Split from the supervisor so a
  transport restart never kills a running agent. Runs all-in-one over an
  in-process `LoopbackChannel` by default (`python -m connector`), or as two
  processes via `--mode supervisor` / `--mode transport` over a local named pipe
  (Windows) or Unix socket (`0600`).
  There is one sender/delivery path: the unused `Connector._sender` and its
  supervisor-property facades have been removed. Diagnostics and both transports
  share URL validation: HTTPS is required off loopback, and credential-bearing,
  query-bearing or fragment-bearing base URLs are rejected before using a token.
  Lifecycle controls use awaited IPC and preserve `launch_id`; `resume` is never
  translated to `open`. Lost transport/reconnect is not a request for native resume.
- **`spool.py`** — durable output spool (SQLite, WAL, `synchronous=FULL`); see
  [`persistence.md`](persistence.md).
- **`runtimes.py`** — single source of truth for runtime adapters. `RuntimeAdapter`
  declares stable id/label, argv, model/permission allowlists, non-secret env,
  probe hints, terminal/structured surfaces, and personal/project skill roots.
  Built-in: `mock`, `claude-code`, `copilot-cli`, `codex-cli`,
  `claude-code-structured`, and `copilot-cli-structured`.
  `resolve_cmd()` builds argv (platform-appropriate parsing of `launch_cmd`, else the
  shared `build_command()`), rejects empty/control/shell-metacharacter tokens,
  and spawns argv directly (no shell). Unknown runtime IDs without an explicit
  command are rejected instead of being replaced with `mock`.
- **`runtime_probe.py`** — runs local subprocess probes and emits capability
  schema v2 (installation, compatibility, authentication, models, surfaces, and a
  content-hash `revision`). Executable paths, raw probe output, and credentials
  are never uploaded. Version metadata is a parsed version number, not an arbitrary
  first output line. Probe output is captured in a temporary file and only a 64 KiB
  prefix is read into memory; timeouts and failed probes keep their fixed statuses.
  Codex's adapter leaves `auth_argv` empty: `login status` checks an account login,
  not the provider/profile/project config of a future CLI launch. Inventory and
  startup probes therefore report authentication `unknown`, never a fabricated
  authenticated result; Codex handles its own provider authentication. No config
  files, credential files, login commands, or model requests are added to probing.
  The generic availability checks and other adapters' auth probes are unchanged.
- **`pty_session.py`** — cross-platform pseudo-terminal for interactive TUIs
  (Windows ConPTY via `pywinpty`; POSIX `pty.fork` + `os.execvp`). Default size
  120x30, re-sized by the first browser `resize` frame. Windows passes argv directly
  to `PtyProcess.spawn`; explicit command parsing preserves Windows paths and
  quoted arguments. Normal exit and kill release the child and PTY reader handles;
  a failed working-directory change never falls through to a different directory.
- **`agent_session.py`** — structured (`kind="event"`) sessions. Translates a
  runtime's JSON stream into display-safe canonical events (`status`,
  `session.config`, `user.echo`, `message.delta`, `message`, `tool.call`,
  `tool.result`, `permission.ask`, `turn.end`, `error`). `write_turn(text,
  options)` applies per-turn/session controls under the adapter allowlist.
  All writes use the same bounded turn queue; per-turn processes finish before
  the next queued turn starts. Full/closed queues reject input explicitly.
  Kill cancels queued work, so a scheduled turn cannot launch a new child later.
  Supervisor starts are serialized per session and invalidated by retirement or
  shutdown; partially-started children are cleaned and failures have safe,
  actionable `runtime.unavailable` messages.
- **`local_store.py`** — local project + skill state (SQLite); project paths are
  retained locally and stripped from cloud inventory; see
  [`persistence.md`](persistence.md).
- **`skills.py`** — parses `SKILL.md` frontmatter, validates the tree
  (regular files only; no traversal/symlink; 256 files / 10 MiB caps), and does
  atomic staged install/rollback/drift/GC. Scripts are surfaced
  (`contains_scripts=true`) but never executed by AgentBridge.
- **`diagnostics.py`** — shared server URL validation and `run_doctor()`
  URL/TLS/DNS/protocol checks. Unknown connection failures expose the exception
  class, not raw exception text that may contain URLs or credentials.
- **`mockcli.py`** — a fake CLI (echoes `you said: ...`) so the full chain can be
  exercised without a real agent.

### Runtime / surface behavior

- One runtime family may expose several adapter surfaces. The browser picks the
  family's default surface (Claude/Copilot default to `structured`) and sends it
  in the attach frame; the connector confirms via `session.ready.surface`. If the
  runtime is missing or cannot start, it returns `runtime.unavailable` (with
  installation/compatibility/authentication and available surfaces) rather than
  silently falling back to a terminal.
- Model/permission options are validated per turn against the adapter allowlist.
  Claude switches model live in one process via a `set_model` control request;
  runtimes without a live mapping apply the option through per-turn argv.
- File input is base64 over the wire; the connector re-validates count/size, and
  only file name/type/size (never bytes or temp paths) enter echoes and durable
  history.
- Structured adapters may declare a `ContextControl` (`connector/runtimes.py`)
  naming the flags that create and resume a provider-owned conversation. The
  supervisor passes AgentBridge's own session ID. Under a family/session writer
  lock it re-reads the durable marker, reserves `state=attempted` before create,
  and promotes it to `established` after a successful turn. Existing reservations
  always resume, even if a failed first launch left no provider transcript; there
  is no create fallback. `BEGIN IMMEDIATE` serializes marker read/check/write;
  failure to promote fences input. Inventory omission does not delete markers.
  Effective cwd is captured (including inherited cwd), and changed runtime or
  cwd-scoped project bindings are refused. Configuration changed during probing
  is rejected. Eager and lazy launches both use the command builder; the previous
  lazy supervisor path already did so, so the earlier eager-path fix was not a
  demonstrated production-Claude context-loss root cause.
- Explicit Resume requires an existing local `attempted`/`established` marker,
  checked under native-writer ownership before logical ready and again before
  every spawn. `require_existing_context` cannot fall back to create or change the
  session/agent/native ID. The existing runtime/cwd binding rules are unchanged.
  `context_resume: "pending"` means the next real message performs native resume;
  lazy/per-turn preparation does not prove that the provider transcript exists.
- `native_writer.py` provides a user-local, non-blocking OS lock and fsynced
  active journal. Scope is runtime family + session ID, not agent/cwd/database.
  The lock spans per-turn idle gaps and is released after confirmed child reap;
  cancelled/late spawn and full-pipe cleanup are regression-tested. Uncertain
  cleanup keeps the journal active for explicit recovery, never TTL/PID takeover.
  `StructuredAgentSession.wait_closed()` and supervisor reaper tracking let CLI
  shutdown finish cleanup before closing the local store/event loop.
- `agentbridge context status|release` (`connector/cli.py`) inspects/recovers
  guards locally without starting a connector or CLI. Release requires the exact
  journal owner plus `--confirm-writer-stopped`, and cannot break a live OS lock.
  That flag is human attestation, not automatic verification that an orphan died.
- Adding a new runtime is one registry entry plus an adapter — no server or
  browser changes.

## 5. Web (`web/`)

- **`index.html`, `styles.css`** — restored pre-tmux workbench with refined top
  navigation, a compact collapsible sidebar, flexible panes, and quiet controls.
  Restrained sans-serif UI and monospace code/data, subtle borders/spacing, and
  light/dark themes; no green tmux status bar or forced full-screen TUI.
- **`api.js`** — credentialed same-origin JSON requests and consistent error handling.
- **`dialogs.js`** — shared modal, form, prompt, and confirmation lifecycle with
  cancellation, Escape, and focus restoration.
- **`management.js`** — account/workspace/member administration, devbox/agent,
  project/skill, and one-time-token dialogs. Captured user/workspace context guards
  asynchronous responses. Role edits require an explicit **Save**; no auto-grants.
- **`layout.js`** — DOM-free binary split-tree operations, validation, ratio
  clamping, normalized pane geometry/neighbors, and a four-pane maximum.
- **`workbench.js`** — pane hosts, select/split/close/maximize, draggable and
  keyboard-operable row/column separators, DFS pane numbering, geometric/cyclic
  focus, resize notification, and layout
  preferences keyed by user + workspace. Saved targets are whitelisted
  IDs/surface/kind alongside geometry, never messages, files, tokens, or roles.
- **`pane.js`** — each pane's session/socket lifecycle, chat, terminal, saved history,
  reconnect, file reads, stale-response guards, and teardown. Closing detaches;
  it never terminates the backend session. New chat leaves the old session alive.
  Unsent drafts remain independent in memory and never enter layout storage.
  History and live session headers provide metadata-only Rename with a
  retained draft on title conflict. History separates View history, Attach live,
  and explicit Resume; unsupported/terminal historical restart is disabled with
  a reason, not converted into New session. Preparation and safe resume failures
  are visible; a failed startup/resume clears the matching card's `starting`
  state to `inactive` while keeping input disabled and the error visible.
  Logical ready does not claim restored native history.
  The server allowlists `runtime_not_authenticated` and `runtime_auth_probe_failed`
  on session error frames and maps both error/unavailable variants to fixed,
  actionable provider-auth guidance. It preserves the code without forwarding raw
  connector stderr, paths, or credentials. Errors do not enable input, retry a
  launch, or create a replacement session.
  Saved history immediately renders the full structured transcript or the latest
  terminal checkpoint plus remaining output, read-only. There is no timed player,
  seek/speed UI, recording download, or retention/deletion toolbar. The legacy
  `kind: 'replay'`, helper aliases, and `/replay` API remain compatible with saved
  layouts and existing data; they do not imply playback or automatic Resume.
- **`app.js`** — shell composition, signed-in/workspace context, top navigation,
  collapsible sidebar, management, and optional keyboard/command affordances.
  **`main.js`** is the small bootstrap entry point.
- **`tmux.js`** — optional, allowlisted key/command parsing, not a shell evaluator
  or the primary visual shell. The mode is **opt-in, default off**: Control+B must
  not be captured before user enablement, and disabling clears pending prefix state.
  When enabled, literal Ctrl+B uses only the pane's checked `sendPrefix()` path;
  dialogs, IME composition, and unprefixed editing/terminal keys are respected.
  Visible navigation and pane controls do not depend on this mode; see the
  [optional key contract](agentbridge.md#optional-tmux-style-interaction).
- **`ui.js`, `chat.js`, `replay.js`, `collaboration.js`** — shared helpers:
  fleet aggregation, filtering, command building, runtime label/option handling,
  the canonical event reducer, JSONL parsing, saved-history event/checkpoint reconstruction, and
  collaboration view state, plus the transcript renderer.
- **`terminal-assets.js`** — on-demand, retryable loader for the existing pinned
  jsDelivr xterm CSS/JS and fit addon. Chat/app boot never wait for the CDN;
  terminal load failure is visible before any session-creation request. Saved
  terminal history keeps its metadata and an explicit renderer-failure notice if
  xterm cannot load. No vendor downloads were performed
  during implementation; xterm has not been vendored or removed.

Local deferred script order is `ui → chat → collaboration → replay → api → dialogs →
layout → terminal-assets → pane → workbench → management → tmux → app → main`.
There is no lazy chat-mount gate. Explicit Terminal reuses only a known matching
live terminal; New session retains its selected surface. Layout restore never
persists `forceNew`: a missing agent/session or an ended saved live target does not
cause a create request. Layout storage is not a recording or permission cache;
all authorization remains enforced by the existing server.

The reducer merges `session.config`, `user.echo`, assistant messages, tool cards,
permissions, turn and error state; optimistic user turns are de-duplicated against
the canonical `user.echo`, and streaming deltas are not re-rendered as a duplicate
final result. Live and restored events go through the same reducer.

## 6. Configuration and deployment

`config.py` loads from environment/`.env`; `python -m server` starts Uvicorn.
Use canonical `AGENTBRIDGE_*` names (for example `AGENTBRIDGE_DATABASE_URL`,
`AGENTBRIDGE_SERVER_URL`, and `AGENTBRIDGE_TOKEN`). A corresponding `DEEPBOX_*`
value is used only when the canonical key is absent, not when it is explicitly
empty. Defaults and caller validation still apply; see [compatibility](agentbridge.md).
The recommended small deployment keeps Uvicorn on `127.0.0.1:8077` behind
Tailscale Serve for Tailnet HTTPS/WSS; the app does not terminate TLS itself, and
Funnel / direct public exposure is out of scope. `/ws/term` validates Origin;
`/ws/devbox` accepts a bearer token only via the `Authorization` header. Health
endpoints: `GET /api/health` (liveness + protocol) and `GET /api/ready` (also
checks the database and recording data directory). See
[`remote-deployment.md`](remote-deployment.md) and [`operations.md`](operations.md).

## 7. Testing

Server, connector, security, and persistence suites live in `tests/` and run with
pytest; pure helpers and actual app orchestration run with `node --test`.

**Do not run Python tests from the working checkout with default configuration.**
Importing the server initializes SQLite before fixtures can replace it. Launch a
disposable subprocess with a temporary cwd, database, data directory, HOME and
user-state roots; clear inherited `AGENTBRIDGE_*`/`DEEPBOX_*` settings and disable
dotenv before importing the app. Set both database/data aliases to those isolated
paths, put the checkout on `PYTHONPATH`, and pass an absolute test path to pytest
(`C:\Code\deepbox\tests`, or a selected test file). Disable bytecode/cache writes;
if plugin autoload is disabled, explicitly load `pytest_asyncio.plugin` for the
async integration tests. Install the connector/test dependencies, including
`cryptography` and `pytest-asyncio`, in the intended test environment. Verify the
original database and sidecar hashes have not changed; remove only owned test data.

```bat
:: All browser suites, including runtime integration subdirectories
cd /d C:\Code\deepbox && cd web && node --test
```

Use isolated fixtures, not live setup or real model agents. Final integrated
evidence and user acceptance for this polish pass remain pending in [`review.md`](review.md);
the earlier tmux iteration's counts are historical, not validation for this pass.

Representative coverage:

| Area | Tests |
|---|---|
| End-to-end lifecycle | `test_agent_lifecycle.py`, `test_hub.py`, `test_onboarding.py` |
| Surface selection and shared-session security | `test_session_surfaces.py`, `web/app.test.js` |
| PTY lifecycle (including isolated Windows children) | `test_pty_session.py` |
| Recording / replay / retention | `test_server_recording.py`, `test_persistence.py` |
| Connector transport split | `test_connector_supervisor.py`, `test_connector_transport.py`, `test_connector_ipc.py` |
| Durable spool | `test_connector_spool.py` |
| Runtimes / probe / structured chat | `test_connector_runtimes.py`, `test_runtime_probe.py`, `test_copilot_session.py`, `test_agent_session.py` |
| Projects & skills | `test_devbox_projects.py`, `test_devbox_skills.py`, `test_skills.py`, `test_local_store.py`, `test_project_watcher.py` |
| Identity / workspaces | `test_identity.py`, `test_collaboration.py`, `test_collaboration_routes.py`, `test_workspace_invitations.py`, `test_microsoft_auth_routes.py` |
| DB / migrations / pragmas | `test_models_migration.py`, `test_db_pragmas.py` |
| Ops | `test_backup.py`, `test_capacity.py`, `test_smoke.py`, `test_version.py`, `test_logging.py` |
| Security / config | `test_security.py`, `test_security_integration.py`, `test_config.py`, `test_password_hashing.py` |
| Display / identifier separation | `test_product.py`, title/OpenAPI/logger checks in `test_security_integration.py` |
| Browser logic | `web/ui.test.js`, `web/chat.test.js`, `web/replay.test.js`, `web/collaboration.test.js` |
| Pane isolation, split/restore, management context | `web/pane.test.js`, `web/layout.test.js`, `web/workbench.test.js`, `web/management.test.js`, `web/app.test.js` |

## 8. Current boundaries

- Rename/explicit Resume describe the current local changes, not new live
  Workspace or real-CLI acceptance evidence, and not a deployment claim.
- The in-memory `Hub` / `LiveRegistry` have single-server-instance semantics;
  horizontal scale-out needs shared active-connection and live-screen state.
- The app itself does not terminate TLS; a deployment front end such as Azure App
  Service or Tailscale Serve must provide HTTPS/WSS.
- Two-process supervisor/transport (real ConPTY / Windows service durability)
  has simulation coverage but still needs manual on-hardware verification
  before being treated as production-proven.
