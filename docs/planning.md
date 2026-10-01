# AgentBridge — Roadmap and Current State

> AgentBridge is an **agent switchboard / control plane**: it connects agent CLIs
> (Claude Code, GitHub Copilot CLI, and Codex CLI) running on a
> user's own devbox to a server, so users can log in and interact with them from a
> browser. The server never runs models and never holds model credentials; intelligence
> and secrets stay on the devbox.

The user has authorized release of the current AgentBridge workbench to the
existing `deepbox-webdata-du` service. Future design choices remain separate from
this release. A code map or Git push is not a deployment record; use runtime,
health, version and byte verification. For detail see
[`product-design.md`](product-design.md), [`design.md`](design.md), and
[`implementation.md`](implementation.md).

**AgentBridge** is the display name (`DISPLAY_NAME`); `agentbridge` (`NAME`) stays
the lowercase CLI/package/service/log identifier, with `AGENTBRIDGE_*` environment
keys. `LEGACY_NAME`, storage, and auth/cookie/hash/IPC compatibility remain unchanged.

---

## 1. Retained foundation and local draft

### Server (`server/app/`, FastAPI + WebSocket + SQLite)

The product goal is centralized human/team management of agents distributed
across many machines, with shared Workspace access—not an agent-to-agent workflow.
Fleet-size validation (for example, 100 agents) is separate from a four-pane UI limit.

- Local password sign-in with Argon2id hashing (transparent upgrade from legacy
  hashes on successful login) plus signed session cookies.
- Microsoft / Entra sign-in path via Azure App Service Easy Auth, with a
  server-side tenant allowlist check; local accounts remain for development and
  hybrid migration.
- Organization → Workspace → Membership data layer. Every user gets a personal
  workspace and can create more; four roles (`viewer` / `operator` / `admin` /
  `owner`) constrain every resource.
- Workspace invitations (single-use, expiring, email-bound) and deployment-owner
  onboarding, disable, and re-enable of local accounts.
- Devbox creation with one-time tokens, token hashing, and rotation; one user has
  many devboxes, one devbox hosts many agents.
- Realtime hub (`hub.py`) and live registry that route human (browser) and devbox
  (connector) WebSocket connections and relay frames.
- Multi-viewer broadcast with a single 60-second keyboard lease per terminal session;
  operator-and-above can request or hand off control, viewers stay read-only.
  Structured chat uses Operator/Admin/Owner permission, not a keyboard lease.
- Protocol v3 durable recording: `recording_frames` are committed before ACK with
  ownership, unique-key, and content-hash checks. DVR history exposes `/recording`
  and `/replay`, checkpoints use a durable `frame_id` cursor, and asciicast v2
  export is available. Session retention supports `none` / `7d` / `30d` /
  `permanent`, applied immediately; workspace admins and owners can securely erase
  payload and checkpoints while keeping the seq/hash identity rows that keep
  duplicate-ACK safe.
- Operations surface: structured redacting JSON audit log, health/readiness
  checks, connection visibility, backup/restore, capacity alerts, version and
  smoke checks. See [`operations.md`](operations.md).
- Security baseline: production Origin allowlist, layered rate limits, security
  headers / HSTS, credential revocation that immediately disconnects, and
  connector protocol checks.

### Connector (`connector/`, user-launched process)

- Bridges local agent CLIs to the server. The local draft exposes `agentbridge`
  with the `deepbox` CLI alias; ordinary `connect` / `status` / `doctor` / `project` /
  `skill` commands do not refresh the install directory. Upgrades are explicit.
  Product/environment/home compatibility lives in `agentbridge/product.py`; old
  `.deepbox` and custom roots and persistent identities are not auto-migrated.
- Runtime registry (`runtimes.py`) is connector-only: a shared builder constructs
  and validates argv for Claude Code, Copilot CLI, and Codex CLI; the
  server and web treat capabilities as opaque JSON.
- Runtime probing (`runtime_probe.py`) reports installed runtimes, versions, and
  capability facts to the server on connect.
- Two local execution paths: structured-first native chat for headless/JSON
  runtimes, and an xterm.js / PTY terminal fallback for legacy/TUI runtimes.
- Cross-platform PTY (`pty_session.py`): Windows ConPTY via pywinpty, POSIX pty.
- Supervisor / transport split (`supervisor.py`, `transport.py`, `ipc.py`): the
  default `python -m connector` still runs an in-process `LoopbackChannel`, while
  `--mode supervisor` / `--mode transport` enable a real two-process form over a
  Windows named pipe or POSIX Unix socket (0600) with length-bounded JSON frames
  (never pickle) and a local same-user handshake. A transport restart or
  disconnect no longer kills the PTY.
