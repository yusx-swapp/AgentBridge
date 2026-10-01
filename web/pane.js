/* One independently attached session surface. Closing a pane never ends a session. */
(function (environment, factory) {
  'use strict';
  const api = typeof module === 'object' && module.exports
    ? factory(environment, require('./ui.js'), require('./chat.js'), require('./collaboration.js'), require('./replay.js'))
    : factory(environment, environment.AgentBridgeUI || environment.DeepboxUI,
      environment.AgentBridgeChat || environment.DeepboxChat,
      environment.AgentBridgeCollaboration || environment.DeepboxCollaboration,
      environment.AgentBridgeReplay || environment.DeepboxReplay);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else environment.AgentBridgePane = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (environment, UI, Chat, Collaboration, Replay) {
  'use strict';

  const OPERATORS = ['operator', 'admin', 'owner'];
  const titleObservers = new Set();
  function publishTitle(workspaceId, sessionId, title) {
    for (const observer of titleObservers) observer(workspaceId, sessionId, title);
  }
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
  const XTERM_THEME = {
    background: '#10120f', foreground: '#cfd7c8', cursor: '#a3c57f',
    cursorAccent: '#000000', selectionBackground: 'rgba(59,177,168,0.30)',
    black: '#0b0d10', red: '#e5674f', green: '#4bbf7a', yellow: '#d8a63a',
    blue: '#5aa9e6', magenta: '#b98ae0', cyan: '#3bb1a8', white: '#c9d1d9',
    brightBlack: '#6b7480', brightRed: '#f08a74', brightGreen: '#6fd598',
    brightYellow: '#e6bd5f', brightBlue: '#7fbef0', brightMagenta: '#cda6ec',
    brightCyan: '#5fc7bd', brightWhite: '#f2f5f8',
  };

  function validSurface(value) {
    return value === 'terminal' || value === 'structured' ? value : null;
  }

  function displayName(value) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || 'someone'
      : 'someone';
  }

  function createPane({ id, root, services } = {}) {
    if (!root || !root.ownerDocument || !services || typeof services.api !== 'function')
      throw new TypeError('createPane needs a DOM root and services.api.');
    if (id == null || String(id) === '') throw new TypeError('A unique pane id is required.');
    if (!UI || !Chat || !Collaboration || !Replay) throw new Error('Session UI helpers could not load.');
    id = String(id);
    const document = root.ownerDocument;
    const window = document.defaultView || environment;
    const namespace = 'ab-pane-' + Array.from(id, c => c.codePointAt(0).toString(16)).join('-');
    let epoch = 0, closed = false, target = null, status = 'empty', statusText = '', targetWorkspace = null;
    let restoreRequested = false, lastChange = '', abortController = null;
    let terminal = null, fit = null, terminalSubscription = null, resizeObserver = null;
    let resizeSocket = null, resizeSize = '';
    let socket = null, inputSender = null, wantOpen = false, liveActive = false;
    let reconnectTimer = null, reconnectDelay = 500, heartbeat = null;
    let collaboration = null, keyboardRequester = null, endPending = false;
    let chat = null, controls = [], controlValues = {}, attachments = {}, readingFiles = false;
    let turnPending = false; // Presentation only; never persisted or folded into canonical events.
    let announcedCapability = null;
    let persistedRenderer = null, rendererView = null, rendererLoading = false, rendererFailed = false;
    let inputSequence = 0;
    let nativeSubmission = null;
    let recording = null;
    let nodes = {}, listeners = [];
    let sessionCards = [], sessionActionPending = false, sessionCardSeq = 0;
    const readers = new Set();
    const observeTitle = (workspaceId, sessionId, title) => {
      if (workspaceId === targetWorkspace) updateSessionTitle(sessionId, title);
    };
    titleObservers.add(observeTitle);

    function current(view) { return !closed && view === epoch && targetWorkspace === workspace()?.id; }
    function workspace() { return services.getWorkspace ? services.getWorkspace() : null; }
    function canOperate() {
      return current(epoch) && !!target && OPERATORS.includes(workspace()?.role)
        && (!collaboration || collaboration.canOperate);
    }
    function connected() {
      return current(epoch) && target?.kind === 'live' && !!target.sessionId && wantOpen && liveActive
        && !!socket && socket.readyState === 1;
    }
    function canWriteChat() {
      return connected() && target.surface === 'structured' && canOperate()
        && Collaboration.canSendMessage(collaboration);
    }
    function canWriteTerminal() {
      return connected() && target.surface === 'terminal' && canOperate()
        && Collaboration.canSendInput(collaboration);
    }
    function canEndSession() {
      // Chat uses the current role; Terminal still requires its keyboard lease.
      return connected() && canOperate() && !!collaboration
        && (target.surface === 'structured' || canWriteTerminal());
    }
    function getState() {
      const localRole = OPERATORS.indexOf(workspace()?.role);
      const liveRole = collaboration ? OPERATORS.indexOf(collaboration.role) : localRole;
      const keyboardLive = connected() && target.surface === 'terminal';
      const keyboardOwned = canWriteTerminal();
      const pending = !closed && target?.kind === 'live' && target.surface === 'structured' && turnPending;
      return {
        id, title: target?.title || '', agentId: target?.agentId || null,
        sessionId: target?.sessionId || null, surface: target?.surface || null,
        kind: target?.kind || null, status, statusText, canOperate: canOperate(),
        role: OPERATORS[Math.min(localRole, liveRole)] || 'viewer',
        canEndSession: canEndSession(), replay: target?.kind === 'replay',
        readOnly: !(target?.surface === 'structured' ? canWriteChat() : canWriteTerminal()),
        keyboardOwned, keyboardBusy: !!(keyboardLive && collaboration?.heldByAnyone && !keyboardOwned),
        keyboardHolder: keyboardLive && collaboration?.heldByAnyone ? displayName(collaboration.holderUsername) : '',
        keyboardPending: !!(keyboardLive && !collaboration),
        keyboardRequestPending: !!(keyboardOwned && keyboardRequester?.id != null),
        pending, turnPending: pending,
        permissionPending: !!(!closed && target?.kind === 'live' && chat?.pendingPermission),
      };
    }
    // Persist a whitelist, not this factory's mutable state. Operation flags are deliberately transient.
    function snapshot() {
      if (closed || !target) return null;
      const saved = { kind: target.kind, agentId: target.agentId, title: target.title };
      if (target.sessionId) saved.sessionId = target.sessionId;
      if (target.surface) saved.surface = target.surface;
      return saved;
    }
    function notify() {
      const state = getState(), key = JSON.stringify(state);
      if (key === lastChange) return;
      lastChange = key;
      if (services.onChange) services.onChange(state);
    }
    function setStatus(value, text) {
      status = value;
      statusText = text || value;
      syncAccess();
      notify();
    }
    function element(tag, name, className, text) {
      const node = document.createElement(tag);
      if (name) node.setAttribute('data-ui', name);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function listen(node, type, callback) {
      const view = epoch;
      const handler = event => { if (current(view)) return callback(event); };
      node.addEventListener(type, handler);
      listeners.push(() => node.removeEventListener(type, handler));
    }
    function button(name, text, callback) {
      const node = element('button', name, 'ghost', text);
      node.type = 'button';
      // Detached, replaced rows need no global listener. Epoch guards also make retained callbacks inert.
      const view = epoch;
      node.onclick = event => { if (current(view)) return callback(event); };
      return node;
    }
    function reportError(message) {
      if (closed || !nodes.error) return;
      nodes.error.textContent = String(message || 'The session request failed.');
      nodes.error.hidden = false;
    }
    function composerError(message) {
      if (nodes.composerError) nodes.composerError.textContent = message || '';
    }
    function clearError() {
      if (nodes.error) { nodes.error.textContent = ''; nodes.error.hidden = true; }
    }
    function mountShell() {
      root.textContent = '';
      // The workbench border/statusbar owns visible status and keyboard controls.
      nodes.status = element('span', 'status', 'visually-hidden', statusText);
      nodes.status.setAttribute('role', 'status');
      nodes.status.setAttribute('aria-live', 'polite');
      nodes.status.setAttribute('aria-atomic', 'true');
      nodes.error = element('p', 'error', 'pane-error');
      nodes.error.hidden = true;
      nodes.error.setAttribute('role', 'alert');
      nodes.resumeNote = element('p', 'resume-notice', 'pane-session-note');
      nodes.resumeNote.hidden = true;
      nodes.resumeNote.setAttribute('role', 'status');
      nodes.body = element('div', 'content', 'pane-session-content');
      root.append(nodes.status, nodes.error, nodes.resumeNote, nodes.body);
    }
    function stopHeartbeat() {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    }
    function stopReconnect() {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    function detachSocket() {
      stopHeartbeat();
      if (inputSender) inputSender.close();
      inputSender = null;
      const old = socket;
      socket = null;
      resizeSocket = null; resizeSize = '';
      if (old) {
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try { old.close(); } catch (_) { /* detach only; NEVER terminate */ }
      }
      collaboration = null;
      keyboardRequester = null;
    }
    function disposeTerminal() {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = null;
      window.removeEventListener?.('resize', resize);
      if (terminalSubscription) terminalSubscription.dispose();
      terminalSubscription = null;
      const old = terminal;
      terminal = null; fit = null;
      if (old) { try { old.dispose(); } catch (_) { /* already disposed */ } }
    }
    function reset() {
      ++epoch; // Invalidate REST, dialogs, file reads, and already queued WS/DOM callbacks first.
      wantOpen = false; liveActive = false;
      stopReconnect(); detachSocket(); disposeTerminal();
      if (abortController) abortController.abort();
      abortController = null;
      for (const reader of readers) { try { reader.abort(); } catch (_) {} }
      readers.clear();
      for (const remove of listeners) remove();
      listeners = [];
      nodes = {};
      sessionCards = []; sessionActionPending = false;
      chat = null; controls = []; controlValues = {}; attachments = {}; readingFiles = false;
      turnPending = false;
      nativeSubmission = null;
      announcedCapability = null;
      rendererView?.destroy(); rendererView = null;
      persistedRenderer = null; rendererLoading = false; rendererFailed = false;
      recording = null;
      reconnectDelay = 500; endPending = false;
      root.textContent = '';
    }
    function request(path, options) {
      return services.api(path, Object.assign({}, options, abortController ? { signal: abortController.signal } : {}));
    }
    function agentPath() { return UI.agentApiPath(target.agentId) + '/sessions'; }
    function capability() {
      if (announcedCapability) return announcedCapability;
      const found = services.findAgent ? services.findAgent(target?.agentId) : null;
      return UI.findRuntimeCapability(found?.box?.capabilities, found?.agent?.runtime);
    }
    function selectedRenderer() {
      const found = services.findAgent?.(target?.agentId);
      return chat?.renderer || persistedRenderer || Chat.rendererId(found?.agent, capability());
    }
    function runtimeContract() {
      return Chat.runtimeContract(services.findAgent?.(target?.agentId)?.agent, capability(), selectedRenderer());
    }
    function sessionRuntimeContract(session) {
      return Chat.runtimeContract(services.findAgent?.(target?.agentId)?.agent, capability(), session?.renderer || selectedRenderer());
    }
    function canContinueNative(session) {
      return sessionRuntimeContract(session).explicitContinuation
        && canOperate() && session?.state === 'inactive'
        && session.surface === 'structured' && session.available !== false;
    }
    function unavailable(message, allowReplay = true) {
      liveActive = false; wantOpen = false; turnPending = false;
      stopReconnect(); detachSocket();
      setStatus('unavailable', 'Session unavailable');
      reportError(message);
      const actions = element('div', 'unavailable-actions', 'pane-session-actions');
      if (allowReplay && target.sessionId)
        actions.appendChild(button('open-replay', 'View history', () => open({ ...snapshot(), kind: 'replay' })));
      if (canOperate())
        actions.appendChild(button('open-live', 'New session', newSession));
      nodes.body.appendChild(actions);
    }

    async function open(next, activation = null) {
      if (closed) return getState();
      if (!next || !['live', 'history', 'replay'].includes(next.kind) || !next.agentId)
        throw new TypeError('A pane target needs kind and agentId.');
      reset();
      targetWorkspace = workspace()?.id;
      const view = epoch;
      const found = services.findAgent ? services.findAgent(String(next.agentId)) : null;
      target = {
        kind: next.kind, agentId: String(next.agentId),
        title: String(next.title || found?.agent?.display_name || found?.agent?.handle || next.agentId),
        surface: validSurface(next.surface),
      };
      if (next.sessionId && (next.forceNew !== true || next.restore === true)) target.sessionId = String(next.sessionId);
      restoreRequested = next.restore === true;
      if (!target.surface && target.kind !== 'replay')
        target.surface = validSurface(UI.preferredSurface(capability())) || 'terminal';
      if (typeof window.AbortController === 'function') abortController = new window.AbortController();
      status = 'opening'; statusText = target.kind === 'live' ? 'Opening session…' : 'Loading history…';
      mountShell();
      setStatus(status, statusText);
      try {
        if (activation && !restoreRequested) await openActivated(view, activation);
        else if (target.kind === 'live') await openLive(view, next.forceNew === true, !!validSurface(next.surface), next.continueNative === true && !restoreRequested);
        else if (target.kind === 'history') await loadHistory(view);
        else await loadReplay(view);
      } catch (error) {
        if (current(view)) {
          setStatus('error', 'Could not open ' + (target.kind === 'replay' ? 'history' : target.kind));
          reportError(error.message || 'The request failed. Use Reconnect to retry.');
        }
      }
      return getState();
    }
    async function openLive(view, forceNew, explicitSurface, continueNative = false) {
      // Restoration is navigation, not consent to spawn a new model, even if forceNew was persisted elsewhere.
      if (restoreRequested && !target.sessionId) {
        unavailable('No saved session ID. Choose New session to start explicitly.', false);
        return;
      }
      let session = null, created = false;
      if (!forceNew || restoreRequested || target.sessionId) {
        const sessions = await request(agentPath());
        if (!current(view)) return;
        if (!Array.isArray(sessions)) throw new Error('Invalid session list.');
        session = target.sessionId ? sessions.find(item => item.id === target.sessionId)
          : UI.resumableSession(sessions.filter(item => item.available !== false), target.surface);
        if (target.sessionId) {
          if (!session) { unavailable('The saved session is missing. It will not be recreated automatically.'); return; }
          if (session.state !== 'live' && !(continueNative && canContinueNative(session))) {
            await open({ ...snapshot(), kind: 'replay', surface: validSurface(session.surface) || target.surface });
            return;
          }
          if (session.available === false) { unavailable('The connector or runtime for this session is unavailable.'); return; }
          if (!validSurface(session.surface) || explicitSurface && session.surface !== target.surface) {
            unavailable('This session does not have the selected surface. Choose a matching session from History.');
            return;
          }
          if (!explicitSurface) target.surface = session.surface;
        }
      }
      if (!current(view)) return;
      if (session) applySessionMetadata(session);
      // Preflight the renderer BEFORE any create request. Chat never touches xterm.
      if (target.surface === 'terminal' && services.ensureTerminal) {
        setStatus('opening', 'Loading terminal renderer…');
        await services.ensureTerminal();
        if (!current(view)) return;
      }
      if (!mountSurface()) return;
      if (!session) {
        if (restoreRequested) { unavailable('The saved session cannot be resumed. Start a new session explicitly.'); return; }
        if (!canOperate()) { unavailable('Read-only: an Operator, Admin or Owner must start a session.', false); return; }
        session = await request(agentPath(), { method: 'POST', body: JSON.stringify({ surface: target.surface }) });
        if (!current(view)) return;
        created = true;
      }
      if (!session || !session.id) throw new Error('The server did not return a session ID.');
      target.sessionId = String(session.id);
      applySessionMetadata(session);
      mountSessionCard(session, nodes.body, false);
      if (session.surface !== target.surface) {
        unavailable('The server returned a different or unknown session surface. Use History to select it.');
        return;
      }
      // A new persisted row is inactive until this browser sends its attach.
      if (!created && session.state && session.state !== 'live' && !(continueNative && canContinueNative(session))) {
        await open({ ...snapshot(), kind: 'replay' });
        return;
      }
      wantOpen = true; liveActive = false;
      connectSocket(null, continueNative);
    }
    function mountSurface() {
      if (target.surface === 'structured') { mountChat(); return true; }
      const host = element('div', 'terminal', 'pane-terminal');
      nodes.terminal = host;
      nodes.body.appendChild(host);
      try {
        if (typeof window.Terminal !== 'function' || typeof window.FitAddon?.FitAddon !== 'function')
          throw new Error('The xterm terminal renderer could not load. Reload and allow the xterm scripts, or explicitly open Chat if available.');
        terminal = new window.Terminal({
          fontFamily: "'Cascadia Code','SFMono-Regular',Consolas,monospace", fontSize: 13, cursorBlink: true,
          scrollOnUserInput: true, scrollback: 5000, theme: XTERM_THEME, disableStdin: true,
        });
        fit = new window.FitAddon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();
        const ownTerminal = terminal, view = epoch;
        terminalSubscription = terminal.onData(data => {
          // No pane-focus gate: xterm also emits protocol responses while another pane has focus.
          if (!current(view) || ownTerminal !== terminal || !canWriteTerminal()) return;
          try { inputSender?.push(data); } catch (error) { reportError(error.message); }
        });
        listen(host, 'pointerdown', focus);
        if (typeof window.ResizeObserver === 'function') {
          resizeObserver = new window.ResizeObserver(() => { if (current(view) && ownTerminal === terminal) resize(); });
          resizeObserver.observe(root);
        } else window.addEventListener?.('resize', resize);
        syncAccess();
        return true;
      } catch (error) {
        disposeTerminal();
        setStatus('error', 'Terminal renderer unavailable');
        reportError(error.message || 'Terminal could not start. Reload to retry.');
        return false;
      }
    }
    function resize() {
      if (closed) return;
      resizeChatInput();
      if (!terminal || !fit) return;
      const bounds = root.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      try { fit.fit(); sendResize(); } catch (_) { /* a temporarily hidden pane has no size */ }
    }
    function sendResize(force = false) {
      if (!canWriteTerminal() || !terminal) return;
      const size = terminal.cols + ':' + terminal.rows;
      if (!force && resizeSocket === socket && resizeSize === size) return;
      if (sendFrame('resize', { cols: terminal.cols, rows: terminal.rows })) {
        resizeSocket = socket; resizeSize = size;
      }
    }
    function focus() {
      if (closed) return;
      if (terminal && target?.kind === 'live') terminal.focus();
      else if (nodes.input && !nodes.composer.hidden && !nodes.input.disabled) nodes.input.focus();
      else {
        const node = nodes.scroll || nodes.body || root;
        node.tabIndex = -1;
        node.focus();
      }
    }
    function sendFrame(type, fields) {
      if (!current(epoch) || !target?.sessionId || !socket || socket.readyState !== 1) return false;
      try {
        socket.send(JSON.stringify({ type, session_id: target.sessionId,
          ...(target.launchId != null ? { launch_id: target.launchId } : {}), ...fields }));
        return true;
      } catch (error) { reportError(error.message || 'Session connection failed.'); return false; }
    }
    function sendPrefix() {
      // Unlike xterm protocol responses, this workbench shortcut is active-pane input.
      if (!canWriteTerminal() || !terminal) return false;
      const active = services.isActive ? services.isActive() : root.contains(document.activeElement);
      return !!(active && sendFrame('input', { data: '\u0002' }));
    }
    function connectSocket(resume = null, continueNative = false) {
      if (!current(epoch) || !wantOpen || !target?.sessionId || target.kind !== 'live') return;
      // SDK continuation uses the same explicit, generation-checked wire intent;
      // the Server routes it to the library, not a generic CLI resume operation.
      if (continueNative) resume = { launch_id: target.launchId ?? null };
      stopReconnect(); detachSocket();
      liveActive = false;
      setStatus('connecting', resume ? 'Preparing resume…' : 'Connecting…');
      const view = epoch, sessionId = target.sessionId;
      let ownSocket;
      try {
        const location = window.location || environment.location;
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ownSocket = new window.WebSocket(protocol + '//' + location.host + '/ws/term');
      } catch (error) {
        liveActive = false;
        setStatus('error', 'Connection unavailable'); reportError(error.message);
        return;
      }
      socket = ownSocket;
      const isCurrent = () => current(view) && socket === ownSocket && target.sessionId === sessionId;
      inputSender = UI.createTerminalInputSender((data, options) => {
        if (!isCurrent() || !(target.surface === 'structured' ? canWriteChat() : canWriteTerminal())) return false;
        const clientInputId = runtimeContract().inputReceipts && options?.client_input_id;
        if (clientInputId) { options = {...options}; delete options.client_input_id; }
        return sendFrame('input', { data, options,
          ...(clientInputId ? {client_input_id:clientInputId} : {}) });
      });
      // Owned by this socket callback only, never by target/snapshot/reconnect.
      let opened = false, resumeOnce = resume;
      let awaitingStart = !!resume || target.launchId == null, awaitingReady = !!resume, attachPending = !resume;
      ownSocket.onopen = () => {
        if (!isCurrent() || !wantOpen || opened) return;
        opened = true;
        const intent = resumeOnce; resumeOnce = null;
        if ((intent || continueNative) && !canOperate()) {
          wantOpen = false; setStatus('unavailable', 'Read-only');
          reportError(continueNative ? 'Read-only: permission to continue was revoked.' : 'Read-only: permission to resume was revoked.'); return;
        }
        if (!sendFrame(intent ? 'resume' : 'attach', { cols: terminal?.cols || 120, rows: terminal?.rows || 30,
          surface: target.surface, ...(intent ? { agent_id: target.agentId, launch_id: intent.launch_id ?? null } : {}) })) return;
        setStatus(intent ? 'starting' : 'connected', intent ? 'Preparing resume…' : 'Attached · waiting for runtime');
      };
      ownSocket.onmessage = async event => {
        if (!isCurrent() || !wantOpen) return;
        let frame;
        try { frame = JSON.parse(event.data); } catch (_) { reportError('Received an invalid session frame. Reconnect to retry.'); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        if (frame.type === 'session.updated') { publishTitle(targetWorkspace, frame.session_id, frame.title); return; }
        if (frame.session_id && frame.session_id !== sessionId) return;
        const starting = frame.type === 'status' && frame.state === 'starting';
        if (starting) {
          // Only the first starting response may replace the CAS token used to resume.
          // A late starting/ready from the previous process must not regress this pane.
          if (!(awaitingStart || attachPending && frame.launch_id === target.launchId)
            || (resume && (!frame.launch_id || frame.launch_id === resume.launch_id))) return;
        } else if (frame.launch_id != null && target.launchId != null && frame.launch_id !== target.launchId) {
          // End invalidates the generation; an offline send can roll it back. Reattach
          // may also discover a newer live generation. Verify these status transitions
          // against metadata, never trust a mismatched ready/error/output/exit.
          if (frame.type !== 'status' || !(['ended', 'offline'].includes(frame.state)
            || attachPending && ['live', 'inactive'].includes(frame.state))) return;
          const previousLaunch = target.launchId;
          try {
            const latest = validateSession(await request(sessionPath(sessionId)), sessionId, target.agentId);
            if (!isCurrent() || !wantOpen || target.launchId !== previousLaunch
              || latest.launch_id !== frame.launch_id
              || (frame.state === 'offline' ? latest.state === 'live' : latest.state !== frame.state)) return;
          } catch (_) { return; }
          target.launchId = frame.launch_id;
        } else if (target.launchId != null && frame.launch_id == null
          && ['ready', 'session.ready', 'status', 'exit'].includes(frame.type)) return;
        if ((frame.type === 'ready' || frame.type === 'session.ready') && resume && awaitingStart) return;
        if (frame.surface && frame.surface !== target.surface) {
          unavailable('The attached session surface changed. Select a matching session from History.');
          return;
        }
        if (frame.kind === 'event' && (frame.type === 'restore' || frame.type === 'output')) {
          if (target.surface === 'structured') handleChatFrame(frame);
          return;
        }
        switch (frame.type) {
          case 'ready':
          case 'session.ready':
            awaitingReady = false; awaitingStart = false; attachPending = false;
            liveActive = true; reconnectDelay = 500;
            updateLaunch(frame);
            if (frame.capabilities && typeof frame.capabilities === 'object' && !Array.isArray(frame.capabilities)) {
              announcedCapability = frame.capabilities;
              if (target.surface === 'structured') setupChatControls();
            }
            setStatus('live', ['next_turn', 'pending'].includes(frame.context_resume) ? 'Next message resumes the CLI conversation'
              : target.surface === 'structured' ? 'Chat ready' : 'Terminal ready');
            break;
          case 'restore':
            if (terminal) { terminal.reset(); terminal.write(frame.data || ''); }
            break;
          case 'output':
            if (terminal) terminal.write(frame.data || '');
            break;
          case 'runtime.unavailable':
            liveActive = false; turnPending = false; wantOpen = false; stopReconnect(); stopHeartbeat();
            for (const card of sessionCards) if (String(card.session.id) === sessionId && card.session.state === 'starting') card.session.state = 'inactive';
            nodes.resumeNote.hidden = true;
            setStatus('unavailable', 'Runtime unavailable');
            reportError(frame.message || ('Runtime unavailable: ' + String(frame.code || 'runtime_unavailable') + '. View History for available actions. No new session was created.'));
            break;
          case 'status':
            if (frame.state === 'live') {
              // A Resume may race an existing process becoming ready. The server
              // explicitly confirms reattachment without launching another one.
              const reattached = resume && awaitingStart && frame.reattached === true
                && frame.launch_id === resume.launch_id;
              if (awaitingReady && !reattached) return; // Preparation alone is not readiness.
              awaitingReady = false;
              if (reattached) nodes.resumeNote.hidden = true;
              awaitingStart = false; attachPending = false;
              liveActive = true; updateLaunch(frame);
              setStatus('live', ['next_turn', 'pending'].includes(frame.context_resume) ? 'Next message resumes the CLI conversation' : 'Live');
            }
            else if (frame.state === 'starting') {
              awaitingStart = false; awaitingReady = true; attachPending = false;
              if (Object.prototype.hasOwnProperty.call(frame, 'launch_id')) target.launchId = frame.launch_id;
              for (const card of sessionCards) if (String(card.session.id) === sessionId) card.session.state = 'starting';
              liveActive = false;
              if (resume) showPreparingResumeNotice(); else nodes.resumeNote.hidden = true;
              setStatus('starting', resume ? 'Preparing resume…' : 'Preparing session…');
            }
            else if (frame.state === 'ended' || frame.state === 'inactive') finishSession(frame);
            else if (frame.state === 'offline') {
              liveActive = false; wantOpen = false; turnPending = false; stopReconnect(); stopHeartbeat();
              nodes.resumeNote.hidden = true;
              setStatus('offline', 'Connector offline');
              reportError(frame.message || 'The connector is offline. Reconnect the connector, then retry.');
            }
            break;
          case 'exit': finishSession(frame); break;
          case 'input_ack':
            if (runtimeContract().inputReceipts && nativeSubmission && nativeSubmission.id === frame.client_input_id) {
              if (frame.status === 'rejected') {
                const submitted = nativeSubmission;
                nativeSubmission = null; turnPending = false;
                chat.items = chat.items.filter(item => !(item.kind === 'user' && item.local && item.client_input_id === submitted.id));
                chat._openAssistant = null;
                if (!nodes.input.value) { nodes.input.value = submitted.text; resizeChatInput(); }
                renderChat();
                const uncertain = ['execution_uncertain', 'input_delivery_failed'].includes(frame.reason);
                composerError(uncertain
                  ? 'Execution outcome is uncertain. It was not resent; check possible tool side effects before submitting again.'
                  : 'Input rejected: ' + String(frame.reason || frame.code || 'not accepted').replace(/_/g, ' ') + '. Your draft has been kept.');
              } else if (frame.status === 'delivered' && frame.duplicate) {
                nativeSubmission = null; turnPending = false; renderChat();
              } else if (frame.status === 'delivered') {
                nativeSubmission.delivered = true;
              }
            }
            break;
          case 'error':
            if (awaitingReady || awaitingStart || ['resume_required', 'session_changed', 'start_failed', 'session_failed',
              'configuration_changed', 'context.not_found', 'context.changed', 'context.in_use',
              'context.recovery_required', 'context.writer_unavailable'].includes(frame.code)) {
              liveActive = false; turnPending = false; wantOpen = false; stopReconnect(); stopHeartbeat();
              for (const card of sessionCards) if (String(card.session.id) === sessionId && card.session.state === 'starting') card.session.state = 'inactive';
              nodes.resumeNote.hidden = true;
              setStatus('unavailable', 'Session unavailable');
            }
            reportError(frame.message || frame.code || 'The session request failed.'); break;
          case 'snapshot':
          case 'collaboration': {
            const hadKeyboard = canWriteTerminal();
            collaboration = Collaboration.deriveCollaborationState(frame, services.getUser ? services.getUser() : null);
            if (!collaboration.isHolder) keyboardRequester = null;
            reconnectDelay = 500;
            syncAccess(); notify();
            if (!hadKeyboard && canWriteTerminal()) sendResize(true);
            break;
          }
          case 'keyboard_request':
            if (canWriteTerminal()) {
              keyboardRequester = { id: frame.requester_user_id, username: frame.requester_username };
              syncAccess(); notify();
            }
            break;
        }
      };
      ownSocket.onerror = () => { if (isCurrent()) reportError('Session connection failed. Check your connection or use Reconnect.'); };
      ownSocket.onclose = () => {
        if (!isCurrent()) return;
        if (runtimeContract().inputReceipts && nativeSubmission && !nativeSubmission.delivered) {
          if (!nodes.input.value) { nodes.input.value = nativeSubmission.text; resizeChatInput(); }
          composerError('Delivery is unconfirmed. Nothing was automatically resent; check restored history and possible tool effects before submitting again.');
        }
        stopHeartbeat();
        if (inputSender) inputSender.close();
        inputSender = null; collaboration = null; keyboardRequester = null; liveActive = false;
        if (!wantOpen) { syncAccess(); notify(); return; }
        setStatus('reconnecting', 'Reconnecting…');
        stopReconnect();
        reconnectTimer = window.setTimeout(() => {
          if (!isCurrent() || !wantOpen) return;
          reconnectTimer = null;
          connectSocket();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      };
    }
    function finishSession(frame) {
      if (terminal && frame.data) terminal.write(frame.data);
      wantOpen = false; liveActive = false; turnPending = false;
      stopReconnect(); detachSocket();
      nodes.resumeNote.hidden = true;
      setStatus(frame.state === 'inactive' ? 'inactive' : 'ended', 'Session ended');
      reportError('Session ended' + (frame.code != null ? ', code ' + frame.code : '') + '. View History to resume if supported, or explicitly start a New session.');
    }
    function syncHeartbeat() {
      if (!canWriteTerminal()) { stopHeartbeat(); return; }
      if (heartbeat !== null) return;
      const ownSocket = socket, view = epoch, sessionId = target.sessionId;
      heartbeat = window.setInterval(() => {
        if (!current(view) || socket !== ownSocket || target.sessionId !== sessionId) return;
        if (!canWriteTerminal()) { stopHeartbeat(); return; }
        sendFrame('keyboard_renew');
      }, 20000);
    }
    function syncAccess() {
      syncHeartbeat();
      syncChatControls();
      for (const card of sessionCards) card.sync();
      if (terminal) terminal.options.disableStdin = !canWriteTerminal();
      if (!nodes.status) return;
      const state = getState(), parts = [statusText];
      if (connected()) {
        if (state.keyboardRequestPending) parts.push('Keyboard handoff requested');
        else if (state.keyboardOwned) parts.push('You have the keyboard');
        else if (state.keyboardBusy) parts.push('Keyboard: ' + state.keyboardHolder);
        else if (state.keyboardPending) parts.push('Waiting for keyboard state');
        else if (target.surface === 'terminal' && canOperate()) parts.push('Keyboard free');
        else if (!state.readOnly) parts.push('Shared chat');
      }
      if (state.readOnly && target?.kind === 'live') parts.push('Read-only');
      if (state.pending) parts.push('Turn pending');
      if (state.permissionPending) parts.push('Permission requested');
      const text = parts.join(' · ');
      if (nodes.status.textContent !== text) nodes.status.textContent = text;
    }
    function requestKeyboard() {
      return !!(connected() && target.surface === 'terminal' && canOperate() && collaboration?.canRequest
        && sendFrame('keyboard_acquire'));
    }
    function releaseKeyboard() { return !!(canWriteTerminal() && sendFrame('keyboard_release')); }
    function handoffKeyboard() {
      if (!canWriteTerminal() || !keyboardRequester || keyboardRequester.id == null) return false;
      if (!sendFrame('keyboard_handoff', { target_user_id: keyboardRequester.id })) return false;
      keyboardRequester = null; syncAccess(); notify(); return true;
    }

    function mountChat() {
      chat = Chat.initialChatState();
      const surface = element('div', 'chat', 'chat-surface');
      nodes.rendererNote = element('div', 'chat-renderer-notice', 'chat-renderer-notice');
      nodes.rendererNote.setAttribute('role', 'status');
      nodes.rendererNote.hidden = true;
      nodes.scroll = element('div', 'chat-scroll', 'chat-scroll');
      nodes.scroll.setAttribute('aria-label', 'Session transcript');
      nodes.composer = element('div', 'chat-composer', 'chat-composer');
      nodes.composer.hidden = target.kind !== 'live';
      nodes.controls = element('div', 'chat-controls', 'chat-controls');
      nodes.tray = element('div', 'chat-file-tray', 'chat-file-tray');
      const form = element('form', 'chat-form', 'chat-form');
      nodes.input = element('textarea', 'chat-input', 'chat-input');
      nodes.input.rows = 2;
      nodes.input.setAttribute('aria-label', 'Message the agent');
      nodes.input.title = 'Enter to send · Shift+Enter for newline';
      nodes.send = element('button', 'chat-send', 'chat-send', 'Send');
      nodes.send.type = 'submit';
      nodes.send.setAttribute('aria-label', 'Send message');
      nodes.send.title = 'Send message (Enter)';
      nodes.interrupt = button('chat-interrupt', 'Interrupt', interrupt);
      nodes.interrupt.className = 'ghost chat-interrupt';
      nodes.interrupt.title = 'Interrupt the pending turn';
      form.append(nodes.input, nodes.send, nodes.interrupt);
      nodes.composerError = element('div', 'chat-composer-error', 'chat-composer-error');
      nodes.composerError.setAttribute('role', 'status');
      nodes.composer.append(nodes.controls, nodes.tray, form, nodes.composerError);
      surface.append(nodes.rendererNote, nodes.scroll, nodes.composer);
      nodes.body.appendChild(surface);
      let composing = false;
      listen(form, 'submit', event => { event.preventDefault(); if (!composing) sendChatMessage(); });
      listen(nodes.input, 'compositionstart', () => { composing = true; });
      listen(nodes.input, 'compositionend', () => { composing = false; resizeChatInput(); });
      listen(nodes.input, 'input', resizeChatInput);
      listen(nodes.input, 'keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault(); sendChatMessage();
        }
      });
      if (target.kind === 'live') setupChatControls();
      resizeChatInput();
      renderChat();
    }
    function resizeChatInput() {
      const input = nodes.input;
      if (!input) return;
      const style = window.getComputedStyle?.(input);
      const lineHeight = parseFloat(style?.lineHeight) || 20;
      const padding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
      const border = (parseFloat(style?.borderTopWidth) || 0) + (parseFloat(style?.borderBottomWidth) || 0);
      const min = Math.ceil(2 * lineHeight + padding + border), max = Math.ceil(6 * lineHeight + padding + border);
      input.style.boxSizing = 'border-box';
      input.style.minHeight = min + 'px'; input.style.maxHeight = max + 'px';
      input.style.height = '0px'; // Measure wrapped content without retaining the previous height.
      const height = input.value ? Math.max(min, input.scrollHeight + border) : min;
      input.style.height = Math.min(max, height) + 'px';
      input.style.overflowY = height > max ? 'auto' : 'hidden';
    }
    function setupChatControls() {
      const selected = UI.capabilityForSurface(capability(), 'structured');
      // Project the selected surface; the renderer also supports legacy single-surface schemas.
      const nextControls = Chat.controlsFromCapability(selected ? { features: selected.features, models: selected.models } : null)
        .filter(control => runtimeContract().interactiveApproval || !/permission|approval/i.test(control.key));
      if (nodes.controls.childElementCount && JSON.stringify(controls) === JSON.stringify(nextControls)) return;
      const savedAttachments = attachments;
      controls = nextControls;
      attachments = {};
      if (chat.configured) controlValues = Chat.reconcileControlValues(controls, controlValues, chat.config);
      if (readingFiles) {
        for (const reader of readers) { try { reader.abort(); } catch (_) {} }
        composerError('Session controls changed. Reattach any files that were still loading.');
      }
      nodes.controls.textContent = '';
      for (const control of controls) {
        if (control.kind === 'select') {
          const label = element('label', null, 'chat-control');
          label.appendChild(element('span', null, null, control.label));
          const input = element(control.allow_custom ? 'input' : 'select', 'chat-control');
          input.setAttribute('data-chat-control', control.key);
          input.setAttribute('aria-label', control.label);
          let options = input;
          if (control.allow_custom) {
            const list = element('datalist');
            list.id = namespace + '-choices-' + control.key;
            input.setAttribute('list', list.id);
            input.placeholder = 'Runtime default or custom value';
            options = list;
            label.append(input, list);
          } else {
            const fallback = element('option', null, null, 'Runtime default');
            fallback.value = ''; input.appendChild(fallback); label.appendChild(input);
          }
          for (const choice of control.choices) {
            const option = element('option', null, null, choice);
            option.value = choice; options.appendChild(option);
          }
          listen(input, 'input', () => {
            if (canWriteChat() && !input.disabled) controlValues[control.key] = input.value.trim();
          });
          nodes.controls.appendChild(label);
        } else {
          const files = savedAttachments[control.key] || [];
          const allowed = files.length <= control.max_files
            && files.reduce((total, file) => total + file.size, 0) <= control.max_total_bytes;
          attachments[control.key] = allowed ? files : [];
          if (!allowed) composerError('Attachment limits changed. Reattach files within the new limits.');
          const input = element('input', 'chat-file');
          input.setAttribute('data-chat-file', control.key);
          input.type = 'file'; input.multiple = control.max_files > 1; input.accept = control.accept; input.hidden = true;
          listen(input, 'change', async () => { await addFiles(control, input.files); input.value = ''; });
          nodes.controls.append(button('chat-attach', control.label, () => { if (canWriteChat() && !readingFiles) input.click(); }), input);
        }
      }
      nodes.controls.hidden = !controls.length;
      nodes.sessionNote = element('span', 'chat-session-note', 'chat-session-note', 'Fixed for this chat · New session to change');
      nodes.controls.appendChild(nodes.sessionNote);
      renderAttachments();
    }
    function syncChatControls() {
      if (!chat || !nodes.input) return;
      const writable = canWriteChat();
      rendererView?.setAccess({live:target.kind === 'live' && liveActive, readOnly:!writable, canSend:writable, canInterrupt:writable});
      nodes.input.disabled = !writable;
      nodes.input.placeholder = writable ? 'Message…' : 'Read-only';
      for (const node of root.querySelectorAll('[data-ui="chat-composer"] button, [data-ui="chat-file"], .chat-perm button'))
        node.disabled = !writable;
      nodes.send.disabled = !writable || readingFiles || (runtimeContract().serialTurns && turnPending);
      nodes.interrupt.hidden = target.kind !== 'live' || !turnPending;
      for (const node of root.querySelectorAll('[data-ui="chat-attach"], [data-ui="chat-file"]')) node.disabled = !writable || readingFiles;
      const locked = chat.configured || chat.items.length > 0;
      for (const control of controls) {
        if (control.kind !== 'select') continue;
        const input = nodes.controls.querySelector('[data-chat-control="' + control.key + '"]');
        input.value = controlValues[control.key] || '';
        input.disabled = !writable || control.scope === 'session' && locked;
        input.title = input.disabled && writable ? 'Fixed for this chat. Start a New session to change it.' : '';
      }
      if (nodes.sessionNote) nodes.sessionNote.hidden = !(locked && controls.some(control => control.scope === 'session'));
    }
    function renderChat() {
      if (!chat || !nodes.scroll) return;
      const view = epoch;
      const rendererId = selectedRenderer();
      const native = Chat.supportsRenderer(rendererId);
      nodes.rendererNote.hidden = !rendererId || native;
      nodes.rendererNote.textContent = rendererId && !native
        ? 'Unsupported conversation renderer. Using standard chat; some presentation features may be unavailable.' : '';
      if (!runtimeContract().interactiveApproval) chat.pendingPermission = null;
      if (!native && rendererView) { rendererView.destroy(); rendererView = null; }
      if (native && !rendererView && !rendererLoading && !rendererFailed) {
        const host = nodes.scroll;
        rendererLoading = true;
        Chat.loadLocalModule(rendererId).then(module => {
          if (!current(view) || nodes.scroll !== host) return;
          rendererLoading = false;
          if (selectedRenderer() !== rendererId) return;
          rendererView = module.createView(host, {interrupt,
            sendInput:text => { if (!nodes.input || !canWriteChat()) return false; nodes.input.value = text; return sendChatMessage(); }});
          renderChat();
        }).catch(() => {
          if (!current(view)) return;
          rendererLoading = false; rendererFailed = true;
          reportError('Conversation presentation unavailable. Using standard chat; reload to retry.');
        });
      }
      if (rendererView && native) {
        rendererView.setAccess({live:target.kind === 'live' && liveActive, readOnly:!canWriteChat(), canSend:canWriteChat(), canInterrupt:canWriteChat()});
        rendererView.renderState(chat, {live:target.kind === 'live' && liveActive, readOnly:!canWriteChat(), pending:turnPending});
      } else Chat.renderChat(nodes.scroll, chat, !runtimeContract().interactiveApproval ? {} : { onPermission: (requestId, allow) => {
        if (current(view)) sendPermission(requestId, allow);
      } });
      syncAccess(); notify();
    }
    function handleChatFrame(frame) {
      if (!chat) return;
      if (frame.type === 'restore' && !String(frame.data || '').trim()) return;
      const folded = Chat.foldEventPayload(chat, frame.data, frame.type === 'restore');
      chat = folded.state;
      if (frame.type === 'restore') turnPending = false;
      for (const event of folded.events) {
        if (nativeSubmission && event.ev === 'user.echo' && event.client_input_id === nativeSubmission.id) nativeSubmission.delivered = true;
        if (event.ev === 'turn.end') { turnPending = false; nativeSubmission = null; }
        else if (['turn.start', 'thinking.delta', 'user.echo', 'message', 'message.delta', 'tool.call', 'tool.result', 'permission.ask'].includes(event.ev))
          turnPending = true;
      }
      if (frame.type === 'restore' || folded.events.some(event => event.ev === 'session.config'))
        controlValues = Chat.reconcileControlValues(controls, controlValues, chat.config);
      renderChat();
    }
    function newNativeInputId() {
      if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
      // randomUUID requires a secure context; getRandomValues also works on
      // ordinary LAN HTTP. IDs correlate receipts, never authorize access.
      const bytes = new Uint8Array(16);
      if (typeof window.crypto?.getRandomValues === 'function') window.crypto.getRandomValues(bytes);
      else {
        let seed = Date.now() + (++inputSequence);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = (seed + Math.floor(Math.random() * 256)) & 255;
          seed = Math.floor(seed / 256);
        }
      }
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return h.slice(0,8) + '-' + h.slice(8,12) + '-' + h.slice(12,16) + '-' + h.slice(16,20) + '-' + h.slice(20);
    }
    function sendChatMessage() {
      if (!chat || !nodes.input || target.kind !== 'live' || target.surface !== 'structured') return false;
      const text = nodes.input.value;
      if (!text.trim()) return false;
      if (!canWriteChat()) { composerError('Read-only or reconnecting. Your draft has been kept.'); return false; }
      if (runtimeContract().serialTurns && turnPending) { composerError('Wait for the current turn to settle. Your draft has been kept.'); return false; }
      if (readingFiles) { composerError('Wait for attachments to finish loading. Your draft has been kept.'); return false; }
      try {
        const options = Chat.buildTurnOptions(controls, controlValues, attachments);
        const clientInputId = runtimeContract().inputReceipts ? newNativeInputId() : null;
        if (clientInputId) options.client_input_id = clientInputId;
        if (!inputSender || !inputSender.push(text, options)) {
          composerError('The session is reconnecting. Your draft has been kept; try again.'); return false;
        }
        const metadata = Object.values(attachments).flat().map(file => ({ name: file.name, type: file.type, size: file.size }));
        Chat.appendUserTurn(chat, text, metadata, clientInputId);
        if (clientInputId) nativeSubmission = {id:clientInputId, text};
        turnPending = true;
        for (const key of Object.keys(attachments)) attachments[key] = [];
        nodes.input.value = '';
        resizeChatInput();
        composerError(''); renderAttachments(); renderChat();
        return true;
      } catch (error) {
        composerError((error.message || 'Message could not be sent.') + ' Your draft has been kept; try again.');
        return false;
      }
    }
    function sendPermission(requestId, allow) {
      if (!runtimeContract().interactiveApproval) return false;
      if (!canWriteChat() || chat?.pendingPermission?.request_id !== requestId) return false;
      if (!sendFrame('permission', { request_id: requestId, allow: !!allow })) return false;
      chat.pendingPermission = null; renderChat(); return true;
    }
    function interrupt() { return !!(canWriteChat() && sendFrame('interrupt')); }
    function fileSize(bytes) {
      return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KB'
        : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function renderAttachments() {
      if (!nodes.tray) return;
      nodes.tray.textContent = '';
      for (const control of controls.filter(item => item.kind === 'file')) {
        for (const [index, file] of (attachments[control.key] || []).entries()) {
          const chip = element('span', null, 'chat-file-chip');
          const remove = button('chat-file-remove', '×', () => {
            if (!canWriteChat() || readingFiles) return;
            attachments[control.key].splice(index, 1); renderAttachments(); composerError('');
          });
          remove.className = 'chat-file-remove';
          remove.setAttribute('aria-label', 'Remove ' + file.name);
          chip.append(element('span', null, 'chat-file-name', file.name), element('span', null, 'chat-file-size', fileSize(file.size)), remove);
          nodes.tray.appendChild(chip);
        }
      }
      nodes.tray.hidden = !nodes.tray.childElementCount;
      syncChatControls();
    }
    function filePayload(file) {
      return new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        readers.add(reader);
        function finish(error, value) {
          readers.delete(reader);
          reader.onload = reader.onerror = reader.onabort = null;
          error ? reject(error) : resolve(value);
        }
        reader.onerror = () => finish(new Error('Could not read ' + file.name));
        reader.onabort = () => finish(new Error('Attachment read cancelled.'));
        reader.onload = () => {
          const result = String(reader.result || ''), comma = result.indexOf(',');
          if (comma < 0 || result.length - comma - 1 > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
            return finish(new Error('Could not encode ' + file.name + ' within the attachment byte limit.'));
          finish(null, { name: file.name, type: file.type || '', size: file.size, data: result.slice(comma + 1) });
        };
        try { reader.readAsDataURL(file); } catch (error) { finish(error); }
      });
    }
    async function addFiles(control, files) {
      if (!canWriteChat() || readingFiles) return;
      const incoming = Array.from(files || []), previous = attachments[control.key] || [];
      if (previous.length + incoming.length > control.max_files) { composerError('Up to ' + control.max_files + ' files can be attached.'); return; }
      if (incoming.some(file => !Number.isFinite(file.size) || file.size < 0)) { composerError('Invalid attachment size.'); return; }
      const incomingBytes = incoming.reduce((sum, file) => sum + file.size, 0);
      const existingBytes = Object.values(attachments).flat().reduce((sum, file) => sum + file.size, 0);
      if (incomingBytes + previous.reduce((sum, file) => sum + file.size, 0) > control.max_total_bytes
        || incomingBytes + existingBytes > MAX_ATTACHMENT_BYTES) {
        composerError('Attachments can total up to ' + fileSize(Math.min(control.max_total_bytes, MAX_ATTACHMENT_BYTES)) + '.'); return;
      }
      const view = epoch, ownAttachments = attachments;
      readingFiles = true; composerError(''); syncChatControls();
      try {
        const payloads = await Promise.all(incoming.map(filePayload));
        if (!current(view) || attachments !== ownAttachments || !canWriteChat()) return;
        attachments[control.key] = previous.concat(payloads);
        renderAttachments();
      } catch (error) {
        if (current(view) && attachments === ownAttachments) {
          for (const reader of readers) { try { reader.abort(); } catch (_) {} }
          composerError(error.message || 'Could not read that file.');
        }
      } finally {
        if (current(view)) { readingFiles = false; syncChatControls(); }
      }
    }

    function sessionPath(sessionId) { return '/api/sessions/' + encodeURIComponent(sessionId); }
    function sessionTitle(session) { return typeof session.title === 'string' && session.title ? session.title : session.id; }
    function validateSession(session, sessionId, agentId) {
      if (!session || String(session.id) !== sessionId || String(session.agent_id) !== agentId)
        throw new Error('Session metadata changed or belongs to a different agent. Reopen History to retry.');
      return session;
    }
    function updateSessionTitle(sessionId, title) {
      if (!current(epoch) || typeof title !== 'string') return;
      for (const card of sessionCards) {
        if (String(card.session.id) !== String(sessionId)) continue;
        card.session.title = title;
        card.sync(); // Never touch an in-progress edit or the chat/composer DOM.
      }
      if (target.sessionId === String(sessionId)) { target.title = title; notify(); }
    }
    function applySessionMetadata(session) {
      if (session.renderer) persistedRenderer = session.renderer;
      if (typeof session.title === 'string') target.title = session.title;
      target.launchId = session.launch_id;
    }
    function updateLaunch(frame) {
      if (Object.prototype.hasOwnProperty.call(frame, 'launch_id')) target.launchId = frame.launch_id;
      for (const card of sessionCards) if (String(card.session.id) === target.sessionId) card.session.state = 'live';
      if (['next_turn', 'pending'].includes(frame.context_resume)) {
        nodes.resumeNote.textContent = 'Next message resumes the CLI conversation. Native history is checked on that turn, not during preparation.';
        nodes.resumeNote.hidden = false;
      } else if (Object.prototype.hasOwnProperty.call(frame, 'context_resume')) nodes.resumeNote.hidden = true;
    }
    function showPreparingResumeNotice() {
      nodes.resumeNote.textContent = 'Preparing to resume the same CLI conversation. Native history has not been verified; the next message may perform that check.';
      nodes.resumeNote.hidden = false;
    }
    function resumeBlocked(session) {
      if (!canOperate()) return 'Read-only: an Operator, Admin or Owner is required to resume.';
      // DeepOrca's explicit continuation has its own native binding checks.
      // Generic resume metadata must not authorize adopting an unknown context.
      if (sessionRuntimeContract(session).explicitContinuation)
        return 'Use Continue native conversation for an inactive DeepOrca session; generic native resume is unavailable.';
      if (session.surface !== 'structured') return 'Native resume is supported only for compatible Chat sessions, not Terminal sessions.';
      if (!session.resume_supported) return session.resume_reason || 'This runtime does not support native resume.';
      if (session.state === 'starting') return 'This session is already starting. View history or attach once it is live.';
      if (!session.can_resume) return session.resume_reason || 'Resume is unavailable. Check that the connector is online.';
      return '';
    }
    function mountSessionCard(metadata, parent, navigation = true, history = false) {
      const session = { ...metadata }, view = epoch, agentId = target.agentId, sessionId = String(session.id);
      const row = element('div', history ? 'history-item' : 'session-header', history ? 'history-item pane-session-card' : 'pane-session-card');
      const title = element('b', 'session-title', 'session-title');
      // Collapsed by default: title + state stay visible; the toggle reveals the unchanged details.
      const state = element('span', 'session-state', 'pane-session-state');
      const details = element('div', 'session-details', 'pane-session-details');
      details.id = namespace + '-session-details-' + (++sessionCardSeq);
      details.hidden = true;
      const toggle = button('session-details-toggle', 'Details', () => {
        details.hidden = !details.hidden;
        toggle.setAttribute('aria-expanded', String(!details.hidden));
      });
      toggle.className = 'ghost pane-session-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', details.id);
      const detail = element('span', 'session-detail', 'muted');
      const actions = element('div', null, 'pane-session-actions');
      const reason = element('span', 'session-action-reason', 'muted');
      const error = element('span', 'session-action-error', 'pane-error');
      error.setAttribute('role', 'alert');
      const edit = element('form', 'session-rename-form', 'session-rename-form');
      edit.hidden = true;
      const input = element('input', 'session-rename-input');
      input.type = 'text'; input.maxLength = 120; input.setAttribute('aria-label', 'Session title');
      let editing = false, saving = false, expectedTitle;
      const allowedRename = () => canOperate() && session.can_rename === true;
      const rename = button('session-rename', 'Rename', () => {
        if (editing || saving || sessionActionPending || !allowedRename()) return;
        expectedTitle = session.title;
        input.value = session.title || '';
        editing = true; error.textContent = ''; card.sync(); input.focus();
      });
      const save = button('session-rename-save', 'Save', saveTitle);
      const cancel = button('session-rename-cancel', 'Cancel', () => {
        if (saving) return;
        editing = false; error.textContent = ''; card.sync();
      });
      edit.append(input, save, cancel);
      listen(edit, 'submit', event => { event.preventDefault(); saveTitle(); });
      listen(input, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel.click(); } });
      async function saveTitle() {
        if (!current(view) || !editing || saving || !allowedRename()) return;
        const value = input.value.trim();
        if (!value || Array.from(value).length > 120 || /[\r\n\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value)) {
          error.textContent = 'Use a single-line title of 1–120 characters.'; card.sync(); return;
        }
        saving = true; error.textContent = ''; card.sync();
        try {
          const updated = await request(sessionPath(sessionId), { method: 'PATCH',
            body: JSON.stringify({ title: value, expected_title: expectedTitle }) });
          if (!current(view) || !allowedRename()) return;
          validateSession(updated, sessionId, agentId);
          Object.assign(session, updated);
          editing = false;
          publishTitle(targetWorkspace, sessionId, updated.title);
        } catch (failure) {
          if (current(view)) error.textContent = failure.status === 409
            ? 'Title changed elsewhere. Your draft is kept. Cancel and reopen History to refresh before retrying.'
            : failure.message || 'Could not rename. Your draft is kept.';
        } finally { if (current(view)) { saving = false; card.sync(); } }
      }
      const action = button(history && session.state === 'live' && validSurface(session.surface) ? 'history-attach' : 'session-resume',
        session.state === 'live' ? 'Attach live' : 'Resume', async () => {
          if (sessionActionPending || saving || editing) return;
          if (session.state === 'live') {
            if (session.available === false || !validSurface(session.surface)) return;
            return open({ kind: 'live', agentId, sessionId, title: sessionTitle(session), surface: session.surface });
          }
          if (resumeBlocked(session)) return;
          sessionActionPending = true; error.textContent = ''; syncAccess();
          try {
            const latest = await request(sessionPath(sessionId));
            if (!current(view) || !canOperate()) return;
            validateSession(latest, sessionId, agentId);
            Object.assign(session, latest); updateSessionTitle(sessionId, latest.title);
            if (latest.state !== 'live' && resumeBlocked(latest)) { error.textContent = resumeBlocked(latest); return; }
            if (latest.state === 'live' && (latest.available === false || latest.surface !== 'structured')) {
              error.textContent = 'The live session is unavailable or its surface changed. Reopen History.'; return;
            }
            const activation = { session: latest, resume: latest.state !== 'live',
              recording: target.kind === 'replay' && target.sessionId === sessionId ? recording : null };
            await open({ kind: 'live', agentId, sessionId, title: sessionTitle(latest), surface: latest.surface }, activation);
          } catch (failure) { if (current(view)) error.textContent = failure.message || 'Could not prepare resume.'; }
          finally { if (current(view)) { sessionActionPending = false; syncAccess(); } }
        });
      const continuation = navigation && sessionRuntimeContract(session).explicitContinuation && session.state === 'inactive'
        ? button('history-continue-native', 'Continue native conversation', () => {
          if (saving || editing || sessionActionPending || !canContinueNative(session)) return;
          return open({ kind: 'live', agentId, sessionId, title: sessionTitle(session),
            surface: session.surface, continueNative: true });
        }) : null;
      if (history) actions.appendChild(button('history-replay', 'View history', () => open({
        kind: 'replay', agentId, sessionId, title: sessionTitle(session), surface: validSurface(session.surface),
      })));
      actions.appendChild(rename);
      if (continuation) actions.appendChild(continuation);
      if (navigation) actions.appendChild(action);
      details.append(detail, actions, edit, reason);
      row.append(title, state, toggle, details, error);
      const card = { session, sync() {
        title.textContent = sessionTitle(session);
        state.textContent = session.state || 'unknown';
        state.setAttribute('data-state', session.state || 'unknown');
        detail.textContent = sessionId + ' · ' + (session.surface === 'structured' ? 'Chat' : session.surface === 'terminal' ? 'Terminal' : 'Legacy surface unknown')
          + ' · ' + (session.state || 'unknown') + (session.created_at ? ' · started ' + session.created_at : '');
        edit.hidden = !editing; rename.hidden = editing;
        rename.disabled = saving || sessionActionPending || !allowedRename();
        input.disabled = saving || !allowedRename(); save.disabled = saving || !allowedRename(); cancel.disabled = saving;
        action.textContent = sessionActionPending ? 'Preparing resume…' : session.state === 'live' ? 'Attach live' : 'Resume';
        const blocked = session.state === 'live'
          ? session.available === false ? 'The connector or runtime is offline; live attach is unavailable.'
            : !validSurface(session.surface) ? 'This session has no supported live surface.' : ''
          : resumeBlocked(session);
        action.disabled = saving || editing || sessionActionPending || !!blocked;
        if (continuation) continuation.disabled = saving || editing || sessionActionPending || !canContinueNative(session);
        const renameReason = allowedRename() ? '' : !canOperate() ? 'Read-only: renaming requires an Operator, Admin or Owner.' : 'Renaming is not available for this session.';
        reason.textContent = [renameReason, navigation ? blocked : ''].filter(Boolean).join(' ');
        reason.hidden = !reason.textContent; error.hidden = !error.textContent;
      } };
      sessionCards.push(card);
      if (history) parent.appendChild(row); else parent.insertBefore(row, parent.firstChild);
      card.sync();
      return card;
    }
    function recordingNote(message) {
      if (!nodes.recordingNote) {
        nodes.recordingNote = element('p', 'recording-notice', 'pane-session-note');
        nodes.body.insertBefore(nodes.recordingNote, nodes.scroll?.parentNode || nodes.terminal || null);
      }
      nodes.recordingNote.textContent = message + ' Recording retention is separate from native CLI resume availability.';
    }
    async function openActivated(view, activation) {
      const session = activation.session;
      applySessionMetadata(session);
      mountSessionCard(session, nodes.body, false);
      if (!mountSurface()) return;
      setStatus('starting', activation.resume ? 'Preparing resume…' : 'Attaching live…');
      if (activation.resume) showPreparingResumeNotice();
      let data = activation.recording;
      if (!data) {
        try { data = await request(sessionPath(target.sessionId) + '/replay'); }
        catch (failure) { if (current(view)) recordingNote('The recorded transcript is unavailable: ' + (failure.message || 'not retained') + '.'); }
      }
      if (!current(view)) return;
      if (data) {
        const saved = Replay.normalizeReplay(data);
        for (const event of saved.events)
          if (event.kind === 'event' || event.type === 'event') chat = Chat.foldEventPayload(chat, event.data, false).state;
        if (!saved.events.length && !saved.checkpoints.length) recordingNote('No recorded transcript is available for this session.');
        // A historical permission prompt is not a current runtime request.
        chat.pendingPermission = null;
        controlValues = Chat.reconcileControlValues(controls, controlValues, chat.config);
        renderChat();
      }
      if (activation.resume && !canOperate()) { reportError('Read-only: permission to resume was revoked.'); return; }
      wantOpen = true; liveActive = false;
      connectSocket(activation.resume ? { launch_id: session.launch_id ?? null } : null);
    }
    async function loadHistory(view) {
      const sessions = await request(agentPath());
      if (!current(view)) return;
      if (!Array.isArray(sessions)) throw new Error('Invalid session list.');
      const list = element('div', 'history', 'history-wrap');
      const create = button('history-new', 'New session', newSession);
      create.disabled = !canOperate();
      list.appendChild(create);
      if (!sessions.length) list.appendChild(element('p', null, 'muted', 'No sessions recorded.'));
      for (const session of sessions) {
        mountSessionCard(session, list, true, true);
      }
      nodes.body.appendChild(list);
      setStatus('history', 'Session history');
    }
    async function loadReplay(view) {
      if (!target.sessionId) { unavailable('Choose a saved session from History to view.', false); return; }
      const sessionId = target.sessionId, agentId = target.agentId;
      const metadata = await request(sessionPath(sessionId));
      if (!current(view)) return;
      validateSession(metadata, sessionId, agentId);
      applySessionMetadata(metadata);
      target.surface = validSurface(metadata.surface) || target.surface;
      mountSessionCard(metadata, nodes.body);
      let data;
      try { data = await request(sessionPath(sessionId) + '/replay'); }
      catch (failure) {
        if (!current(view)) return;
        data = { surface: target.surface, events: [], checkpoints: [] };
        recordingNote('The recorded transcript is unavailable: ' + (failure.message || 'not retained') + '.');
      }
      if (!current(view)) return;
      recording = Replay.normalizeReplay(data);
      persistedRenderer = data.renderer || data.session?.renderer || persistedRenderer;
      if (!recording.events.length && !recording.checkpoints.length && !nodes.recordingNote)
        recordingNote('No recorded transcript is available for this session.');
      target.surface = validSurface(data.surface) || target.surface ||
        (recording.events.some(event => event.kind === 'event' || event.type === 'event') ? 'structured' : 'terminal');
      let rendererReady = true;
      if (target.surface === 'terminal' && services.ensureTerminal) {
        try { await services.ensureTerminal(); }
        catch (error) {
          if (!current(view)) return;
          rendererReady = false; setStatus('error', 'Terminal renderer unavailable'); reportError(error.message);
        }
        if (!current(view)) return;
      }
      const mounted = rendererReady && mountSurface();
      if (mounted) {
        renderSavedHistory();
        setStatus('history', 'Session history · read-only');
      }
    }
    function renderSavedHistory() {
      // Legacy target/API names stay compatible; saved history is a static final view.
      if (closed || target.kind !== 'replay' || !recording) return;
      if (target.surface === 'structured') {
        chat = Chat.initialChatState();
        for (const event of Replay.eventsBetween(recording.events, -Infinity, Infinity))
          if (event.kind === 'event' || event.type === 'event') chat = Chat.foldEventPayload(chat, event.data, false).state;
        renderChat();
      } else if (terminal) {
        terminal.reset();
        const index = Replay.nearestCheckpointIndex(recording.checkpoints, Infinity);
        let startTime = -Infinity, startCursor = null;
        if (index >= 0) {
          const checkpoint = recording.checkpoints[index];
          if (checkpoint.serialized_screen) terminal.write(checkpoint.serialized_screen);
          startTime = checkpoint.time; startCursor = checkpoint.cursor;
        }
        for (const event of Replay.eventsBetween(recording.events, startTime, Infinity, startCursor))
          if ((event.type === 'o' || event.type === 'output') && event.data != null) terminal.write(event.data);
      }
    }

    function reconnect() {
      if (closed || !target) return Promise.resolve(getState());
      if (target.kind === 'live' && target.sessionId && status !== 'ended' && status !== 'inactive' && (terminal || chat)) {
        wantOpen = true; reconnectDelay = 500; clearError(); connectSocket();
        return Promise.resolve(getState());
      }
      return open({ ...snapshot(), restore: restoreRequested });
    }
    function newSession() {
      if (!canOperate() || !target) return Promise.resolve(getState());
      return open({ kind: 'live', agentId: target.agentId, title: target.title, surface: target.surface, forceNew: true });
    }
    async function endSession() {
      if (endPending || !canEndSession()) return false;
      const view = epoch, sessionId = target.sessionId, launchId = target.launchId;
      endPending = true;
      try {
        const ok = services.confirm && await services.confirm('End this session?', 'This stops the runtime for everyone in this session. Saved history remains available.', 'End session');
        if (!ok || !current(view) || target.sessionId !== sessionId || target.launchId !== launchId || !canEndSession()) return false;
        return sendFrame('terminate');
      } catch (error) { if (current(view)) reportError(error.message || 'Could not end the session.'); return false; }
      finally { if (current(view)) endPending = false; }
    }
    function showHistory() {
      if (closed || !target) return Promise.resolve(getState());
      return open({ kind: 'history', agentId: target.agentId, title: target.title, surface: target.surface });
    }
    function close() {
      if (closed) return;
      reset(); closed = true; target = null; status = 'closed'; statusText = 'Closed';
      titleObservers.delete(observeTitle);
      notify();
    }
    function refreshAccess() {
      if (closed) return;
      syncAccess();
      const create = root.querySelector('[data-ui="history-new"]');
      if (create) create.disabled = !canOperate();
      notify();
    }
    return { id, open, getState, snapshot, focus, resize, close, reconnect, newSession, endSession,
      showHistory, requestKeyboard, releaseKeyboard, handoffKeyboard, interrupt, sendPrefix, refreshAccess };
  }

  return { createPane };
});
