# AgentBridge Product Design

**The user has authorized release of the current workbench.** Visual exploration
continues separately and is not a reason to deploy the static candidates. See
[review](review.md) and the [repository/installation contract](agentbridge.md).
The canonical repository and production installation source is
[yusx-swapp/AgentBridge](https://github.com/yusx-swapp/AgentBridge);
`yusx-microsoft/AgentBridge` is only a fork. Repository/installer branding does not
rename Azure resources, domains, authentication or installed data, or move the
existing `C:\Code\deepbox` worktree. Publication and rollout require separate evidence.

**AgentBridge** is the display name; `agentbridge` is the lowercase CLI/package
identifier, with `AGENTBRIDGE_*` environment keys. Display polish changes no
auth, cookie, hash, IPC, or persistent identity contract.

> AgentBridge is a **durable session control plane** for AI coding agents. Users connect the
> agent CLIs already running on their own devbox — Claude Code, Codex CLI, GitHub Copilot
> CLI — to the platform, then view, drive, resume, and inspect saved sessions from any
> browser.
>
> This document is the durable product specification. For technical architecture see
> [`design.md`](design.md); for the current code state see [`implementation.md`](implementation.md);
> for delivery sequencing see [`planning.md`](planning.md).

---

## 1. Positioning

**One-line positioning.** One place for people and teammates to find and operate
agents distributed across many local or remote devices, with access shared through
Workspaces instead of visiting every host separately.

The design must work toward inventories such as 100 agents across multiple
machines. Priorities are device/agent discoverability, search/filtering, online and
session state, safe remote interaction, and shared Workspace permissions. This is
not primarily a tool for agents to talk to or review one another. The current
four-pane viewing cap is not a product inventory limit or proof of a 100-agent load test.
Sessions should remain reachable when a browser closes or the server restarts.

### 1.1 What we provide

- A **server** control plane: identity, devbox and agent registry, session lifecycle,
  presence, routing, recording, and permissions.
- A **connector** the user runs on their own machine, bridging the local agent CLI and the
  server.
- A **web workspace** to browse agents, start and resume sessions, chat with structured
  runtimes, drive the terminal fallback, and view saved history.

### 1.2 What we do not provide

- The server never runs models and never holds Claude / OpenAI / GitHub API keys.
- The server does not install or sign in to agent CLIs on the user's behalf.
- The server does not read the user's filesystem; only the agent on the user's devbox can
  reach the working directory.
- AgentBridge is not a cloud IDE, code editor, or general SSH replacement.

### 1.3 Core principle

> **The server is a platform, not an AI product. Intelligence, credentials, and the
> workspace all stay on the user's devbox.**

### 1.4 Why not a plain web terminal

Remote terminals are a solved commodity. AgentBridge's value is not "show a shell in a browser."

| Plain web terminal | AgentBridge |
|---|---|
| Manages a connection | Manages an agent session lifecycle |
| Depends on local shell/tmux after the window closes | Sessions live independently of any viewer |
| Unaware that an agent exists | Explicit runtime, agent, state, and capability model |
| Scrollback is local, ephemeral | Server persists screen state and a durable recording |
| Single-user terminal | Multiple viewers, control leases, and audit |
| No task semantics | Structured runtimes emit canonical agent events |

The transport underneath is a PTY, but the core product object is the **session**.

---

## 2. Personas

### 2.1 Primary users

- Developers working across multiple machines, workstations, or cluster login nodes.
- Developers running long-lived agents such as Claude Code or Codex CLI.
- People who need to check on an agent's progress after leaving their computer.
- Users switching work between Windows, Linux, and remote GPU/HPC nodes.

### 2.2 Secondary users

- Small teams managing several devboxes.
- Organizations that need agent work records, audit trails, or reproducible sessions.

### 2.3 Jobs to be done

1. When an agent runs on my office devbox, I want to view and keep driving it from another
   computer.
2. When a browser closes or the network drops, I do not want to lose the agent session or
   its output.
3. With several agents and devboxes, I want to know which is online, which is working, and
   which is waiting for input.
4. When a task finishes, I want to read its saved transcript or final terminal screen
   without restarting the agent.
5. When collaborating, I want others to view a session while preventing several people from
   typing into it at once.

---

## 3. Object model

```text
User / Workspace
  └── Devbox
       ├── Connector + reported runtime capabilities
       └── Agent
            └── Session
                 ├── Live terminal or structured chat
                 ├── Viewers + keyboard lease
                 ├── Structured events / permission prompts
                 └── Durable recording / read-only history
```

- **User** — a person who signs in. Local username/password sign-in is supported; Azure
  deployments can front the app with Entra / Easy Auth against a tenant allowlist.
- **Workspace** — the collaboration and permission boundary. Every user has a personal
  workspace and may create more. The left rail is organized **Workspace → Devbox → Agent**.
- **Devbox** — the user's machine running the connector; the infrastructure and auth unit.
  A user may own many devboxes; a devbox may host many agents. Devboxes authenticate with a
  hashed bearer token and are never message authors.
- **Agent** — a path-free launch profile: handle, runtime adapter, connector-local project
  ID, non-secret runtime config, and host devbox. Absolute paths, skill contents, model
  credentials, and CLI login state remain on the connector.
- **Session** — durable context around an agent-process lifetime. Its database row stores
  the agent, owner/workspace, surface, title, retention policy, and creation time. APIs add computed
  live and recording metadata. The process lives on the connector; a viewer leaving does not
  end it.
- **Viewer** — a browser attached to a session. Viewers attach and detach freely, do not
  own session lifecycle, and can be many at once. Terminal input needs the keyboard
  lease. Structured messages need Operator/Admin/Owner, independently of that lease.

---

## 4. Session lifecycle

### 4.1 Session state

The session row does not persist a transition state machine.
`GET /api/agents/{agent_id}/sessions` derives a small presentation state:

- `live` when the hub currently tracks the agent/session pair;
- `ended` when the in-process live registry observed the process exit;
- `inactive` otherwise.

A connector or browser disconnect does not delete the session or its recording. The
connector may retain the process and replay spooled output after reconnect.

### 4.2 Lifecycle actions

| Action | Semantics |
|---|---|
| New session / New chat | Create a durable session and start a fresh local process on attach |
| Open agent | Resume a live session matching the chosen surface; create one when none matches |
| Detach | Close this viewer only; keep the local process running |
| Terminate | Explicitly request process shutdown; terminal requires the keyboard holder, structured requires current Operator/Admin/Owner access |
| View history | Read the saved transcript or final terminal screen without starting a process |

A WebSocket close is not process death. Multiple viewers may attach. A terminal has
one active keyboard holder; a structured chat can accept messages from every Operator
or above. Read-only Viewer grants never gain input access.

---

## 5. Structured-first chat and terminal fallback

AgentBridge is structured-first: when an adapter reports a structured capability, the browser
opens a native chat before the first frame instead of scraping ANSI text.

### 5.1 Two local execution paths

- **Structured runtimes** (headless / JSON) drive the native chat UI. The connector's
  runtime adapter runs a `StructuredAgentSession`, emits a canonical event stream, and maps
  per-turn options to native control requests. The server checks only generic lifecycle/
  context features for Resume; the browser renders the generic feature/control schema.
- **Legacy / TUI runtimes** fall back to `xterm.js` rendering raw PTY bytes, with resize
  and reconnect restore. Saved history shows the final terminal screen without playback.

The browser uses the session's explicit `surface` and generic reported capabilities,
not runtime names. Choosing **Terminal** never reuses a Chat or unknown-surface session.

### 5.2 Whose memory is it?

A conversation's history lives inside the agent's own CLI on the user's machine.
AgentBridge keeps the transcript people read, but it never rebuilds the model's
memory from those stored messages: doing so would resend other teammates' text
and drift from what the CLI actually knows. Instead the connector hands the CLI
the stable session identifier and asks it to continue its own conversation.
AgentBridge does not inject a second copy of history; native resume can still
consume context tokens and incur normal provider charges.

This also means continuity has limits worth showing honestly. A conversation can
belong to a specific project directory. Moving an agent elsewhere refuses resume
rather than ending or deleting the old conversation; restore the binding or
start a new session. Native-writer ownership prevents two cooperating connectors
from writing that conversation concurrently. Uncertain crash recovery requires
explicit local confirmation, not an automatic lease timeout.

**Current local changes:** Rename and explicit Resume are implemented separately
from read-only history; this is not new live Workspace/real-CLI acceptance or a deployment claim.

- **Rename** changes only the display title, from a live header or History.
  Current Operator/Admin/Owner access is required. Titles are trimmed, single-line,
  1–120 characters; a concurrent title change returns a conflict rather than
  overwriting it, and the dialog retains the draft for refresh/retry. Session,
  agent, native conversation ID, recordings, and local context markers do not change.
- **View history** is read-only for a nonlive session and never starts a CLI.
  **Attach live** watches the existing run without a duplicate open. **Resume** is
  an explicit, generation-checked continuation of the same session on the same
  agent, requiring current Operator/Admin/Owner access, not a new-session shortcut;
  stale views must refresh before retrying.
- Resume is enabled only by installed generic structured native-resume capability
  plus lifecycle support. Unsupported/terminal historical restart is refused with
  a reason; the user can explicitly choose **New session** instead.
- **Ready** means logical readiness, not confirmed restoration of native history.
  Preparation explains that the next real message resumes the CLI; a lazy/per-turn
  runtime may discover a missing provider transcript only then. Failures stay
  visible with safe guidance, never raw local marker errors or silent recreation.

### 5.3 Structured chat controls

- Controls are capability-driven. Generic `select` / `file` descriptors render the model,
  reasoning, and attachment widgets; the UI always offers a **Runtime default** and only
  shows an editable model combobox when the adapter allows a custom model ID.
- When live model discovery is unavailable, the connector falls back to the adapter's static
  catalog. **Runtime default** sends no `--model`.
- Session-scoped controls (permission, reasoning) lock once the session is configured or the
  first chat item appears.
- For runtimes where the model is a per-turn control (e.g. Claude), later turns can switch
  models; the protocol cannot clear an already-set model. Returning to **Runtime default**
  requires **New chat**.
- **New chat** creates a fresh persisted session and reopens the controls without
  terminating a session other collaborators may still use or deleting prior history.
- Operator/Admin/Owner may send chat messages without acquiring the terminal keyboard.
  Viewer remains read-only. New invitation forms explicitly select Operator; the API
  default is still Viewer, and existing Viewer grants are never automatically promoted.
- **End session** is a separate confirmed action. Current Operator/Admin/Owner access
  permits structured termination without a keyboard lease; Viewer cannot terminate.
  Terminal input, resize, and termination are holder-only, including for an
  Admin/Owner. Closing a pane only detaches; New chat preserves the old shared session.
  End is a logical state change, not confirmation that the local CLI was reaped;
  native-writer safety checks still apply to a later Resume.
- Membership role changes require explicit **Save**. Management dialogs capture their
  user/workspace context and reject stale asynchronous results; no automatic grants.

### 5.4 Terminal experience (fallback)

The terminal surface must preserve: native ANSI/truecolor, cursor and resize, mouse and
shortcuts when the runtime supports them, bounded scrollback restore on attach, a visible
reconnect state that does not obscure the agent TUI, and a clear live/recording indicator.

---

## 6. Core user flows

### 6.1 First devbox onboarding

```text
Register / sign in
→ create a devbox
→ platform shows a one-time token and install command
→ user runs the connector on their own machine
→ connector probes runtimes/versions/capabilities
→ devbox, projects, and runtime capabilities appear
→ user registers an agent
```

The platform never pre-runs the connector, creates local processes, or touches local
credentials on the user's behalf. Install once, then reconnect with
`agentbridge connect` (`deepbox` remains an alias); upgrades are the explicit `agentbridge upgrade`. See
[`install.md`](install.md) and [`onboarding.md`](onboarding.md).

### 6.2 Create an agent

```text
Choose a devbox
→ pick a probed runtime and an optional connector-reported local project
→ set the handle
→ save the path-free agent definition
```

Any secret comes only from the connector's local environment and is never stored on the
server.

### 6.3 Start a session

```text
Open an agent
→ browser checks for the newest live session
→ if none exists, server creates a durable session row
→ browser attaches and connector starts the local process
→ browser shows native chat or the live terminal
```

### 6.4 Attach live or explicitly resume

```text
Open an agent with a live session
→ viewer attaches to the same session ID
→ server restores structured events or terminal output; no duplicate CLI open
→ live output resumes
```

```text
Open History for a nonlive session → read-only history
→ choose Resume (current role, capability and observed launch token checked)
→ connector validates the existing local context and prepares the same native ID
→ logical ready; the next real message may perform the provider's native resume
```

Neither lost transport nor reconnect requests Resume. Transport reattachment
preserves surviving providers; failed historical resume never creates a replacement
session or reconstructs the provider's transcript from the displayed history.

### 6.5 Server restart

```text
Server stops
→ connector process keeps running and spools output locally
→ Server recovers
→ connector reconnects and reports surviving sessions
→ output is replayed from the last acknowledged point
→ viewers reconnect automatically and restore
```

### 6.6 View saved history

```text
Open History for an agent
→ choose a session's View history action
→ load saved metadata, events, and checkpoints
→ immediately show the full Chat transcript or final Terminal screen, read-only
```

There are no playback, seek, speed, recording download, or retention/deletion
controls in the workbench. Existing recordings and server-side retention/export/
erase APIs remain intact. Reading history is not Resume and never starts an agent.

---

## 7. Information architecture

### 7.1 Layout

```text
App shell
├── Refined top navigation: workspace, management, theme and account
├── Compact collapsible sidebar: Workspace → Devbox → Agent
└── Workbench: one to four panes in a user-defined binary split tree
    ├── Pane: quiet header and controls, chat / terminal / saved history
    └── Row/column separator + sibling pane or nested split
```

The current draft returns to the pre-tmux split workbench, with visible navigation
and pane controls rather than a terminal-shaped shell. Restrained sans-serif UI
type, monospace code/data, subtle borders and deliberate spacing support light and
dark themes. No green tmux status bar or forced full-screen TUI. Conversations stay
uncluttered, without dashboard cards, bubbles, or repeated role chrome.
Each pane is independent: split right/below, select, maximize/restore, or close;
drag a separator or focus it and use axis arrow keys (`Home` resets the ratio).
The four-pane limit bounds complexity without imposing a fixed side-by-side layout.
Unsent drafts remain pane-local across focus, resize, and split actions; they are
not written into layout preferences or shared with another pane.

User/workspace-scoped preferences retain layout geometry and target IDs/surface/kind,
not messages, files, tokens, or roles. Restore never carries `forceNew` and never
auto-creates sessions for missing or ended saved live targets. Pane teardown owns
its socket/chat/terminal/history resources; closing is not session termination.
See [implementation](implementation.md#5-web-web) for the actual module boundaries.

### 7.2 Session control surface

The pane header shows its name, surface and connection state, with compact controls
and explicit permission/keyboard context. Opening an agent resumes
its newest compatible live session or creates
one when none is live. History lists sessions with their creation time and derived
state, and separates View history, Attach live, and explicitly supported Resume.

### 7.3 Optional tmux-style shortcuts and command prompt

These are **opt-in and default off**, not the primary navigation or visual shell.
Without user enablement, Control+B is not intercepted. When enabled, Ctrl+B
activates a visible prefix state. `%`/`"` split, arrows select adjacent
panes, `o` cycles, digits select a pane, `z` zooms, and `x` detaches a view without
ending its agent. `w` opens the tree, `s` chooses workspace, and `?` lists bindings.
Double Ctrl+B forwards one literal prefix byte only to an owned live terminal.
The `:` prompt parses an allowlist of UI actions, never OS/model commands.
See [the optional key contract](agentbridge.md#optional-tmux-style-interaction).

Visible sidebar, pane, and management controls remain usable with shortcuts off.
Ctrl+K outside editable areas remains a compatible shortcut for quick navigation.

The optional tree picker filters panes, agents and machines without routing away.
`↑` / `↓` select, `Enter` opens, and `Esc` closes. It supplements the collapsible
sidebar rather than replacing it or forcing a full-screen workflow.

### 7.4 Modals and one-time tokens

Create/delete flows, confirmations, and errors use in-app modals rather than the browser's
`prompt/alert/confirm`. A one-time devbox token is rendered only into the modal DOM in
memory — never written to storage, cookies, URLs, or logs — and offers one-click copy of the
raw token or the full connector command.

---

## 8. Workspaces, collaboration, and permissions

- Resources are scoped by workspace; every user has a personal workspace and may create more.
- Four roles constrain all resources: `viewer` (read-only), `operator` (can chat and
  drive a terminal while holding its keyboard), `admin`, and `owner`.
- Workspace owners/admins issue single-use, expiring, email-bound invitation links. The
  deployment owner separately manages local-account invitations, disabling, and re-enabling.
- Multiple viewers may watch a terminal, but only one holds the **keyboard lease**. Others can
  request control; the current holder can hand it off; the lease releases automatically on
  timeout or disconnect. Lease actions: `Request` / `Take keyboard` / `Release` / `Hand off`
  (viewers remain read-only).
- Structured conversations do not acquire or renew a keyboard lease. Operator/Admin/Owner
  can send messages and permission replies without taking control from another collaborator.

---

## 9. Projects and skills

Projects and skills are registered on the machine running the connector; absolute paths stay
in the connector-local state store, and the server only receives stable IDs and display names.

- **LocalProject** — register a project directory locally. The browser's Add-agent flow only
  produces a copyable `agentbridge project add …` command; it never browses the local filesystem.
- **Skills** — a skill is a directory containing a UTF-8 `SKILL.md`, whose directory name
  must equal the lower-kebab-case `name` in the YAML frontmatter. Skills install to personal
  scope by default, or to a registered project scope with `--project`. The connector copies
  content into its own skill store and each adapter family's skill roots; AgentBridge never
  executes skill files, and the server only stores path-free inventory.

Full schema, limits, scope resolution, and drift rules are in
[`install.md`](install.md#local-projects-and-skills).

---

## 10. Data and reliability

### 10.1 Two kinds of data

1. **Control-plane data** — users, devboxes, agents, sessions, permissions, and state, kept
   in a relational database.
2. **Terminal/event stream** — input/output/resize/exit, kept in an append-only recording
   with checkpoints.

### 10.2 Current screen vs. full history

- Current screen: a bounded in-memory screen model for fast restore.
- Full history: an asciicast v2 durable recording (DVR) for replay and audit, growing over
  time.
- Checkpoints avoid replaying a long recording from the start.

### 10.3 Durable delivery

The frame protocol (v3) targets acknowledged, deduplicated delivery:

```text
connector local spool
→ frame(session_id, pty_instance_id, seq)
→ server persists
→ ACK(session_id, pty_instance_id, seq)
→ connector drops the local record
```

The server deduplicates on `(session_id, pty_instance_id, seq)` so retries never duplicate records.

### 10.4 Sources of truth

- Live process state: the devbox session supervisor.
- Durable metadata: the server database.
- Persisted output: the recording store.
- The browser is never a source of truth for any session state.

---

## 11. Runtime extensibility

Runtimes are declared in the connector registry. Each `RuntimeAdapter` supplies a stable ID
and label, family and surface, validated launch/model/permission metadata, probe hints,
generic control definitions, and skill roots. Adding a runtime must not require a
runtime-specific server or web branch. Built-in adapters are `claude-code`,
`codex-cli`, `copilot-cli`, `claude-code-structured`, and `copilot-cli-structured`.
The server stores capability blobs and checks generic lifecycle/context keys for
Resume; the web renders their generic schema, without runtime-name branches.

---

## 12. Security and privacy

### 12.1 Non-negotiable boundaries

- API keys and CLI login state never reach the server.
- Token storage keeps only hashes.
- An agent can only speak/emit output under the identity of its host devbox.
- Recording access is always checked against session/workspace permissions.
- Users must know when a session is being recorded.

### 12.2 Baseline controls

- Argon2id password hashing with transparent upgrade of legacy hashes.
- Signing secrets from environment/secret manager; HTTPS/WSS transport.
- Secure/HttpOnly/SameSite cookies; CSRF and WebSocket Origin validation.
- Production Origin allowlist, layered rate limits, and security headers.
- Redacted JSON audit logging.
- Token rotation and revocation that disconnect immediately.
- Recording retention and secure erase via server APIs for workspace admins and owners.

### 12.3 Recording privacy

Terminal output can contain code, internal paths, URLs, environment details, and even
accidentally printed secrets. Sessions are durably recorded with a per-session retention
policy. Workspace members may view recordings according to workspace RBAC; workspace
admins and owners may change retention or securely erase payloads through the
recording APIs. The workbench has no recording-management toolbar.

---

## 13. Operational and error states

- Devbox `online`/`offline`, agent `online`/`busy`/`offline`, and keyboard lease are all
  shown as **dot + text**, never color alone.
- Browser connection state is shown as live/reconnecting/error without inventing a durable
  session state; each pane's WebSocket reconnect loop restores that pane's view.
- Runtime launch and protocol failures surface through connector error frames and visible
  UI status or error messages.
- Local helper scripts load deterministically; pane lifecycle guards isolate stale
  views and asynchronous responses. There is no lazy chat-mount gate. The existing
  pinned jsDelivr xterm dependency loads only on terminal demand through
  `terminal-assets.js`; chat/app boot never waits for it. Load failure is visible
  before session creation. No vendor assets were downloaded during implementation.
- Operations guidance — structured logs, connection visibility, readiness checks,
  backup/restore, capacity alerts, and version/smoke checks — is in
  [`operations.md`](operations.md).

---

## 14. Accessibility and responsiveness

- Token-driven dark/light themes use fine borders and restrained semantic status
  colors. Theme choice is optional and presentation-only.
- Clear `:focus-visible` styles, a `prefers-reduced-motion` fallback, and a responsive
  narrow-screen layout keep compact navigation and pane controls usable. Separators
  support keyboard adjustment as well as dragging; verify both during visual review.
- UI text uses locally available sans-serif/system fallbacks; code/data use monospace.
  There are no remote fonts or bubble/card conversation styling, and no forced
  terminal-dominant landing page.
- DOM-free presentation logic (fleet summary, filtering, command generation, status mapping,
  HTML escaping) lives in a testable module covered by unit tests.

---

## 15. Success criteria and non-goals

### 15.1 North-star metric

> **Weekly count of agent sessions successfully resumed and kept in use.**

This directly measures whether the platform delivers value a local terminal cannot.

### 15.2 Reliability signals

- Rate of sessions ending without an explicit user action.
- Reconnect success rate.
- P50/P95 time to restore an interactive session.
- Output gap and duplicate rate.
- Connector crash-free session hours.

### 15.3 Usage-value signals

- Connected devboxes per user.
- Live sessions per week.
- Ratio of Resume vs. rebuild.
- Cross-device resume count.
- Saved-history access rate.

### 15.4 Non-goals

- Server-side model calls or API-key custody.
- A full IDE or code editor.
- General remote desktop.
- Automatic reading of user code repositories.
- Running commands when the connector has not authorized them.
- Guessing agent semantics by parsing ANSI text — agent-native states (waiting, approval,
  completed) should come from a runtime adapter's structured sideband, not screen scraping.

See [`planning.md`](planning.md) for delivery sequencing.
