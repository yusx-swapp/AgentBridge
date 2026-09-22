# AgentBridge — Design

**Local draft, awaiting user visual/code review.** Production remains
`deepbox-webdata-du` at `1fab322`; that release's approval does not cover this work.
The protocol/domain design below is retained, not a server rewrite. For current
module responsibilities see [implementation](implementation.md); for name/home
compatibility, canonical repository/installer publication and separate cloud/data
migration gates see [AgentBridge](agentbridge.md).

The only upstream and production installation source is
[yusx-swapp/AgentBridge](https://github.com/yusx-swapp/AgentBridge).
Repository/installer renaming does not change Azure resources, the `C:\Code\deepbox`
worktree, installed state, auth identities, wire protocol, durable spool, or IPC.
Fresh installs use `~/.agentbridge`; existing `.deepbox` installations remain
compatible without automatic migration.

> **In one line:** AgentBridge is an "agent switchboard / control plane". Users connect
> the agent CLIs on their own devbox (Claude Code, GitHub Copilot CLI, Codex CLI,
> and similar) to the server, sign in to the web UI, and interact with those agents
> as if they were at the local terminal.
>
> **The server is a control plane, not an AI product.** It never runs models, never
> holds a model API key, and never installs a CLI. Intelligence and credentials
> stay entirely on the user's devbox. The server provides identity, connectivity,
> channels/sessions, message relay, presence, and the bidirectional transport that
> carries user input and agent output.

---

## 1. Entity model (Workspace / Devbox / Agent)

```text
Human ── Membership(role) ──▶ Workspace ── owns ──▶ Devbox ── runs ──▶ Agent
```

- **Human** — A browser user. Signs in with a local password or with a Microsoft
  identity via Azure App Service Easy Auth, then carries a short-lived
  `deepbox_session` compatibility cookie that agentbridge issues itself.
- **Workspace** — The visible collaboration and authorization boundary. A user can
  belong to many workspaces, and a workspace can contain many devboxes.
- **Membership** — A human's `viewer / operator / admin / owner` role within a
  workspace. Members can discover every devbox and agent in the workspace; writes
  are still checked by role.
- **Devbox** — A connector/supervisor on a user machine. It connects with only a
  devbox bearer token, never a Microsoft token or a model key.
- **Agent** — A CLI process on a devbox managed by the supervisor. The browser
  hierarchy is always Workspace → Devbox → Agent. An agent may reference a
  path-free `local_project_id`.
- **LocalProject** — A connector-local project. Its absolute path exists only in
  the local `state.db`; the server holds only a path-free `DevboxProject` record
  with the same ID.
- **Skill** — A user-provided `SKILL.md` package. The connector manages its content
  and runtime bindings; the server holds only a path-free inventory.

The deployment-level `User.role` (`owner / member`) governs only global control-plane
abilities such as user management, and is independent of workspace membership. The
server still runs no models and holds no Claude/Copilot/Codex credentials.

---

## 2. Data model (SQLite / SQLAlchemy)

Core tables (timestamps and some helper columns omitted):

```text
user(id, username, password_hash, display_name, role, email,
     auth_provider, external_tenant_id, external_subject, disabled_at)
organization(id, name, owner_user_id, is_personal)
workspace(id, organization_id, name, is_personal)
membership(id, workspace_id, user_id, role)
workspace_invitation(id, workspace_id, email, role, token_hash, token_preview,
                     created_by_user_id, expires_at, accepted_at,
                     accepted_by_user_id, revoked_at)
devbox(id, owner_user_id, name, last_seen_at, capabilities, skills, workspace_id)
devbox_project(id, devbox_id, name, runtime_config, created_at, updated_at)
token(id, devbox_id, hash, preview, created_at, last_used_at, revoked_at)
agent(id, devbox_id, handle, display_name, runtime, local_project_id,
      runtime_config, cwd, launch_cmd, presence, created_at)
session(id, user_id, agent_id, title, retention, workspace_id, created_at)
session_participant(id, session_id, user_id, role, joined_at)
message(id, session_id, author_kind, author_id, body, created_at)
recording_frame(id, session_id, pty_instance_id, seq, kind, data, payload_hash,
                elapsed, timestamp, created_at, redacted_at)
recording_checkpoint(id, session_id, frame_id, event_index, elapsed,
                     cols, rows, screen, created_at)
invitation(id, email, role, token_hash, token_preview, expires_at,
           max_uses, used_count, revoked_at)
```

`devbox.skills` is the sanitized JSON inventory the connector reports;
`devbox_project` never contains a host path. `agent.cwd` is retained only as a
one-cycle legacy migration bridge. The connector also keeps `local_project` and
`local_skill` SQLite tables locally; the skill table stores scope, project ID,
digest, family targets, and the actual binding paths, none of which belong to the
server schema.

Key constraints:

- `uq_user_external_identity` is a unique index over non-null
  `(auth_provider, external_tenant_id, external_subject)`, ensuring one Microsoft
  principal maps to exactly one user.
- `membership` is unique per `(workspace_id, user_id)`; the last workspace owner
  cannot be demoted or removed.
- Workspace invitations persist only a SHA-256 token hash and a short preview; the
  plaintext link appears once, in the creation response. Invitations are bound to
  a normalized email, accepted once, and can expire or be revoked; re-issuing
  revokes the old, unclaimed link.
- Accepting a workspace invitation creates the membership and marks `accepted_at`
  in one transaction; a concurrent double-accept re-reads the membership after a
  unique-constraint conflict and returns idempotently.
- `runtime_capabilities_json` and `capability_flags` are opaque JSON to the server,
  which does not interpret runtime/model strings.
- `_migrate()` adds missing columns/indexes; `_backfill_workspaces()` creates a
  personal workspace for legacy users and backfills devbox/session ownership and
  owner membership.

### Token rules

- Plaintext format: `hpc_box_<urlsafe>`.
- Appears once, in the create/rotate response.
- SQLite stores only `SHA-256(token)` and a short `preview`.
- The connector WebSocket authenticates with `Authorization: Bearer hpc_box_...`.

### LocalProject rules

- The connector's local `state.db` stores an absolute, unique path for each
  `LocalProject`; that path never leaves the machine.
- The connector reports an authoritative path-free list to
  `POST /api/devboxes/{devbox_id}/projects` using its devbox bearer token.
- The server stores only `id`, `devbox_id`, `name`, and opaque `runtime_config`.
  A project ID cannot be claimed by a different devbox.
- Each agent's optional `local_project_id` must refer to a project on the same
  devbox. Projects missing from a later authoritative report are removed.

---

## 3. Connection model (two WebSocket types)

The server maintains a single **Hub** that manages two kinds of connections:

```python
Conn =
  | HumanConn   { ws, user_id }                       # browser
  | DevboxConn  { ws, devbox_id, agent_ids: set,      # connector
                  outbound: Queue[dict], sender_task, retired }
```

### Human connection (browser)

`GET /ws?session=<cookie>` → validate the sign-in → subscribe to session events
visible to that user.

### Devbox connection (connector)

```text
connector ──WS upgrade, header: Authorization: Bearer hpc_box_...──▶ server
server: validate token
        ├─ invalid/revoked → close(4001)
        └─ valid → resolve Devbox D
                   load D's projects + agents (paths stay on the connector)
                   set all of D's agent presence to online
                   touch devbox.last_seen_at
                   conn = DevboxConn(..., outbound=Queue(maxsize=256))
                   register routing; retire an older connection for the same
                     Devbox with close(4002)
                   enqueue hello first, then an authoritative projects + agents
                     directory from a fresh DB snapshot
```

On disconnect, routing is cleared and agents are marked offline only if the
connection is still the Hub's current mapping; a late `finally` from a replaced
connection does not overwrite the newer connection's state.

Every server → connector frame is enqueued non-blocking and written to the socket
in order by that connection's single sender task. A per-frame send timeout (5s), a
send failure, or a 256-frame queue overflow retires the connection with
close(1011), so concurrent agent add/remove HTTP requests never block on slow
socket I/O. `hello {devbox_id, agent_ids, protocol_version: 3}` is enqueued before
the connection can receive input or a directory update, keeping the first-frame
semantics strict.

> **Why a header instead of `?token=`:** the connector is a local process and can
> set WS upgrade headers, keeping the secret out of URLs and access logs. Browsers
> cannot set WS headers — which is fine, because humans do not use a token.

---

## 4. Authentication and write rules

| Request source | Resolution | Allowed author |
|---|---|---|
| Has `Authorization: Bearer hpc_box_...` | validate → resolve Devbox D | must be an agent with `devbox_id == D.id` (else 403) |
| No token (browser session) | treated as the signed-in human | must be that human (else 403) |

Key points: **a request without a token cannot speak as an agent**, and **a token
can only act as an agent on its own devbox** — cross-devbox impersonation is
impossible.

---

## 5. Core architecture: structured-first, PTY fallback

### 5.1 Two local execution paths

Adapters that support structured output use the native chat path:

```text
Browser composer
  -> generic input + options
  -> Server opaque relay
  -> Connector RuntimeAdapter / StructuredAgentSession
  -> local Claude Code or Copilot CLI
  -> canonical events
  -> Server durable relay
  -> Browser semantic reducer/render
```

Other adapters keep the terminal fallback:

```text
Browser xterm <-> Server byte relay/recording <-> Connector PTY <-> local CLI
```

Model computation, provider login state, and model credentials always stay on the
user's machine. The server never starts a CLI and never interprets runtime ID,
model, effort, or attachments; it only does identity/RBAC/keyboard lease, opaque
frame relay, durable recording, and collaboration broadcast.

### 5.2 RuntimeAdapter and capability facts

The connector's registry is the extension boundary. Each adapter describes:

- runtime ID/label, probe, and local command;
- PTY or structured mode, plus a persistent/per-turn process policy;
- model, permission, and CLI argv mappings;
- the scope, choices, default, and bounds of generic `select` / `file` controls;
- an adapter-local mapping from per-turn options to a persistent runtime's native
  live `control_request`.
- an optional `ContextControl` naming the flags that create and resume a
  provider-owned conversation, plus whether that transcript is bound to the
  working directory (`cwd`) or to the whole machine.

#### Provider-owned context continuity

Conversation history belongs to the runtime CLI, not to AgentBridge. The
connector never replays stored messages into a prompt: it passes its own session
ID to the CLI. Under exclusive native-writer ownership, the connector durably
reserves that ID **before** the first launch, then marks it established after a
successful translated turn. Any subsequent launch with a reservation uses explicit
resume, including failed/interrupted first turns; if the CLI never created the
transcript, resume can fail and the user must start a new session. It never retries
with create or selects the CLI's latest conversation. Marker writes failing after
a turn fence the session and stop its child instead of allowing further input.

Provider event IDs are not compared as an identity proof. Tested Claude output
can include both a fresh internal ID and the requested ID on resume; Copilot's
translated structured stream does not reliably expose a native ID. This does not
assert that every CLI version omits/changes IDs. The tested installed versions
were Claude Code 2.1.119 and Copilot CLI 1.0.84-2, not verified latest releases.
Installation-based capability reporting is not a version/flag compatibility gate.

`connector/native_writer.py` holds a non-blocking OS file lock keyed by runtime
family and session ID, independent of agent, working directory, or local DB path.
It spans persistent-process life and per-turn idle gaps. A flushed active journal
precedes spawn and is cleared only after the owned CLI child is reaped. Closing
waits for late launches and drains pipes; repeated cancellation cannot discard a
child handle. An orphaned/uncertain writer is **not** reclaimed by PID checks or
TTL: later launches fail closed and require explicit local recovery. This protects
cooperating, updated AgentBridge connectors under the same OS user/shared state
root, not manually launched CLIs, older connectors, or other machines.

Transport reattachment to a surviving sessiond is not native recovery. Isolated
CLI tests verified recall through a fresh supervisor/local store, not a complete
browser/server/sessiond restart. The current local Rename/explicit Resume changes
do not add live Workspace, real-CLI acceptance, or deployment evidence. A lost
transport preserves surviving provider processes; reconnect does not request
native resume.

Resuming fails closed. When the recorded runtime or, for a `cwd`-scoped runtime,
the project directory no longer matches, the turn stops with an explicit error
rather than silently starting an empty conversation under a visible transcript.
Runtimes without a `ContextControl` report `context.continuity="process"`, which
tells the reader that history survives only as long as that process does.

After probing, the connector reports a display-safe capability object. A stable
revision ignores probe timestamps; a dynamically discovered model catalog is
projected into each surface's model control. When live discovery is unavailable or
returns no model ID, the connector keeps that family's static adapter catalog and
marks `models.status=partial`, `models.source=adapter`; with a runtime result it
marks `complete/runtime`. Only a reliable non-interactive authentication-status
probe can block startup; when a safe probe is impossible the status is `unknown`.
Codex deliberately declares no auth-status probe: account-level `login status`
cannot validate the provider/profile/project configuration chosen by an actual CLI
launch. Its authentication remains `unknown` (not success); the native CLI handles
provider authentication. This adds no server-side provider parsing and does not
weaken installation, compatibility, surface, role, or keyboard-ownership checks.
The server stores the capability as opaque JSON, consulting only generic lifecycle
and context feature keys for explicit Resume. The browser chooses the chat
surface from `features.structured` and generates model/reasoning/file widgets from
`features.controls`. Model choices fall back in order: per-control choices,
`features.models`, then family `models.items`. The UI always offers a
`Runtime default`, and shows an editable model-ID combobox only when a model
control declares `allow_custom=true`. The connector-local executable path is not
reported, and the browser has no runtime-ID special cases.

The extension principle stays: **a new runtime is one connector adapter; the
server and browser do not change.**

### 5.3 Canonical event contract

Structured adapters emit only a unified set of events upstream:

- `status`
- `session.config`
- `user.echo`
- `message.delta` / `message`
- `tool.call` / `tool.result`
- `permission.ask`
- `turn.end`
- `error`

Events carry only the display-safe fields the UI and restore need — never raw
provider payloads, chain-of-thought, tokens, model credentials, or workstation
paths. Each logical turn records at most one `turn.end`; a streaming start and a
completed snapshot for the same `tool_id` update the same tool card in the reducer.
The connector suppresses a provider's full-text snapshot resent after deltas, and
the browser renders `turn.end.result` only as a fallback when the turn produced no
assistant message, so the result never duplicates an already-streamed reply. Live
frames and restore JSONL use the same reducer.

### 5.4 Frame protocol v3

| Direction | Frame | Meaning |
|---|---|---|
| Browser → Server | `attach {session_id, surface?}` | restore/watch; only a never-started new row may request its initial launch |
| Browser → Server | `resume {session_id, launch_id}` | explicit continuation of the same native conversation; observed generation required |
| Browser → Server → Connector | `input {data, options, client_input_id}` | PTY bytes or a structured turn; options are opaque to the server |
| Browser → Server → Connector | `resize` / `terminate` | terminal controls require the keyboard lease; structured termination requires current Operator/Admin/Owner access, without a lease |
| Server → Connector | `open` / `resume` | initial launch / require existing native context; distinct controls, with `launch_id` |
| Connector → Server | `output {seq, pty_instance_id, kind, data}` | `kind` is `output` or `event`; ACK after a durable commit |
| Server → Browser | `restore {kind?, data}` | terminal screen bytes, or `kind:event` canonical-event JSONL |
| Server → Browser | `output {kind, data}` | live terminal bytes or a single canonical event |

Structured options and attachments are re-validated in the connector against the
adapter descriptor; the server does not turn the capability blob into a business
schema. Output reliability still comes from the connector's spool, monotonic `seq`,
the server ACK, a `resend` carrying `expected_seq`, a `fence` for an old instance,
and fail-closed handling of payload-hash conflicts.

For lifecycle-capable sessions, one opaque `Session.launch_id` fences controls,
ready, exit, and process snapshots. Initial launch, Resume, and End rotate it;
Rename does not. Delayed controls cannot target a later run, and a stale snapshot
entry cannot downgrade an accepted newer active generation. Old structured-instance
output still enters the durable ledger and is ACKed, but is not fanned into the
new live conversation.
This does not replace the `(session_id, pty_instance_id, seq)` delivery identity or
the connector's native-writer lock.

### 5.5 Restore and reconnect

- Opening nonlive History is read-only: attach/reload (including legacy `open`)
  never automatically opens a historical CLI. Attaching an already live session
  restores/watches it without sending a duplicate connector `open`.
- Explicit `/ws/term` `type: "resume"` requires current Operator/Admin/Owner
  access and a `launch_id` field matching the observed metadata token (including
  explicit `null` if that is the observed value). A stale/missing token is rejected
  as `session_changed`. The same session, agent, and native conversation ID are
  retained; there is no replacement-session or create fallback.
  If the process became live meanwhile, the server replies with matching-token
  `type: "status", state: "live", reattached: true` without rotating the token or queuing a launch.
  This explicit acknowledgement also covers that race in the browser.
- Resume is capability-driven: the stored structured surface must report
  `features.session_lifecycle: 1`, `context.continuity: "native_resume"`,
  `context.available: true` (installed), and `context.explicit_resume: true`.
  Unsupported/terminal historical restart is refused; New session is explicit.
  The connector still validates local availability and the existing context marker.
- `ready` is logical readiness, not proof that native history was restored.
  The browser already displays this limitation while Resume is preparing.
  `context_resume: "pending"` tells the user that the next real message resumes the
  CLI conversation; a lazy/per-turn launch may only then detect a missing provider
  transcript. Failure is visible, never repaired by reconstructing a prompt.
- Terminal attach: the server restores the current screen from pyte/recording, then
  streams live bytes.
- Structured attach: the browser first enters chat from capability; the server
  returns the latest durable event JSONL tail (up to 4 MiB), then streams live
  events. That tail is an authoritative snapshot of the current bounded replay
  window: the browser resets, then folds line by line, and a single bad line does
  not break the later timeline. Helpers load before the app, and chat mounts
  synchronously. View and socket guards discard late results from old views.
- The connector WebSocket uses a 30s open timeout, 20s ping, 60s pong tolerance, 5s
  close timeout, and a 16 MiB frame bound; after an abnormal disconnect the outer
  loop keeps backing off, reconnecting, and resuming the spool.
- Genuine session-scoped controls such as permission and reasoning lock once the
  session is configured or the first chat item appears. `New chat` creates an
  empty persisted session and reopens the controls without terminating another
  collaborator's conversation. `End session` is explicit and confirmed; prior
  history is not deleted. The resulting ended state is logical, not confirmation
  that the local child has been reaped; native-writer cleanup remains local.
- The Claude structured model is turn-scoped; when the value changes the connector
  first sends a `set_model` `control_request` to the same process and waits for
  success before sending the next prompt, so explicit models can still be switched
  after the first turn. The protocol cannot clear an already-set model; returning
  to `Runtime default` requires `New chat`.

### 5.6 LocalProjects and user skills

- `agentbridge project add <path> --name <name>` writes a canonical absolute path into
  the connector-state `state.db`. The default root is `%LOCALAPPDATA%/deepbox` on
  Windows and `${XDG_STATE_HOME:-~/.local/state}/deepbox` on macOS/Linux. The
  server's `DevboxProject` holds only ID, name, and non-sensitive `runtime_config`.
- Add-agent refreshes the runtime/project inventory each time it opens, and lets
  you pick a `local_project_id`. Its "Add a local project" action only generates a
  copyable command; neither the browser nor the server browses or modifies the host
  filesystem.
- A skill root must contain a UTF-8 `SKILL.md`. The YAML frontmatter is parsed with
  `yaml.safe_load` and requires a lower-kebab-case `name` and a string
  `description`, with the directory basename equal to `name`. The tree is capped at
  256 regular files / 10 MiB; traversal, symlink/junction/reparse, and any change
  during reads are rejected. Scripts are only flagged as `contains_scripts`;
  agentbridge never executes them.
- A skill's scope is `personal` or a registered LocalProject. `--project` resolves
  by ID, unique case-insensitive name, or exact normalized path; no value is
  equivalent to `--project .`, resolving to the longest containing project by
  `commonpath`.
- An adapter family declares personal/project skill roots, and one family target
  can map to several roots. Claude Code binds both `.claude/skills` and
  `.agents/skills`; Copilot/Codex use `.agents/skills`. Re-discovering roots merges
  old bindings without leaving orphans.
- The source of truth is
  `<connector-state-root>/skills/store/<digest>/<name>/`. Install double-validates
  and hashes, then atomically replaces every destination from a staging area, with
  rollback on failure. `list`/`inspect` validate the store and then the bindings,
  returning `installed` / `drifted` / `missing`; install/remove that hits drift
  requires an explicit `--force`. After the last reference is removed, the store
  digest is garbage-collected.
- The connector reports only
  `{id, name, description, digest, scope, project_id, targets, contains_scripts, status}`.
  The server accepts no path; while a skill is still referenced, both the local and
  the server-report reconciliation refuse to delete the project.

---

## 6. REST API (core)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/auth/config` | none | Enabled local/Microsoft sign-in methods |
| `POST` | `/api/auth/login` | none | Password sign-in for `local/hybrid` |
| `GET` | `/api/auth/microsoft/start` | none | Redirect to `/.auth/login/aad` |
| `GET` | `/api/auth/microsoft/callback` | Easy Auth headers | tenant+subject upsert, issue compatible session cookie |
| `GET` | `/api/auth/microsoft/logout` | none | Clear cookie, redirect to `/.auth/logout` |
| `GET` | `/api/me/user` | Cookie | Current user profile and accessible workspaces |
| `GET` | `/api/me` | Bearer devbox token | Devbox identity, protocol version, projects, and agents |
| `GET/POST` | `/api/workspaces` | Cookie | List memberships / create a workspace (creator is owner) |
| `GET/POST` | `/api/workspaces/{id}/members` | Cookie + workspace role | List members / add an existing user |
| `PATCH/DELETE` | `/api/workspaces/{id}/members/{user_id}` | Cookie + admin/owner | Change role / remove member, protecting the last owner |
| `GET/POST` | `/api/workspaces/{id}/invitations` | Cookie + admin | List / create an email-bound invitation; an admin cannot grant admin |
| `DELETE` | `/api/workspaces/{id}/invitations/{invite_id}` | Cookie + admin | Revoke an unclaimed invitation |
| `POST` | `/api/workspace-invitations/preview` | none | Submit a token in the body; returns workspace/role/masked email |
| `POST` | `/api/workspace-invitations/accept` | Cookie | Atomic accept after strict email match; repeat submits are idempotent |
| `GET/POST` | `/api/devboxes` | Cookie + workspace role | Aggregate devboxes across the user's workspaces / create one in a workspace |
| `POST` | `/api/devboxes/{id}/tokens` | Cookie + workspace admin | Issue a new connector token |
| `DELETE` | `/api/devboxes/{id}/tokens/{token_id}` | Cookie + workspace admin | Revoke a connector token |
| `POST` | `/api/devboxes/{id}/agents` | Cookie + workspace admin | Create an agent; agent lists are embedded in `GET /api/devboxes` |
| `GET/POST` | `/api/agents/{id}/sessions` | Cookie + workspace role | List / create a shared session |
| `GET` | `/api/sessions/{id}` | Cookie + workspace role | Current title, launch token, state, and action availability |
| `PATCH` | `/api/sessions/{id}` | Cookie + current Operator/Admin/Owner | Metadata-only Rename: `{title, expected_title}`; stale title returns 409 |
| `GET` | `/api/sessions/{id}/messages` | Cookie + participant/role | List persisted structured messages; sending uses the session WebSocket |
| `POST` | `/api/devboxes/{id}/projects` | Connector token | Replace path-free LocalProject metadata; handle one-cycle legacy migration and refuse to delete a project still referenced by a skill |
| `POST` | `/api/devboxes/{id}/skills` | Connector token | Replace the sanitized skill inventory (up to 256 items, no paths) |

Rename trims surrounding whitespace, then requires `title` to be a single line
of 1–120 characters without control/line separator characters. Only `title` and
the exact observed `expected_title` are accepted; the update is an atomic
compare-and-swap. It changes no session, agent, or native ID, launch token,
recording, or local context marker and sends no CLI
command. `session.updated` notifies attached views; a conflict preserves the edit
for an explicit refresh/retry.

The trust boundary for Microsoft sign-in is Azure App Service Easy Auth: the
platform verifies OAuth/OIDC and then injects `X-MS-CLIENT-PRINCIPAL*` headers. The
app never receives a browser Microsoft bearer token and never stores
access/refresh tokens; deployments that are not on App Service, or that have not
correctly enabled Easy Auth, must keep `AGENTBRIDGE_AUTH_MODE=local`. When Microsoft
sign-in is enabled in production, `AGENTBRIDGE_MICROSOFT_ALLOWED_TENANT_IDS` must be
set, and the app re-checks the platform principal's tenant claim against that
allowlist; `microsoft` mode also requires an explicit owner-email allowlist and
`AGENTBRIDGE_PUBLIC_URL`. Legacy `DEEPBOX_*` values remain valid when the matching
canonical key is absent; an explicit empty canonical value never reveals a legacy
value. This does not change the existing Azure/domain/Entra callback identities.

The workspace invitation token lives in the URL fragment
`#workspace-invite=...`, so it is not sent with the first HTTP request. The
frontend stashes it in `sessionStorage` only to survive the OAuth redirect, and
preview uses a POST body, keeping the token out of query strings and ordinary
access logs.

---

## 7. Connector package (`connector/`, Python)

A user-launched process, installed once and started with `agentbridge connect`
only after explicit user setup. `deepbox` remains a CLI alias. The launcher runs
`connector.cli` from the caller's current directory; normal connects run no install
logic. Only explicit install/upgrade refreshes the application. Existing `.deepbox`
or custom roots are reused under the [home compatibility rules](agentbridge.md#environment-and-home-compatibility),
not moved. See [install](install.md); source development can use `python -m connector`.

Startup flow:

1. `GET /api/me` fetches the authoritative agent and path-free project directory,
   and rejects a protocol version mismatch.
2. Report projects and sanitized skills from the local `state.db`; the registry
   probes runtime families, builds a display-safe capability object, and
   `POST`s `/runtimes`.
3. Start the inventory watcher; when an external CLI changes a project/skill, the
   connector re-reports the metadata automatically.
4. Open the WebSocket with the Bearer token and receive `hello` plus the
   authoritative directory.
5. On `open`, create a `StructuredAgentSession` or `PtySession` per adapter; only
   the connector resolves `local_project_id` into a launch `cwd`.
6. Structured input goes through `write_turn(data, options)`; PTY input writes
   stdin. Both output kinds enter the local durable spool first, then wait for the
   server's commit ACK, and resume exactly after a disconnect.
7. Both WS entry points share the 30s open, 20s ping, 60s pong, 5s close, and
   16 MiB frame policy.

---

## 8. Web client (`web/`)

The single-page workbench provides compact navigation, native chat, terminal, and
read-only saved history without a recording player. `app.js`/`main.js` compose the
shell; API/dialogs/management are separate
from the split-tree/workbench/pane lifecycle. Each pane owns its socket and surface,
not a singleton session stage. See the [module map](implementation.md#5-web-web).

Users split right/below in a binary tree (maximum four panes), adjust row/column
ratios by pointer or keyboard, and select/maximize/close independently. Close only
detaches. User/workspace layout preferences store geometry and whitelisted target
IDs/surface/kind, never conversation/file/token/role data or `forceNew`. Restoring
missing or ended live targets never implicitly creates sessions.

Surface behavior retains the existing capability and backend authorization rules:

- when a capability reports `features.structured`, it enters chat before the first
  frame, and canonical events drive the reducer/render;
- generic `select`/`file` descriptors generate model, reasoning, and attachment
  widgets; once a session locks, `New chat` reopens them without ending the old session;
- Add-agent refreshes the runtime/project inventory, picks a LocalProject, and only
  generates a copyable `agentbridge project add ...` command;
- the Skills modal shows only the path-free inventory and connector-local CLI
  commands;
- re-attaching a pane folds durable event JSONL, then continues with live events;
- non-structured runtimes continue to render raw PTY bytes with xterm.js. Its
  existing pinned jsDelivr assets load on demand through `terminal-assets.js`, not
  during chat/app boot. Failure is visible before session creation; no new vendor
  downloads or remote fonts were introduced. Local helpers load deterministically.

---

## 9. Status and roadmap

- **Existing baseline foundation and reliability:** local account lifecycle, Microsoft Easy
  Auth identity mapping, email-bound workspace invitations, Workspace → Devbox →
  Agent navigation, connector hot registration, Protocol v3 durable
  spool/ACK/resend/fence, DVR/retention, workspace RBAC and keyboard lease, and
  Azure deployment.
- **Current local draft:** phased agentbridge naming, a plain transcript/list UI,
  independent user-controlled panes, and metadata-only Rename/explicit native
  Resume on the retained structured/PTY architecture.
  Visual/code acceptance and integrated verification are pending in [review](review.md).
- **Next:** real multi-machine end-to-end tests, more adapters, auditable runtime
  permissions, long-running tasks/notifications, and production capacity controls.

---

## 10. The core loop

```text
Human input/options
  -> Server (identity, collaboration, opaque relay)
  -> Connector (adapter validation + local model CLI)
  -> terminal bytes or canonical event
  -> Connector spool
  -> Server durable commit + ACK + broadcast
  -> xterm fallback or native chat
```

The server never runs a model, reads a model key, receives a LocalProject/Skill
path, executes a skill file, or interprets the model/reasoning business meaning
inside a capability.