- Durable delivery spool (`spool.py`, `local_store.py`): a SQLite WAL store with
  `synchronous=FULL` holding `outbox` / `ack_state` / `input_receipts`. Each PTY
  start gets a stable `pty_instance_id`; output is assigned a contiguous `seq` per
  `(session_id, pty_instance_id)` and committed to the spool before send. Transport
  only releases the queue head after a durable server ACK; input dedupes on a UUID
  `client_input_id`. Reconnect replays exactly from the last ACK, duplicates are
  re-ACKed, gaps request precise resend, and conflicts fence only the forked stream
  so the connector can recover.
- LocalProject registration keeps absolute paths only in a connector-local
  `state.db`; the server receives only stable project IDs and display names. Browser
  project actions generate copy-only commands.
- User Skills (`skills.py`): directories with a UTF-8 `SKILL.md`; the connector
  validates boundaries, refuses links / reparse / oversize / mid-read drift, copies
  content into its state root, and reports only path-free inventory. AgentBridge never
  executes skill files.

### Web (`web/`, local workbench draft — acceptance pending)

- Native chat for structured runtimes with capability-driven model / reasoning
  controls and **New chat**, preserving the old session. Terminal is a TUI fallback
  or an explicit surface choice. Existing backend role/lease/durability and the
  connector's provider registry remain, not a server micro-framework rewrite.
- Refined top navigation and a compact collapsible sidebar return to the pre-tmux
  workbench. The sidebar navigates Workspace → Devbox → Agent. Add-agent refreshes runtime and
  project inventory and generates copy-only local `agentbridge project add ...`
  commands; the Skills view shows only connector-reported metadata.
- One-time tokens are shown only in memory / DOM. Auto-reconnect, structured event
  recovery, terminal screen restore, and session DVR history are all preserved.
- Compact plain transcripts/lists, restrained sans-serif UI and monospace code/data,
  subtle borders/spacing, and light/dark themes. No green tmux status bar, forced
  full-screen TUI, bubbles/dashboard cards, or remote fonts. Local helpers load in fixed
  order; the existing pinned jsDelivr xterm dependency loads only on terminal
  demand, not chat/app boot. No vendor downloads were performed.
- Tmux-style keyboard/navigation remains an **optional opt-in, default off** layer,
  not the primary shell. Control+B is untouched until enabled; visible navigation
  and pane controls remain available without it. See the [optional key contract](agentbridge.md#optional-tmux-style-interaction).
- `layout.js`/`workbench.js` implement a user-selected binary split tree capped at
  four panes, pointer/keyboard ratios, selection/maximize/close, and user/workspace
  layout preferences. `pane.js` owns each socket/chat/terminal/replay lifecycle;
  close detaches, and missing/ended saved targets never auto-create sessions.
- Independent unsent drafts survive focus, resize, and split actions without crossing
  panes; draft text is not persisted in layout preferences. New chat preserves the old
  shared session, and ending a session remains a separate permission-checked action.
- API/dialogs/management are separate from app/main shell composition. Management
  is context-safe, requires explicit role Save, and never auto-grants access. See
  [implementation](implementation.md#5-web-web) for the current module map and
  [review](review.md) for the full test/acceptance plan.

---

## 2. Architectural invariants

- The server never runs models and never holds API keys or CLI login state.
  Intelligence and credentials stay on the devbox.
- The connector owns runtime knowledge. Runtime capabilities are opaque JSON to the
  server; the web renders their generic control schema. Adding a runtime is a
  connector-only change and never a server/web runtime-specific branch.
- SQLite is the authority for control-plane metadata on the server; the connector's
  local SQLite spool is the authority for un-ACKed output.
- Durable delivery is persist-before-ACK. A successful `ws.send()` is never treated
  as delivery; only a durable server ACK for a `(session_id, pty_instance_id, seq)`
  triple advances the queue.
- Output is deduplicated and ordered by `(session_id, pty_instance_id, seq)`; input
  is deduplicated by `client_input_id`. Recording frames enforce ownership, a
  unique key, and a content hash.
- Detaching or restarting a transport must not kill the PTY; the agent process
  outlives transport churn.
- Absolute filesystem paths never leave the connector. The server stores only
  stable IDs and path-free metadata for projects and skills.
- Structured state is preferred over parsing ANSI text to infer agent semantics.
  The raw terminal stream is retained only as a generic fallback.
- Authorization is role-based across every shared resource; viewers are always
  read-only. A terminal has at most one keyboard lease at a time; structured chat
  requires Operator/Admin/Owner without taking a lease.

---

## 3. Validation status

The completed maintenance release at `1fab322` is the historical baseline, not
approval for this draft. Its prior review remains in Git at `1fab322:docs/review.md`.
Current user visual/code review and final integrated suite evidence are **pending**
in [review](review.md). No local test result implies a deployment or live-machine
upgrade; no new pass counts or deployed cut are asserted here.
The prior tmux-shell iteration's counts are historical, not evidence for the restored
workbench or its default-off keyboard mode.

Automated coverage lives in `tests/` (server, connector, security, persistence,
recording) and in the browser `*.test.js` node:test suites. It is organized into a
few categories:

- **Unit / pure logic** — session and lifecycle state mapping, runtime argv
  builders and probes, spool sequencing and dedupe, DOM-free UI and split-tree logic.
- **Integration** — REST and WebSocket routes for auth, workspaces, invitations,
  collaboration and keyboard lease, recording and replay, ops endpoints, and model
  migration.
- **Durability / fault injection** — connector spool behavior across
  persist-before-ACK, reconnect replay, duplicate frames, gaps, and conflicts.
- **Browser lifecycle** — shell/management context, pane isolation, layout
  persistence, restore-without-create, and terminal-demand/error behavior.
- **Runtime acceptance** — deterministic mock/fake-connector fixtures are the local
  review scope. Historical real-runtime checks are not evidence for this cut;
  live CLI/multi-machine runs require a separate, explicit manual acceptance step.

Use the [verification commands](implementation.md#7-testing), including **all**
`web/*.test.js` suites, not only the historical UI/chat/replay helpers. Integration
will supply final results; do not run live setup or real agents automatically.

---

## 4. Remaining known work

### Local draft and rename gates

- Complete local code/visual review and isolated regression evidence, then obtain
  explicit user acceptance before any publication, staged installation, or release.
- Review restored top navigation/sidebar, minimal typography/spacing, light/dark
  themes, and default-off/opt-in shortcuts without weakening pane isolation or roles.
- Verify canonical/legacy/empty environment precedence, old/custom root continuity,
  pane teardown/restore privacy, collaboration permissions, and dialog role Save.
- **Canonical repository and installation source**:
  [yusx-swapp/AgentBridge](https://github.com/yusx-swapp/AgentBridge).
  `yusx-microsoft/AgentBridge` is a fork, not production upstream. Feature branches
  and PRs target canonical `upstream/main`; no direct-main development. Verify the
  actual repository rename and script/package publication separately from review.
- **Compatibility and cloud boundaries**: fresh installs use `~/.agentbridge`;
  existing `.deepbox` output is compatibility, not the fresh-install name. No
  installation is moved automatically. The `C:\Code\deepbox` worktree, Azure
  resources/domains, Entra callbacks, cookies/tokens/IPC and installed data remain
  unchanged. Future cloud/domain or identity/data migrations need separate
  approval and continuity/rollback planning; see the
  [migration gates](agentbridge.md#migration-gates).

### Real multi-machine end-to-end

- Real three-machine remote validation (server + two devboxes) over Tailscale
  Serve, exercising the Windows start/diagnose flow end to end, remains a manual
  acceptance gate. See [`remote-deployment.md`](remote-deployment.md) and
  [`azure-deployment.md`](azure-deployment.md).
- Real supervisor/transport two-process form on a Windows service with a long-lived
  `sessiond` driving a real ConPTY / agent still needs a human-run soak test; see
  [`implementation.md`](implementation.md#8-current-boundaries).
- Real multi-browser / multi-machine collaboration validation of the keyboard lease
  and multi-viewer broadcast under network churn.

### Hardening and maintainability

These are later candidate work, not work authorized or validated by this draft.

- Optional automatic recovery of agent processes after a full devbox reboot (a
  supervised session host or managed tmux/ConPTY backend), beyond current transport
  resilience.
- Extend the durability guarantees to remaining control frames and add operator
  visibility for pending frames/bytes and last ACK.
- Broaden the runtime E2E matrix (Copilot CLI, Codex CLI) on real machines to catch
  TUI behavior differences; keep the raw PTY stream as the fallback.
- Connector auto-upgrade policy and clearer install/diagnose ergonomics for
  non-developer users.
- Confirm a deployment-specific privacy and recording policy before wider exposure;
  the technical 30-day default is not a substitute for a governance decision.

---

## 5. Non-goals

- The server will not run models, proxy provider APIs, or store API keys or CLI
  login state. AgentBridge is a platform, not an AI product.
- The server will not parse ANSI/terminal text to reconstruct agent semantics; that
  belongs to structured runtime events on the connector.
- Absolute paths, local directory browsing, and skill execution are not server or
  browser responsibilities.
- Horizontal scale-out (PostgreSQL, Redis/NATS routing, object storage, stateless
  multi-node API/WS) is deliberately out of scope until the single-node lifecycle
  and protocol are proven; the current SQLite + single-process hub is a single-node
  deployment target, not a scale-out design.
- AgentBridge is not a public multi-tenant SaaS. The current baseline is an
  operator-owned, access-controlled deployment, even when its authenticated HTTPS
  endpoint is publicly reachable.
