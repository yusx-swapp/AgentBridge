const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowser, deferred } = require('./test-dom.js');

const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
const ui = (root, name) => root.querySelector('[data-ui="' + name + '"]');
const inputFrames = socket => socket.frames.filter(frame => frame.type === 'input');
function assertNoRecordingControls(root) {
  for (const name of ['replay-controls', 'replay-play', 'replay-start', 'replay-end', 'replay-speed',
    'replay-seek', 'replay-time', 'replay-final', 'replay-download', 'replay-retention', 'replay-delete'])
    assert.equal(Boolean(ui(root, name)), false, name + ' must not be rendered');
}
const session = (id, surface = 'structured', state = 'live', extra = {}) => ({ id, surface, state, ...extra });
const payload = (...events) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const collaboration = (role = 'operator', holder = false) => ({
  type: 'collaboration', role,
  keyboard: { holder_user_id: holder ? 7 : 8, holder_username: holder ? 'me' : 'other',
    is_holder: holder, can_request: role !== 'viewer' && !holder },
});

function harness(options = {}) {
  const browser = createBrowser(options);
  const module = browser.loadModule('pane.js');
  const requests = [], changes = [], confirms = [], alerts = [], panes = [];
  const sessions = new Map(), recordings = new Map();
  const workspace = { id: 'workspace', role: options.role || 'operator' };
  const user = { id: 7, username: 'me' };
  const runtime = {
    schema_version: 2, runtime: 'runtime',
    models: { items: [{ id: 'model-a' }, { id: 'model-b' }], allow_custom: true },
    surfaces: [
      { id: 'terminal', available: true, default: false, features: {} },
      { id: 'structured', available: true, default: true, features: { controls: [
        { key: 'model', kind: 'select', label: 'Model', scope: 'session', allow_custom: true, choices: ['model-a', 'model-b'] },
        { key: 'effort', kind: 'select', label: 'Effort', choices: ['low', 'high'] },
        { key: 'files', kind: 'file', label: 'Attach files', max_files: 2, max_total_bytes: 32, accept: 'text/plain' },
      ] } },
    ],
  };
  let nextSession = 0;
  const h = { ...browser, requests, changes, confirms, alerts, sessions, recordings, workspace, user, runtime };
  async function api(path, options = {}) {
    requests.push({ path, ...options });
    if (h.apiOverride) {
      const handled = h.apiOverride(path, options);
      if (handled !== undefined) return handled;
    }
    const list = path.match(/^\/api\/agents\/([^/]+)\/sessions$/);
    if (list) {
      const agentId = decodeURIComponent(list[1]);
      if (!options.method || options.method === 'GET') return sessions.get(agentId) || [];
      assert.equal(options.method, 'POST');
      const created = session(agentId + '-created-' + ++nextSession, JSON.parse(options.body).surface,
        'live', { agent_id: agentId, title: 'New chat', can_rename: true });
      sessions.set(agentId, [...(sessions.get(agentId) || []), created]);
      return created;
    }
    const replay = path.match(/^\/api\/sessions\/([^/]+)\/replay$/);
    if (replay) return recordings.get(decodeURIComponent(replay[1])) || { surface: 'structured', events: [], checkpoints: [] };
    const metadata = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (metadata) {
      const sessionId = decodeURIComponent(metadata[1]);
      let found;
      for (const [agentId, items] of sessions) {
        const item = items.find(item => item.id === sessionId);
        if (item) { found = { title: item.id, agent_id: agentId, ...item }; break; }
      }
      // Legacy replay fixtures did not need a catalog row. Supply the new GET contract.
      found ||= { id: sessionId, agent_id: panes.find(pane => pane.getState().sessionId === sessionId)?.getState().agentId,
        title: sessionId, surface: recordings.get(sessionId)?.surface || 'structured', state: 'inactive' };
      if (options.method === 'PATCH') return { ...found, title: JSON.parse(options.body).title };
      return found;
    }
    if (options.method === 'PATCH' || options.method === 'DELETE') return {};
    throw new Error('Unexpected request: ' + path);
  }
  h.create = function (id, extraServices = {}) {
    const root = browser.document.createElement('section');
    root.setAttribute('data-pane-id', id);
    browser.document.body.appendChild(root);
    const pane = module.createPane({ id, root, services: {
      api, getUser: () => user, getWorkspace: () => workspace,
      findAgent: agentId => ({ agent: { id: agentId, display_name: 'Agent ' + agentId, runtime: 'runtime' }, box: { capabilities: [runtime] } }),
      confirm: async (...args) => { confirms.push(args); return h.confirmOverride ? h.confirmOverride(...args) : true; },
      alert: (...args) => alerts.push(args), onChange: state => changes.push(plain(state)), ...extraServices,
    } });
    panes.push(pane);
    return { pane, root };
  };
  h.attach = async function (pane, agentId, surface = 'structured', extra = {}, role = workspace.role, holder = false) {
    await pane.open({ kind: 'live', agentId, surface, ...extra });
    const socket = browser.sockets.at(-1);
    assert.ok(socket, 'live target creates a socket');
    socket.open(); socket.receive({ type: 'ready', surface }); socket.receive(collaboration(role, holder));
    return socket;
  };
  return h;
}

function submit(root, text) {
  const input = ui(root, 'chat-input');
  if (text !== undefined) input.value = text;
  input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() { this.prevented = true; } });
}

test('End uses current Chat role and keeps Terminal keyboard-lease enforcement', async () => {
  for (const surface of ['terminal', 'structured']) for (const role of ['viewer', 'operator', 'admin', 'owner']) for (const holder of [false, true]) {
    const h = harness({ role }), { pane } = h.create(role + '-' + surface);
    h.sessions.set('agent', [session('shared', surface)]);
    const socket = await h.attach(pane, 'agent', surface, {}, role, holder);
    const allowed = role !== 'viewer' && (surface === 'structured' || holder);
    assert.equal(pane.getState().canEndSession, allowed);
    assert.equal(await pane.endSession(), allowed);
    assert.equal(h.confirms.length, allowed ? 1 : 0);
    assert.equal(socket.frames.filter(frame => frame.type === 'terminate').length, allowed ? 1 : 0);
    pane.close();
  }
});

test('metadata refresh resolves a promotion without bypassing either permission check',async()=>{
  const h=harness({role:'viewer'});
  h.sessions.set('agent',[session('shared','structured')]);
  const {pane,root}=h.create('fresh-role');
  const socket=await h.attach(pane,'agent','structured',{sessionId:'shared'},'operator');
  assert.equal(ui(root,'chat-input').disabled,true);
  h.workspace.role='operator';pane.refreshAccess();
  assert.equal(pane.getState().readOnly,false);
  assert.equal(ui(root,'chat-input').disabled,false);
  assert.equal(ui(root,'keyboard'),null);
  assert.match(ui(root,'status').textContent,/Shared chat/);
  assert.equal(pane.getState().role,'operator');
  h.workspace.role='owner';
  socket.receive(collaboration('operator'));
  assert.equal(pane.getState().canEndSession,true,'the live Operator role permits End');
  socket.receive(collaboration('viewer'));
  assert.equal(pane.getState().canEndSession,false,'stale catalog owner cannot override the live Viewer role');
  assert.equal(ui(root,'chat-input').disabled,true);
  pane.close();
});

test('catalog promotion keeps saved history read-only without restoring recording controls',async()=>{
  const h=harness({role:'viewer'});
  h.recordings.set('recorded',{surface:'structured',events:[],retention:'7d'});
  const {pane,root}=h.create('recording-roles');
  await pane.open({kind:'replay',agentId:'agent',sessionId:'recorded',surface:'structured'});
  const transcript=ui(root,'chat-scroll');assertNoRecordingControls(root);
  const count=h.requests.length;h.workspace.role='owner';pane.refreshAccess();
  assertNoRecordingControls(root);assert.equal(h.requests.length,count);
  assert.strictEqual(ui(root,'chat-scroll'),transcript);
  assert.equal(pane.getState().readOnly,true);
  assert.equal(ui(root,'chat-composer').hidden,true);
  pane.close();
});

test('dragging does not resend unchanged sizes, and hidden terminals never resize the runtime', async () => {
  const h = harness();
  const {pane,root} = h.create('sizing');
  const socket = await h.attach(pane,'agent','terminal',{},'operator',true);
  const count = () => socket.frames.filter(frame=>frame.type==='resize').length;
  const initial = count();
  for(let i=0;i<10;i++) pane.resize();
  assert.equal(count(),initial);
  h.terminals[0].cols = 90; pane.resize();
  assert.equal(count(),initial+1);
  root.clientWidth = 0; h.terminals[0].cols = 80; pane.resize();
  assert.equal(count(),initial+1);
  root.clientWidth = 800; pane.resize();
  assert.equal(count(),initial+2);
  socket.receive(collaboration('operator',false));
  socket.receive(collaboration('operator',true));
  assert.equal(count(),initial+3,'reacquiring the keyboard must establish this view size');
  pane.close();
});

test('a newly-created inactive row still attaches instead of being mistaken for a recording', async () => {
  const h = harness();
  h.apiOverride = (path, options) => options.method === 'POST'
    ? {id:'new-row',agent_id:'agent',surface:'structured',state:'inactive',available:false} : undefined;
  const {pane} = h.create('new-inactive');
  await pane.open({kind:'live',agentId:'agent',surface:'structured',forceNew:true});
  assert.equal(pane.getState().kind, 'live');
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open();
  assert.equal(h.sockets[0].frames[0].type, 'attach');
  assert.equal(h.sockets[0].frames[0].session_id, 'new-row');
  assert.ok(!h.requests.some(call => call.path.endsWith('/replay')));
  pane.close();
});

test('a cancelled renderer load never creates a stale terminal session', async () => {
  const h = harness(), assets = deferred();
  const {pane} = h.create('loading-assets', {ensureTerminal: () => assets.promise});
  const first = pane.open({kind:'live',agentId:'terminal-agent',surface:'terminal'});
  await flush();
  assert.equal(h.requests.filter(call => call.method === 'POST').length, 0);
  await pane.open({kind:'live',agentId:'chat-agent',surface:'structured'});
  assets.resolve(); await first;
  assert.equal(h.requests.filter(call => call.method === 'POST').length, 1);
  assert.equal(pane.snapshot().agentId, 'chat-agent');
  assert.equal(h.terminals.length, 0);
  pane.close();
});

test('failed terminal assets preserve history metadata and errors without recording controls', async () => {
  const h = harness({role:'owner'});
  h.recordings.set('recorded',{surface:'terminal',events:[],checkpoints:[],retention:'7d'});
  const {pane,root} = h.create('replay-without-assets',{ensureTerminal:async()=>{ throw new Error('Renderer unavailable'); }});
  await pane.open({kind:'replay',agentId:'agent',sessionId:'recorded',surface:'terminal'});
  assertNoRecordingControls(root);
  assert.ok(ui(root,'session-header'));
  assert.equal(h.sockets.length,0);
  assert.equal(h.timers.size,0);
  assert.match(root.textContent,/Renderer unavailable/);
  pane.close();
});

test('public CommonJS and UMD boundaries support canonical helpers and a single legacy fallback', () => {
  assert.deepEqual(Object.keys(require('./pane.js')), ['createPane']);
  for (const canonical of [false, true]) {
    const h = createBrowser();
    for (const [file, name] of [['ui.js', 'UI'], ['chat.js', 'Chat'], ['collaboration.js', 'Collaboration'], ['replay.js', 'Replay']]) {
      h.loadScript(file);
      if (canonical) {
        h.window['AgentBridge' + name] ||= h.window['Deepbox' + name];
        delete h.window['Deepbox' + name];
      }
    }
    h.loadScript('pane.js');
    assert.equal(typeof h.window.AgentBridgePane.createPane, 'function');
    assert.equal(h.window.curSession, undefined);
  }
});

test('two Chat panes own drafts, controls, transcripts and sockets; tokens do not emit state changes', async () => {
  const h = harness(), a = h.create('left'), b = h.create('right');
  const sa = await h.attach(a.pane, 'a'), sb = await h.attach(b.pane, 'b');
  assert.equal(h.terminals.length, 0);
  assert.equal(h.document.activeElement, h.document.body, 'attachment does not steal focus');
  a.pane.focus(); h.type('draft A');
  b.pane.focus(); h.type('draft B');
  const modelA = a.root.querySelector('[data-chat-control="model"]');
  const modelB = b.root.querySelector('[data-chat-control="model"]');
  assert.notEqual(modelA.getAttribute('list'), modelB.getAttribute('list'));
  modelA.value = 'model-b'; modelA.dispatchEvent({ type: 'input' });
  submit(a.root);
  assert.equal(inputFrames(sa)[0].data, 'draft A');
  assert.equal(inputFrames(sa)[0].options.model, 'model-b');
  assert.equal(inputFrames(sb).length, 0);
  assert.equal(ui(b.root, 'chat-input').value, 'draft B');
  assert.equal(modelB.value, '');
  submit(b.root);
  assert.equal(inputFrames(sb)[0].data, 'draft B');
  const changes = h.changes.length;
  sa.receive({ type: 'output', kind: 'event', data: payload({ ev: 'message.delta', text: 'ONLY LEFT' }) });
  assert.match(ui(a.root, 'chat-scroll').textContent, /ONLY LEFT/);
  assert.doesNotMatch(ui(b.root, 'chat-scroll').textContent, /ONLY LEFT/);
  assert.equal(h.changes.length, changes);
  assert.equal(h.document.activeElement, ui(b.root, 'chat-input'));
  a.pane.close(); b.pane.close();
});

test('terminal focus routes ordinary typing, not protocol responses; each lease gates input and resize', async () => {
  const h = harness(), a = h.create('left'), b = h.create('right');
  const sa = await h.attach(a.pane, 'a', 'terminal', {}, 'operator', true);
  const sb = await h.attach(b.pane, 'b', 'terminal', {}, 'operator', true);
  const [ta, tb] = h.terminals;
  a.pane.focus(); h.type('a'); b.pane.focus(); h.type('b');
  ta.emit('\u001b[1;1R'); // DSR while the other pane owns focus is still this terminal's response.
  assert.deepEqual(inputFrames(sa).map(frame => frame.data), ['a', '\u001b[1;1R']);
  assert.deepEqual(inputFrames(sb).map(frame => frame.data), ['b']);
  sa.receive(collaboration('operator', true));
  assert.equal(h.document.activeElement, tb.input, 'collaboration does not steal another pane focus');
  sa.receive(collaboration('operator', false));
  const oldFrames = sa.frames.length;
  ta.emit('blocked'); a.pane.resize();
  assert.equal(sa.frames.length, oldFrames);
  assert.equal(a.pane.getState().readOnly, true);
  const bFrames = sb.frames.length;
  tb.cols += 1;
  b.pane.resize();
  assert.equal(sb.frames.length, bFrames + 1);
  assert.equal(sb.frames.at(-1).type, 'resize');
  a.pane.close(); b.pane.close();
});

test('explicit Terminal ignores Chat, unknown, inactive and ended sessions, using actual state not alive', async () => {
  const h = harness(), { pane } = h.create('explicit');
  h.sessions.set('a', [session('chat'), { id: 'legacy', state: 'live' }, session('inactive', 'terminal', 'inactive'),
    session('ended', 'terminal', 'ended'), { id: 'pretend', surface: 'terminal', alive: true }]);
  await h.attach(pane, 'a', 'terminal');
  assert.match(pane.getState().sessionId, /^a-created-/);
  assert.equal(JSON.parse(h.requests.find(request => request.method === 'POST').body).surface, 'terminal');
  assert.equal(h.sockets[0].frames[0].surface, 'terminal');
  const id = pane.getState().sessionId;
  await pane.reconnect();
  assert.equal(pane.getState().sessionId, id);
  assert.equal(pane.snapshot().surface, 'terminal');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  await pane.newSession();
  assert.notEqual(pane.getState().sessionId, id);
  assert.equal(pane.getState().surface, 'terminal');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 2);
  assert.ok(h.sockets.every(socket => !socket.frames.some(frame => frame.type === 'terminate')));
  pane.close();
});

test('an exact live surface is reused without alive; explicit session mismatches fail visibly', async () => {
  const h = harness(), { pane, root } = h.create('reuse');
  h.sessions.set('a', [session('structured-live'), session('terminal-live', 'terminal')]);
  await h.attach(pane, 'a', 'terminal');
  assert.equal(pane.getState().sessionId, 'terminal-live');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
  await pane.open({ kind: 'live', agentId: 'a', sessionId: 'structured-live', surface: 'terminal' });
  assert.equal(pane.getState().status, 'unavailable');
  assert.match(ui(root, 'error').textContent, /selected surface/);
  assert.equal(h.sockets.length, 1);
  pane.close();
});

test('Chat works with missing xterm; Terminal fails before a create request', async () => {
  const h = harness({ terminal: false }), { pane, root } = h.create('missing-xterm');
  await h.attach(pane, 'a');
  submit(root, 'chat works');
  assert.equal(inputFrames(h.sockets[0]).length, 1);
  const posts = h.requests.filter(request => request.method === 'POST').length;
  await pane.open({ kind: 'live', agentId: 'b', surface: 'terminal', forceNew: true });
  assert.equal(pane.getState().status, 'error');
  assert.match(ui(root, 'error').textContent, /xterm/);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, posts);
  assert.equal(h.terminals.length, 0);
  pane.close();
});

test('restore never creates for absent, missing, inactive, ended or unavailable targets, even with forceNew', async () => {
  const h = harness({ terminal: false }), { pane, root } = h.create('restore');
  await pane.open({ kind: 'live', agentId: 'a', surface: 'structured', restore: true, forceNew: true });
  assert.equal(pane.getState().status, 'unavailable');
  assert.ok(ui(root, 'open-live'));
  await pane.reconnect();
  h.sessions.set('a', [session('ended', 'structured', 'ended'), session('inactive', 'structured', 'inactive'),
    session('offline', 'structured', 'live', { available: false }), session('resumable')]);
  for (const id of ['missing', 'ended', 'inactive', 'offline']) {
    await pane.open({ kind: 'live', agentId: 'a', sessionId: id, surface: 'structured', restore: true });
    assert.ok(['unavailable', 'history'].includes(pane.getState().status));
  }
  await h.attach(pane, 'a', 'structured', { sessionId: 'resumable', restore: true, forceNew: true });
  assert.equal(pane.getState().sessionId, 'resumable');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(h.terminals.length, 0);
  pane.close();
});

test('stale list and POST resolutions cannot create or attach a replacement target', async () => {
  const h = harness(), a = h.create('a'), b = h.create('b');
  const list = deferred();
  h.apiOverride = (path, options) => path === '/api/agents/old/sessions' && !options.method ? list.promise : undefined;
  const old = a.pane.open({ kind: 'live', agentId: 'old', surface: 'terminal' });
  await h.attach(a.pane, 'new');
  await h.attach(b.pane, 'other');
  const socketCount = h.sockets.length;
  list.resolve([]); await old;
  assert.equal(a.pane.getState().agentId, 'new');
  assert.equal(b.pane.getState().agentId, 'other');
  assert.equal(h.sockets.length, socketCount);
  assert.ok(!h.requests.some(request => request.path.includes('/old/') && request.method === 'POST'));
  const post = deferred();
  h.apiOverride = (path, options) => path.includes('/pending/') && options.method === 'POST' ? post.promise : undefined;
  const pending = a.pane.open({ kind: 'live', agentId: 'pending', surface: 'terminal', forceNew: true });
  const disposedTerminal = h.terminals.at(-1);
  await h.attach(a.pane, 'new');
  post.resolve(session('late-terminal', 'terminal')); await pending;
  assert.ok(disposedTerminal.disposed);
  assert.equal(a.pane.getState().agentId, 'new');
  assert.ok(!h.sockets.some(socket => socket.frames.some(frame => frame.session_id === 'late-terminal')));
  a.pane.close(); b.pane.close();
});

test('stale WS, xterm, and retained DOM callbacks are inert across target changes and close', async () => {
  const h = harness(), { pane, root } = h.create('stale');
  const oldSocket = await h.attach(pane, 'a', 'terminal', {}, 'operator', true);
  const callbacks = { message: oldSocket.onmessage, open: oldSocket.onopen, error: oldSocket.onerror,
    close: oldSocket.onclose, input: h.terminals[0].data, observer: h.observers[0].callback };
  const socket = await h.attach(pane, 'b');
  const state = plain(pane.getState()), frames = oldSocket.frames.length, changes = h.changes.length;
  callbacks.message({ data: JSON.stringify({ type: 'exit', code: 5 }) });
  callbacks.open(); callbacks.error(); callbacks.close(); callbacks.input('stale'); callbacks.observer();
  socket.receive({ type: 'output', kind: 'event', session_id: 'wrong', data: payload({ ev: 'message.delta', text: 'wrong' }) });
  assert.deepEqual(plain(pane.getState()), state);
  assert.equal(oldSocket.frames.length, frames);
  assert.equal(h.changes.length, changes);
  assert.doesNotMatch(root.textContent, /wrong/);
  socket.receive({ type: 'output', kind: 'event', data: payload({ ev: 'permission.ask', request_id: 'old', tool: 'run' }) });
  const permission = root.querySelector('.chat-perm-allow');
  const onmessage = socket.onmessage, onclose = socket.onclose;
  pane.close();
  permission.click(); onmessage({ data: JSON.stringify({ type: 'ready' }) }); onclose(); callbacks.observer();
  assert.equal(root.childElementCount, 0);
  assert.equal(pane.getState().status, 'closed');
  assert.equal(pane.snapshot(), null);
  assert.equal(h.timers.size, 0);
  assert.ok(h.sockets.every(socket => !socket.frames.some(frame => frame.type === 'permission' || frame.type === 'terminate')));
  assert.ok(h.requests.every(request => request.signal?.aborted));
  const count = h.requests.length;
  await pane.open({ kind: 'live', agentId: 'again' }); await pane.reconnect(); await pane.newSession(); await pane.showHistory();
  assert.equal(h.requests.length, count);
});

test('Chat permission and interrupt use operator role without a terminal lease; viewer cannot bypass disabled controls', async () => {
  const h = harness(), a = h.create('operator'), b = h.create('viewer', { getWorkspace: () => ({ role: 'viewer' }) });
  h.sessions.set('b', [session('viewer-session')]);
  const sa = await h.attach(a.pane, 'a', 'structured', {}, 'operator', false);
  const sb = await h.attach(b.pane, 'b', 'structured', {}, 'viewer', true);
  for (const socket of [sa, sb]) socket.receive({ type: 'output', kind: 'event', data: payload({ ev: 'permission.ask', request_id: 'request', tool: 'run' }) });
  a.root.querySelector('.chat-perm-allow').click(); ui(a.root, 'chat-interrupt').click(); submit(a.root, 'operator message');
  assert.ok(sa.frames.some(frame => frame.type === 'permission' && frame.allow));
  assert.ok(sa.frames.some(frame => frame.type === 'interrupt'));
  assert.equal(inputFrames(sa).length, 1);
  assert.equal(a.pane.requestKeyboard(), false);
  assert.equal(h.timers.size, 0);
  assert.equal(b.pane.getState().readOnly, true);
  const denied = b.root.querySelector('.chat-perm-deny');
  assert.equal(denied.disabled, true);
  denied.disabled = false; denied.click();
  ui(b.root, 'chat-interrupt').disabled = false; ui(b.root, 'chat-interrupt').click();
  submit(b.root, 'keep viewer draft');
  assert.equal(ui(b.root, 'chat-input').value, 'keep viewer draft');
  const requestCount = h.requests.length;
  await b.pane.newSession(); assert.equal(await b.pane.endSession(), false);
  assert.equal(b.pane.requestKeyboard(), false);
  assert.equal(h.requests.length, requestCount);
  assert.deepEqual(sb.frames.map(frame => frame.type), ['attach']);
  a.pane.close(); b.pane.close();
});

test('current workspace getters constrain cached server permissions, including after End confirmation', async () => {
  const h = harness(), { pane, root } = h.create('role-change');
  const socket = await h.attach(pane, 'a', 'structured', {}, 'admin', false);
  h.workspace.role = 'admin';
  assert.equal(pane.getState().canEndSession, true);
  const confirmation = deferred(); h.confirmOverride = () => confirmation.promise;
  const ending = pane.endSession();
  h.workspace.role = 'viewer';
  submit(root, 'role revoked');
  confirmation.resolve(true); assert.equal(await ending, false);
  assert.equal(pane.getState().canOperate, false);
  assert.equal(inputFrames(socket).length, 0);
  assert.ok(!socket.frames.some(frame => frame.type === 'terminate'));
  pane.close();
});

test('keyboard acquire/release/handoff/renew are per-terminal and End alone sends confirmed terminate', async () => {
  const h = harness(), a = h.create('a'), b = h.create('b');
  const sa = await h.attach(a.pane, 'a', 'terminal'), sb = await h.attach(b.pane, 'b', 'terminal', {}, 'operator', true);
  assert.equal(a.pane.requestKeyboard(), true);
  assert.equal(a.pane.releaseKeyboard(), false);
  assert.equal(a.pane.getState().canEndSession, false, 'Terminal End requires holding its keyboard lease');
  assert.equal(await a.pane.endSession(), false);
  assert.equal(h.confirms.length, 0);
  sa.receive(collaboration('operator', true));
  assert.equal(a.pane.releaseKeyboard(), true);
  sa.receive({ type: 'keyboard_request', requester_user_id: 9, requester_username: 'next' });
  assert.equal(a.pane.handoffKeyboard(), true);
  assert.equal(sa.frames.at(-1).target_user_id, 9);
  assert.equal(a.pane.handoffKeyboard(), false);
  for (const id of [...h.timers.keys()]) h.runTimer(id);
  assert.equal(sa.frames.filter(frame => frame.type === 'keyboard_renew').length, 1);
  assert.equal(sb.frames.filter(frame => frame.type === 'keyboard_renew').length, 1);
  assert.equal(await a.pane.endSession(), true);
  assert.equal(h.confirms.length, 1);
  assert.equal(sa.frames.at(-1).type, 'terminate');
  const before = sb.frames.length;
  a.pane.close();
  assert.equal(sb.frames.length, before);
  assert.equal(sb.readyState, 1);
  b.pane.close();
  assert.ok(!sb.frames.some(frame => frame.type === 'terminate'));
});

test('failed send preserves typed drafts, attachments and controls; snapshots contain metadata only', async () => {
  const h = harness(), { pane, root } = h.create('draft');
  const socket = await h.attach(pane, 'a');
  const input = ui(root, 'chat-input');
  assert.equal(input.rows, 2); assert.equal(input.style.height, '40px');
  assert.equal(input.style.minHeight, '40px'); assert.equal(input.style.maxHeight, '120px');
  const fileInput = ui(root, 'chat-file');
  fileInput.files = [{ name: 'secret.txt', size: 4, type: 'text/plain', text: 'DATA' }];
  fileInput.dispatchEvent({ type: 'change' }); await flush();
  assert.match(ui(root, 'chat-file-tray').textContent, /secret.txt/);
  input.value = 'SECRET DRAFT\nsecond line\nthird line';
  input.scrollHeight = 60; input.dispatchEvent({ type: 'input' });
  assert.equal(input.style.height, '60px');
  socket.fail = true; submit(root);
  assert.equal(input.value, 'SECRET DRAFT\nsecond line\nthird line');
  assert.equal(input.style.height, '60px', 'failed send does not collapse the draft');
  assert.match(ui(root, 'chat-file-tray').textContent, /secret.txt/);
  assert.match(ui(root, 'chat-composer-error').textContent, /draft has been kept/);
  assert.deepEqual(Object.keys(pane.snapshot()).sort(), ['agentId', 'kind', 'sessionId', 'surface', 'title']);
  assert.doesNotMatch(JSON.stringify(pane.snapshot()), /SECRET|DATA|secret|files|permission|role|forceNew|restore/);
  assert.doesNotMatch(JSON.stringify(pane.getState()), /SECRET|DATA|secret.txt/);
  socket.fail = false; submit(root);
  assert.equal(inputFrames(socket)[0].data, 'SECRET DRAFT\nsecond line\nthird line');
  assert.equal(inputFrames(socket)[0].options.files[0].data, 'REFUQQ==');
  assert.equal(ui(root, 'chat-input').value, '');
  assert.equal(input.style.height, '40px');
  assert.equal(ui(root, 'chat-file-tray').hidden, true);
  assert.equal(ui(root, 'chat-composer-error').textContent, '');
  pane.close();
});

test('attachment count/byte limits are enforced before reading, and close cancels an in-flight FileReader', async () => {
  const h = harness(), { pane, root } = h.create('files');
  await h.attach(pane, 'a');
  const input = ui(root, 'chat-file');
  input.files = [{ name: 'large', size: 33 }]; input.dispatchEvent({ type: 'change' }); await flush();
  assert.equal(h.fileReaders.length, 0);
  assert.match(ui(root, 'chat-composer-error').textContent, /32 B/);
  input.files = Array.from({ length: 3 }, () => ({ name: 'file', size: 1 })); input.dispatchEvent({ type: 'change' }); await flush();
  assert.equal(h.fileReaders.length, 0);
  input.files = [{ name: 'pending', size: 4, deferRead: true }]; input.dispatchEvent({ type: 'change' });
  assert.equal(ui(root, 'chat-send').disabled, true);
  pane.close(); await flush();
  assert.equal(h.fileReaders[0].aborted, true);
  h.fileReaders[0].complete(); await flush();
  assert.equal(root.childElementCount, 0);
});

test('canonical restore replaces provisional chat and settings without losing a draft, including batched configuration', async () => {
  const h = harness(), { pane, root } = h.create('canonical');
  const socket = await h.attach(pane, 'a');
  const model = root.querySelector('[data-chat-control="model"]');
  model.value = 'unconfirmed'; model.dispatchEvent({ type: 'input' });
  submit(root, 'provisional');
  ui(root, 'chat-input').value = 'next draft';
  socket.receive({ type: 'restore', kind: 'event', data: payload(
    { ev: 'session.config', options: { model: 'model-a', effort: 'high' } },
    { ev: 'user.echo', text: 'canonical user' }, { ev: 'message.delta', text: 'canonical answer' },
    { ev: 'permission.ask', request_id: 'request-1', tool: 'run' }) });
  assert.doesNotMatch(ui(root, 'chat-scroll').textContent, /provisional/);
  assert.match(ui(root, 'chat-scroll').textContent, /canonical user/);
  assert.equal(root.querySelector('.chat-user .chat-text').textContent, 'canonical user');
  assert.equal(root.querySelector('.chat-user .chat-role').textContent, 'You');
  assert.equal(root.querySelector('.chat-assistant .chat-role').textContent, 'Agent');
  assert.equal(model.value, 'model-a');
  assert.equal(model.disabled, true);
  assert.equal(ui(root, 'chat-input').value, 'next draft');
  const stalePermission = root.querySelector('.chat-perm-allow');
  socket.receive({ type: 'output', kind: 'event', data: payload({ ev: 'permission.ask', request_id: 'request-2', tool: 'run' }) });
  stalePermission.click();
  assert.ok(!socket.frames.some(frame => frame.type === 'permission'));
  pane.close();
});

test('saved Chat displays its full transcript immediately without playback or writable permissions', async () => {
  const h = harness({ terminal: false }), { pane, root } = h.create('chat-replay');
  h.recordings.set('rec', { surface: 'structured', events: [
    { time: 1, kind: 'event', data: payload({ ev: 'message.delta', text: 'recorded' }) },
    { time: 2, kind: 'event', data: payload({ ev: 'permission.ask', request_id: 'historical', tool: 'run' }) },
  ] });
  await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'rec' });
  assert.equal(h.terminals.length, 0);
  assert.equal(pane.getState().replay, true);
  assert.equal(pane.getState().readOnly, true);
  assert.equal(pane.getState().status, 'history');
  assert.equal(pane.getState().statusText, 'Session history · read-only');
  assertNoRecordingControls(root);
  assert.equal(ui(root, 'chat-composer').hidden, true);
  assert.equal(root.querySelector('.chat-perm-allow').disabled, true);
  assert.match(ui(root, 'chat-scroll').textContent, /recorded/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets.length, 0);
  assert.ok(h.requests.every(request => !request.method || request.method === 'GET'));
  pane.close();
  assert.equal(h.timers.size, 0);
});

test('saved Terminal immediately shows its final screen without duplicated equal-time output', async () => {
  const h = harness(), { pane, root } = h.create('terminal-replay');
  h.recordings.set('rec', { surface: 'terminal', checkpoints: [{ time: 1, cursor: 1, serialized_screen: 'A' }],
    events: [{ time: 1, cursor: 1, type: 'o', data: 'A' }, { time: 1, cursor: 2, type: 'o', data: 'B' }, { time: 2, cursor: 3, type: 'o', data: 'C' }] });
  await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'rec' });
  const terminal = h.terminals[0];
  assert.equal(terminal.output, 'ABC');
  assertNoRecordingControls(root);
  assert.equal(pane.getState().status, 'history');
  assert.equal(h.timers.size, 0);
  terminal.emit('not writable'); pane.resize();
  assert.equal(h.sockets.length, 0);
  pane.close();
  assert.ok(terminal.disposed);
});

test('saved Terminal supports output-only and checkpoint-only records without a player', async () => {
  for (const [recording, expected] of [
    [{ events: [{ time: 0, type: 'o', data: 'first' }, { time: 3, type: 'o', data: 'last' }] }, 'firstlast'],
    [{ checkpoints: [{ time: 7, serialized_screen: 'latest' }, { time: 1, serialized_screen: 'old' }] }, 'latest'],
  ]) {
    const h = harness(), { pane, root } = h.create('saved-terminal');
    h.recordings.set('saved', { surface: 'terminal', ...recording });
    await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'saved' });
    assert.equal(h.terminals[0].output, expected);
    assertNoRecordingControls(root);
    assert.equal(h.timers.size, 0);
    assert.equal(h.sockets.length, 0);
    pane.close();
  }
});

test('history attaches exact live surfaces and opens ended records read-only without spawning', async () => {
  const h = harness(), { pane, root } = h.create('history');
  h.sessions.set('a', [session('live'), session('ended', 'structured', 'ended'), { id: 'unknown', state: 'live' }]);
  await pane.open({ kind: 'history', agentId: 'a', surface: 'structured' });
  assert.equal(pane.getState().status, 'history');
  assert.equal(root.querySelectorAll('[data-ui="history-attach"]').length, 1);
  assert.equal(root.querySelectorAll('[data-ui="history-replay"]').length, 3);
  root.querySelectorAll('[data-ui="history-replay"]')[1].click(); await flush();
  assert.equal(pane.getState().kind, 'replay');
  assert.equal(pane.getState().sessionId, 'ended');
  await pane.showHistory();
  ui(root, 'history-attach').click(); await flush();
  assert.equal(pane.getState().sessionId, 'live');
  assert.equal(pane.getState().surface, 'structured');
  assert.ok(!h.requests.some(request => request.method === 'POST'));
  pane.close();
});

test('no role or surface exposes recording playback, download, retention or deletion', async () => {
  for (const role of ['viewer', 'operator', 'admin', 'owner']) for (const surface of ['structured', 'terminal']) {
    const h = harness({ role }), { pane, root } = h.create(role + '-' + surface);
    const saved = { surface, events: [], checkpoints: [], retention: '30d' };
    h.recordings.set('rec', saved);
    await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'rec', surface });
    assertNoRecordingControls(root);
    assert.equal(pane.getState().readOnly, true);
    assert.equal(pane.getState().status, 'history');
    assert.match(ui(root, 'recording-notice').textContent, /No recorded transcript/);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.requests.every(request => !request.method || request.method === 'GET'));
    assert.strictEqual(h.recordings.get('rec'), saved, 'existing data and retention are untouched');
    assert.equal(saved.retention, '30d');
    pane.close();
  }
});

test('stale saved-history responses and read failures cannot replace newer DOM', async () => {
  const h = harness({ role: 'admin' }), { pane, root } = h.create('rest');
  const replay = deferred();
  h.apiOverride = path => path.endsWith('/slow/replay') ? replay.promise : undefined;
  const pending = pane.open({ kind: 'replay', agentId: 'a', sessionId: 'slow' });
  await h.attach(pane, 'b');
  replay.resolve({ surface: 'terminal', events: [[1, 'o', 'stale']] }); await pending;
  assert.equal(h.terminals.length, 0);
  assert.equal(pane.getState().kind, 'live');
  const history = deferred();
  h.apiOverride = path => path.includes('/slow-history/') ? history.promise : undefined;
  const loading = pane.open({ kind: 'history', agentId: 'slow-history' });
  await h.attach(pane, 'b');
  history.resolve([session('stale')]); await loading;
  assert.equal(ui(root, 'history'), null);
  const failed = deferred();
  h.apiOverride = path => path.endsWith('/failed/replay') ? failed.promise : undefined;
  const failedRead = pane.open({ kind: 'replay', agentId: 'a', sessionId: 'failed' });
  await flush();
  await h.attach(pane, 'b');
  failed.reject(new Error('old history failure')); await failedRead;
  assert.doesNotMatch(root.textContent, /old history failure/);
  assert.ok(h.requests.every(request => !['PATCH', 'DELETE'].includes(request.method)));
  pane.close();
});

test('reconnect uses capped backoff and cannot create; closing one pane tears down only its timers/observer/listeners', async () => {
  const h = harness(), a = h.create('a'), b = h.create('b');
  let sa = await h.attach(a.pane, 'a', 'terminal', {}, 'operator', true);
  const sb = await h.attach(b.pane, 'b', 'terminal', {}, 'operator', true);
  const oldRenew = [...h.timers.values()][0].callback;
  sa.close();
  const delays = [];
  for (let i = 0; i < 6; ++i) {
    const [id, timer] = [...h.timers].find(([, timer]) => !timer.repeat);
    delays.push(timer.ms); h.runTimer(id);
    sa = h.sockets.at(-1); sa.open();
    if (i < 5) sa.close();
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000]);
  assert.equal(h.timers.size, 1, 'socket-open alone cannot renew a runtime lease before ready');
  sa.receive({ type: 'session.ready', surface: 'terminal' });
  sa.receive(collaboration('operator', true));
  assert.equal(h.timers.size, 2);
  oldRenew();
  assert.equal(h.timers.size, 2, 'already queued renew from an old socket cannot stop its replacement heartbeat');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 2);
  const oldObserver = h.observers[0];
  a.pane.close();
  assert.equal(h.timers.size, 1);
  assert.equal(oldObserver.disconnected, true);
  assert.equal(h.terminals[0].subscriptionDisposed, true);
  assert.equal(h.terminals[1].disposed, undefined);
  h.runTimer([...h.timers.keys()][0]);
  assert.equal(sb.frames.at(-1).type, 'keyboard_renew');
  b.pane.close();
  assert.equal(h.timers.size, 0);
  assert.ok([...h.windowListeners.values()].every(set => set.size === 0));
  assert.ok(h.sockets.every(socket => !socket.frames.some(frame => frame.type === 'terminate')));
});

test('resize fallback listener is per pane, removed on target switches and close', async () => {
  const h = harness({ observer: false }), a = h.create('a'), b = h.create('b');
  await h.attach(a.pane, 'a', 'terminal'); await h.attach(b.pane, 'b', 'terminal');
  assert.equal(h.windowListeners.get('resize').size, 2);
  await a.pane.showHistory();
  assert.equal(h.windowListeners.get('resize').size, 1);
  a.pane.close(); b.pane.close();
  assert.equal(h.windowListeners.get('resize').size, 0);
});

test('forceNew is explicit even with an old ID; restore takes precedence over a persisted forceNew flag', async () => {
  const h = harness(), { pane } = h.create('force');
  h.sessions.set('a', [session('old', 'terminal')]);
  await pane.open({ kind: 'live', agentId: 'a', surface: 'terminal', sessionId: 'old', forceNew: true });
  assert.notEqual(pane.getState().sessionId, 'old');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  await pane.open({ kind: 'live', agentId: 'a', surface: 'terminal', sessionId: 'old', forceNew: true, restore: true });
  assert.equal(pane.getState().sessionId, 'old');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  pane.close();
});

test('authoritative runtime controls stay pane-local; reconnect retains drafts and accepted attachments', async () => {
  const h = harness(), a = h.create('a'), b = h.create('b');
  const sa = await h.attach(a.pane, 'a'); await h.attach(b.pane, 'b');
  const input = ui(a.root, 'chat-file');
  input.files = [{ name: 'kept.txt', size: 4, text: 'DATA' }]; input.dispatchEvent({ type: 'change' }); await flush();
  ui(a.root, 'chat-input').value = 'unsent draft';
  const capabilities = plain(h.runtime);
  capabilities.surfaces[1].features.controls.push({ key: 'mode', kind: 'select', choices: ['review', 'write'] });
  sa.receive({ type: 'ready', capabilities });
  assert.ok(a.root.querySelector('[data-chat-control="mode"]'));
  assert.equal(b.root.querySelector('[data-chat-control="mode"]'), null);
  assert.equal(ui(a.root, 'chat-input').value, 'unsent draft');
  assert.match(ui(a.root, 'chat-file-tray').textContent, /kept.txt/);
  await a.pane.reconnect();
  const replacement = h.sockets.at(-1);
  replacement.open(); replacement.receive({ type: 'ready', capabilities }); replacement.receive(collaboration());
  assert.equal(ui(a.root, 'chat-input').value, 'unsent draft');
  assert.match(ui(a.root, 'chat-file-tray').textContent, /kept.txt/);
  submit(a.root);
  assert.equal(inputFrames(replacement)[0].options.files[0].name, 'kept.txt');
  a.pane.close(); b.pane.close();
});

test('multiple file controls share a hard memory-only attachment byte limit', async () => {
  const h = harness(), { pane, root } = h.create('limits');
  const controls = h.runtime.surfaces[1].features.controls;
  controls.find(control => control.key === 'files').max_total_bytes = 8 * 1024 * 1024;
  controls.push({ key: 'extra_files', kind: 'file', max_total_bytes: 8 * 1024 * 1024 });
  await h.attach(pane, 'a');
  const first = root.querySelector('[data-chat-file="files"]');
  first.files = [{ name: 'five-megabytes', size: 5 * 1024 * 1024 }]; first.dispatchEvent({ type: 'change' }); await flush();
  const second = root.querySelector('[data-chat-file="extra_files"]');
  second.files = [{ name: 'another-five-megabytes', size: 5 * 1024 * 1024 }]; second.dispatchEvent({ type: 'change' }); await flush();
  assert.equal(h.fileReaders.length, 1, 'aggregate limit is checked before reading the next file');
  assert.match(ui(root, 'chat-composer-error').textContent, /8.0 MB/);
  assert.doesNotMatch(JSON.stringify(pane.snapshot()), /five-megabytes|files/);
  pane.close();
});

test('End confirmation cannot affect replacement targets and historical views create no playback timers', async () => {
  const h = harness(), { pane, root } = h.create('queued');
  const sa = await h.attach(pane, 'a', 'terminal', {}, 'operator', true);
  const confirmation = deferred(); h.confirmOverride = () => confirmation.promise;
  const ending = pane.endSession();
  await h.attach(pane, 'b');
  confirmation.resolve(true); assert.equal(await ending, false);
  assert.ok(!sa.frames.some(frame => frame.type === 'terminate'));
  h.recordings.set('rec', { surface: 'structured', events: [
    { time: 1, kind: 'event', data: payload({ ev: 'message.delta', text: 'first' }) },
    { time: 5, kind: 'event', data: payload({ ev: 'message.delta', text: 'last' }) },
  ] });
  await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'rec' });
  assert.match(ui(root, 'chat-scroll').textContent, /firstlast/);
  assertNoRecordingControls(root);
  assert.equal(h.timers.size, 0);
  h.recordings.set('replacement', { surface: 'structured', events: [
    { time: 1, kind: 'event', data: payload({ ev: 'message.delta', text: 'new saved view' }) },
  ] });
  await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'replacement' });
  assert.match(ui(root, 'chat-scroll').textContent, /new saved view/);
  assert.doesNotMatch(ui(root, 'chat-scroll').textContent, /firstlast/);
  pane.close();
  assert.equal(h.timers.size, 0);
});

test('two panes may independently observe the same session, and closing one only detaches its socket', async () => {
  const h = harness(), a = h.create('left'), b = h.create('right');
  h.sessions.set('a', [session('shared')]);
  const sa = await h.attach(a.pane, 'a'), sb = await h.attach(b.pane, 'a');
  assert.equal(a.pane.getState().sessionId, b.pane.getState().sessionId);
  a.pane.focus(); h.type('left draft'); b.pane.focus(); h.type('right draft');
  sa.receive({ type: 'restore', kind: 'event', data: payload({ ev: 'message', text: 'left restore only' }) });
  assert.equal(ui(a.root, 'chat-input').value, 'left draft');
  assert.equal(ui(b.root, 'chat-input').value, 'right draft');
  assert.doesNotMatch(ui(b.root, 'chat-scroll').textContent, /left restore only/);
  a.pane.close(); submit(b.root);
  assert.equal(inputFrames(sb)[0].data, 'right draft');
  assert.equal(sa.readyState, 3);
  assert.equal(sb.readyState, 1);
  assert.ok(!sa.frames.some(frame => frame.type === 'terminate' || frame.type === 'keyboard_release'));
  b.pane.close();
});

test('viewer direct-open cannot start a model and composition/newline keys do not send Chat', async () => {
  const h = harness({ role: 'viewer' }), { pane, root } = h.create('viewer-open');
  await pane.open({ kind: 'live', agentId: 'a', surface: 'structured', forceNew: true });
  assert.equal(pane.getState().status, 'unavailable');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(h.sockets.length, 0);
  h.workspace.role = 'operator';
  const socket = await h.attach(pane, 'a');
  const input = ui(root, 'chat-input'); input.value = 'composing';
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }])
    input.dispatchEvent({ type: 'keydown', key: 'Enter', ...extra });
  assert.equal(inputFrames(socket).length, 0);
  assert.equal(input.value, 'composing');
  pane.close();
});

test('focusing a read-only Chat pane removes focus from another pane rather than targeting its disabled composer', async () => {
  const h = harness(), a = h.create('terminal'), b = h.create('read-only', { getWorkspace: () => ({ role: 'viewer' }) });
  const sa = await h.attach(a.pane, 'a', 'terminal', {}, 'operator', true);
  h.sessions.set('b', [session('viewable')]);
  await h.attach(b.pane, 'b', 'structured', {}, 'viewer');
  a.pane.focus(); h.type('terminal input');
  b.pane.focus(); h.type('must not reach terminal');
  assert.equal(h.document.activeElement, ui(b.root, 'chat-scroll'));
  assert.deepEqual(inputFrames(sa).map(frame => frame.data), ['terminal input']);
  a.pane.close(); b.pane.close();
});

test('composer starts at two lines, grows to six, preserves multiline/IME and shrinks after sending', async () => {
  const h = harness();
  h.window.getComputedStyle = () => ({ lineHeight: '18px', paddingTop: '2px', paddingBottom: '2px', borderTopWidth: '1px', borderBottomWidth: '1px' });
  const a = h.create('prompt-a'), b = h.create('prompt-b');
  const sa = await h.attach(a.pane, 'alpha'), sb = await h.attach(b.pane, 'beta');
  const input = ui(a.root, 'chat-input'), sibling = ui(b.root, 'chat-input');
  sibling.value = 'untouched sibling draft';
  assert.equal(input.rows, 2); assert.equal(input.style.height, '42px');
  assert.equal(input.style.minHeight, '42px'); assert.equal(input.style.boxSizing, 'border-box');
  assert.equal(ui(a.root, 'chat-prompt-marker'), null);
  assert.equal(a.root.querySelector('.chat-prompt-marker'), null);
  assert.equal(ui(a.root, 'chat-send').textContent, 'Send');
  assert.equal(ui(a.root, 'chat-send').getAttribute('aria-label'), 'Send message');
  assert.match(ui(a.root, 'chat-send').title, /Enter/);
  input.value = 'first'; input.scrollHeight = 22; input.dispatchEvent({ type: 'input' });
  assert.equal(input.style.height, '42px');
  const newline = { type: 'keydown', key: 'Enter', shiftKey: true };
  input.dispatchEvent(newline); assert.ok(!newline.defaultPrevented);
  input.value = 'first\nsecond'; input.scrollHeight = 40; input.dispatchEvent({ type: 'input' });
  assert.equal(input.style.height, '42px');
  input.value = 'first\nsecond\nthird'; input.scrollHeight = 58; input.dispatchEvent({ type: 'input' });
  assert.equal(input.style.height, '60px');
  input.scrollHeight = 400; a.pane.resize();
  assert.equal(input.style.height, '114px'); assert.equal(input.style.maxHeight, '114px');
  assert.equal(input.style.overflowY, 'auto');
  for (const event of [{ type: 'keydown', key: 'Enter', isComposing: true }, { type: 'keydown', key: 'Enter', keyCode: 229 }]) {
    input.dispatchEvent(event); assert.ok(!event.defaultPrevented);
  }
  input.dispatchEvent({ type: 'compositionstart' });
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  ui(a.root, 'chat-form').dispatchEvent({ type: 'submit' });
  assert.equal(inputFrames(sa).length, 0);
  input.dispatchEvent({ type: 'compositionend' });
  submit(a.root);
  assert.equal(inputFrames(sa).at(-1).data, 'first\nsecond\nthird');
  assert.equal(input.value, ''); assert.equal(input.style.height, '42px');
  assert.equal(input.style.overflowY, 'hidden');
  assert.equal(inputFrames(sb).length, 0); assert.equal(sibling.value, 'untouched sibling draft');
  a.pane.close(); b.pane.close();
});

test('clipboard shortcuts and pasted multiline drafts remain native, bounded and pane-local', async () => {
  const h = harness(), a = h.create('paste-a'), b = h.create('paste-b');
  const sa = await h.attach(a.pane, 'alpha'), sb = await h.attach(b.pane, 'beta');
  a.pane.focus();
  const input = ui(a.root, 'chat-input'), sibling = ui(b.root, 'chat-input');
  sibling.value = 'private sibling draft';
  for (const modifier of ['ctrlKey', 'metaKey']) for (const key of ['a', 'c', 'v', 'x']) {
    const event = { type: 'keydown', key, [modifier]: true, bubbles: true };
    input.dispatchEvent(event); assert.ok(!event.defaultPrevented, key + ' keeps native clipboard/selection behavior');
  }
  const paste = { type: 'paste', bubbles: true };
  input.dispatchEvent(paste); assert.ok(!paste.defaultPrevented);
  const text = '<img src=x onerror=alert(1)>\n> literal quote\n\tindented line';
  input.value = text; input.scrollHeight = 500;
  input.dispatchEvent({ type: 'input', inputType: 'insertFromPaste', bubbles: true });
  assert.equal(inputFrames(sa).length, 0, 'pasting a newline is not a submit');
  assert.equal(input.style.height, '120px'); assert.equal(input.style.overflowY, 'auto');
  assert.equal(h.document.activeElement, input);
  ui(a.root, 'chat-form').dispatchEvent({ type: 'submit' });
  assert.equal(inputFrames(sa)[0].data, text);
  sa.receive({ type: 'output', kind: 'event', data: payload({ ev: 'user.echo', text }) });
  assert.equal(a.root.querySelectorAll('.chat-user').length, 1);
  assert.equal(a.root.querySelector('.chat-user .chat-role').textContent, 'You');
  assert.equal(a.root.querySelector('.chat-user .chat-text').textContent, text);
  assert.equal(a.root.querySelector('img'), null);
  assert.equal(input.style.height, '40px'); assert.equal(input.style.overflowY, 'hidden');
  assert.equal(inputFrames(sb).length, 0); assert.equal(sibling.value, 'private sibling draft');
  a.pane.close(); b.pane.close();
});

test('interrupt is pending-only in the composer, while the public method retains checked structured access', async () => {
  const h = harness(), a = h.create('interrupt-a'), b = h.create('interrupt-b');
  const sa = await h.attach(a.pane, 'alpha'), sb = await h.attach(b.pane, 'beta');
  const stop = ui(a.root, 'chat-interrupt');
  assert.equal(stop.hidden, true); assert.equal(a.pane.getState().pending, false);
  assert.equal(a.pane.interrupt(), true, 'menu action remains available even without a known pending turn');
  submit(a.root, 'run');
  assert.equal(stop.hidden, false); assert.equal(stop.disabled, false);
  assert.equal(a.pane.getState().turnPending, true); assert.equal(b.pane.getState().pending, false);
  assert.equal(a.pane.interrupt(), true);
  assert.equal(sb.frames.some(frame => frame.type === 'interrupt'), false);
  sa.receive({ kind: 'event', type: 'output', data: payload({ ev: 'permission.ask', request_id: 'permit', tool: 'Read' }) });
  assert.equal(a.pane.getState().permissionPending, true);
  a.root.querySelector('.chat-perm-deny').click();
  assert.equal(a.pane.getState().permissionPending, false);
  sa.receive({ kind: 'event', type: 'output', data: payload({ ev: 'turn.end', result: 'ok' }) });
  assert.equal(stop.hidden, true); assert.equal(a.pane.getState().pending, false);
  assert.equal(a.root.querySelector('.chat-turn'), null);
  sa.receive({ kind: 'event', type: 'output', data: payload({ ev: 'message.delta', text: 'working' }) });
  const changeCount = h.changes.length;
  sa.receive({ kind: 'event', type: 'output', data: payload({ ev: 'message.delta', text: ' more' }) });
  assert.equal(h.changes.length, changeCount, 'tokens do not repeatedly announce pending state');
  sa.receive(collaboration('viewer'));
  assert.equal(stop.hidden, false); assert.equal(stop.disabled, true);
  const before = sa.frames.length;
  stop.dispatchEvent({ type: 'click' }); assert.equal(a.pane.interrupt(), false);
  assert.equal(sa.frames.length, before);
  sa.receive(collaboration('operator'));
  sa.close(); assert.equal(a.pane.interrupt(), false);
  assert.equal(stop.disabled, true);
  a.pane.close(); assert.equal(a.pane.interrupt(), false);
  b.pane.close();
});

test('restore derives pending presentation without touching drafts and failed/unavailable turns stay visible', async () => {
  const h = harness(), { pane, root } = h.create('pending-restore');
  const socket = await h.attach(pane, 'alpha');
  ui(root, 'chat-input').value = 'private draft';
  socket.receive({ kind: 'event', type: 'restore', data: payload({ ev: 'user.echo', text: 'old' }, { ev: 'turn.end', result: 'done' }) });
  assert.equal(pane.getState().pending, false); assert.equal(ui(root, 'chat-interrupt').hidden, true);
  socket.receive({ kind: 'event', type: 'restore', data: payload({ ev: 'user.echo', text: 'active' }, { ev: 'message.delta', text: 'partial' }) });
  assert.equal(pane.getState().pending, true); assert.equal(ui(root, 'chat-interrupt').hidden, false);
  socket.receive({ kind: 'event', type: 'output', data: payload({ ev: 'turn.end', is_error: true }) });
  assert.equal(pane.getState().pending, false); assert.equal(ui(root, 'chat-interrupt').hidden, true);
  assert.match(root.querySelector('.chat-error').textContent, /Turn failed/);
  socket.receive({ kind: 'event', type: 'output', data: payload({ ev: 'message.delta', text: 'retry' }) });
  socket.receive({ type: 'runtime.unavailable', data: 'Runtime unavailable' });
  assert.equal(pane.getState().pending, false); assert.equal(ui(root, 'chat-interrupt').hidden, true);
  assert.equal(ui(root, 'error').hidden, false); assert.match(ui(root, 'error').textContent, /unavailable/);
  assert.equal(ui(root, 'chat-input').value, 'private draft');
  assert.equal(pane.interrupt(), false);
  pane.close();
});

test('getState exposes safe primitive status/lease fields, not a redundant keyboard toolbar', async () => {
  const h = harness(), { pane, root } = h.create('status');
  await pane.open({ kind: 'live', agentId: 'alpha', surface: 'terminal' });
  const socket = h.sockets.at(-1);
  socket.open(); socket.receive({ type: 'ready', surface: 'terminal' });
  assert.equal(pane.getState().keyboardPending, true);
  assert.equal(root.querySelector('[data-ui="connection"], [data-ui="keyboard"], [data-ui="keyboard-request"]'), null);
  const live = ui(root, 'status');
  assert.equal(live.getAttribute('role'), 'status'); assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.classList.contains('visually-hidden'), true); assert.equal(live.hidden, false);
  assert.equal(pane.getState().statusText, 'Terminal ready');
  const other = collaboration('owner'); other.keyboard.holder_username = '  Ali\u0000ce\u202e  ';
  socket.receive(other);
  assert.equal(pane.getState().keyboardHolder, 'Alice'); assert.equal(pane.getState().keyboardBusy, true);
  assert.equal(pane.getState().keyboardOwned, false); assert.equal(pane.getState().keyboardPending, false);
  assert.equal(pane.getState().role, 'operator'); assert.equal(pane.getState().readOnly, true);
  other.keyboard.holder_username = { token: 'PRIVATE_KEY' }; socket.receive(other);
  assert.equal(pane.getState().keyboardHolder, 'someone');
  assert.doesNotMatch(JSON.stringify(pane.getState()), /PRIVATE_KEY|holder_user_id|requester_user_id/);
  socket.receive(collaboration('operator', true));
  assert.equal(pane.getState().keyboardOwned, true); assert.equal(pane.getState().readOnly, false);
  socket.receive({ type: 'keyboard_request', requester_user_id: 9, requester_username: 'next' });
  assert.equal(pane.getState().keyboardRequestPending, true);
  assert.match(live.textContent, /handoff requested/);
  assert.equal(pane.handoffKeyboard(), true); assert.equal(pane.getState().keyboardRequestPending, false);
  for (const value of Object.values(pane.getState())) assert.ok(value == null || ['boolean', 'string'].includes(typeof value));
  h.workspace.role = 'viewer'; pane.refreshAccess();
  assert.equal(pane.getState().role, 'viewer'); assert.equal(pane.getState().keyboardOwned, false);
  assert.equal(pane.getState().readOnly, true);
  assert.doesNotMatch(JSON.stringify(pane.snapshot()), /statusText|keyboardHolder|turnPending/);
  pane.close(); assert.equal(pane.getState().statusText, 'Closed');
});

test('sendPrefix transmits exactly one control-B only to the active holder terminal', async () => {
  const h = harness(); let active = 'a';
  const a = h.create('a', { isActive: () => active === 'a' });
  const b = h.create('b', { isActive: () => active === 'b' });
  const chat = h.create('chat', { isActive: () => active === 'chat' });
  const sa = await h.attach(a.pane, 'alpha', 'terminal', {}, 'operator', true);
  const sb = await h.attach(b.pane, 'beta', 'terminal', {}, 'operator', true);
  const sc = await h.attach(chat.pane, 'gamma');
  ui(chat.root, 'chat-input').value = 'never modify this draft';
  assert.equal(a.pane.sendPrefix(), true); assert.equal(b.pane.sendPrefix(), false);
  assert.deepEqual(inputFrames(sa), [{ type: 'input', session_id: a.pane.getState().sessionId, data: '\u0002' }]);
  assert.equal(inputFrames(sb).length, 0);
  active = 'b'; assert.equal(a.pane.sendPrefix(), false); assert.equal(b.pane.sendPrefix(), true);
  assert.deepEqual(inputFrames(sb), [{ type: 'input', session_id: b.pane.getState().sessionId, data: '\u0002' }]);
  sb.receive(collaboration('operator', false)); assert.equal(b.pane.sendPrefix(), false);
  sb.receive(collaboration('viewer', true)); assert.equal(b.pane.sendPrefix(), false);
  sb.receive(collaboration('operator', true));
  h.workspace.role = 'viewer'; assert.equal(b.pane.sendPrefix(), false); h.workspace.role = 'operator';
  sb.fail = true; assert.equal(b.pane.sendPrefix(), false); sb.fail = false;
  sb.close(); assert.equal(b.pane.sendPrefix(), false);
  active = 'chat'; assert.equal(chat.pane.sendPrefix(), false);
  assert.equal(ui(chat.root, 'chat-input').value, 'never modify this draft');
  assert.equal(inputFrames(sc).length, 0);
  active = 'a'; a.pane.close(); assert.equal(a.pane.sendPrefix(), false);
  assert.equal(inputFrames(sa).length, 1); assert.equal(inputFrames(sb).length, 1);
  b.pane.close(); chat.pane.close();
});

test('prefix focus fallback, replay and terminal interrupt cannot cross structured/lease boundaries', async () => {
  const h = harness(), a = h.create('focus-a'), b = h.create('focus-b');
  const sa = await h.attach(a.pane, 'alpha', 'terminal', {}, 'operator', true);
  await h.attach(b.pane, 'beta');
  b.pane.focus(); assert.equal(a.pane.sendPrefix(), false);
  a.pane.focus(); assert.equal(a.pane.sendPrefix(), true); assert.equal(a.pane.interrupt(), false);
  h.recordings.set('recorded-terminal', { surface: 'terminal', events: [] });
  await a.pane.open({ kind: 'replay', agentId: 'alpha', sessionId: 'recorded-terminal' });
  a.pane.focus(); assert.equal(a.pane.sendPrefix(), false); assert.equal(a.pane.interrupt(), false);
  h.recordings.set('recorded-chat', { surface: 'structured', events: [] });
  await a.pane.open({ kind: 'replay', agentId: 'alpha', sessionId: 'recorded-chat' });
  assert.equal(a.pane.sendPrefix(), false); assert.equal(a.pane.interrupt(), false);
  assert.equal(ui(a.root, 'chat-interrupt').hidden, true);
  assert.equal(inputFrames(sa).length, 1);
  a.pane.close(); b.pane.close();
});

function archived(extra = {}) {
  return session('archived', 'structured', 'inactive', { agent_id: 'a', title: 'Earlier work',
    launch_id: 'previous-launch', can_rename: true, resume_supported: true, can_resume: true, ...extra });
}

test('Rename uses an inline guarded PATCH, escapes titles and preserves live socket, transcript and draft', async () => {
  const h = harness(), { pane, root } = h.create('rename-live');
  const socket = await h.attach(pane, 'a');
  const sessionId = pane.getState().sessionId;
  socket.receive({ type: 'output', kind: 'event', data: payload({ ev: 'message.delta', text: 'keep transcript' }) });
  const compose = ui(root, 'chat-input'); compose.value = 'keep draft';
  ui(root, 'session-rename').click();
  const edit = ui(root, 'session-rename-input');
  edit.value = '  <img src=x onerror=alert(1)>  ';
  ui(root, 'session-rename-save').click(); await flush();
  const patch = h.requests.find(request => request.method === 'PATCH');
  assert.equal(patch.path, '/api/sessions/' + sessionId);
  assert.deepEqual(JSON.parse(patch.body), { title: '<img src=x onerror=alert(1)>', expected_title: 'New chat' });
  assert.equal(ui(root, 'session-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(ui(root, 'session-title').children.length, 0);
  assert.equal(pane.getState().title, '<img src=x onerror=alert(1)>');
  assert.equal(pane.getState().sessionId, sessionId);
  assert.equal(ui(root, 'chat-input'), compose); assert.equal(compose.value, 'keep draft');
  assert.match(ui(root, 'chat-scroll').textContent, /keep transcript/);
  assert.equal(h.sockets.length, 1); assert.equal(socket.readyState, 1);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  ui(root, 'session-rename').click(); ui(root, 'session-rename-save').click(); await flush();
  assert.equal(h.requests.filter(request => request.method === 'PATCH').length, 2, 'saving the existing title is allowed');
  pane.close();
});

test('Rename validation and 409 preserve the edit; pending duplicate saves issue one PATCH', async () => {
  const h = harness(), { pane, root } = h.create('rename-conflict');
  h.sessions.set('a', [archived()]);
  await pane.open({ kind: 'history', agentId: 'a' });
  ui(root, 'session-rename').click();
  const input = ui(root, 'session-rename-input');
  for (const value of ['', 'a\nb', 'x'.repeat(121)]) {
    input.value = value; ui(root, 'session-rename-save').click();
    assert.equal(ui(root, 'session-action-error').hidden, false);
  }
  assert.equal(h.requests.filter(request => request.method === 'PATCH').length, 0);
  const pending = deferred();
  h.apiOverride = (path, options) => options.method === 'PATCH' ? pending.promise : undefined;
  input.value = 'my draft';
  ui(root, 'session-rename-save').click(); ui(root, 'session-rename-save').click();
  assert.equal(h.requests.filter(request => request.method === 'PATCH').length, 1);
  pending.reject(Object.assign(new Error('Conflict'), { status: 409 })); await flush();
  assert.equal(input.value, 'my draft'); assert.equal(input.disabled, false);
  assert.match(ui(root, 'session-action-error').textContent, /Title changed elsewhere.*draft is kept/);
  assert.equal(ui(root, 'session-rename-form').hidden, false);
  assert.equal(ui(root, 'session-title').textContent, 'Earlier work');
  assert.equal(h.sockets.length, 0); assert.equal(h.requests.some(request => request.method === 'POST'), false);
  ui(root, 'session-rename-cancel').click(); assert.equal(ui(root, 'session-rename-form').hidden, true);
  pane.close();
});

test('History and replay are titled read-only views with no socket or POST, even when a recording was not retained', async () => {
  const h = harness(), { pane, root } = h.create('history-only');
  h.sessions.set('a', [archived({ title: '<script>unsafe()</script>' })]);
  h.apiOverride = path => path.endsWith('/replay') ? Promise.reject(new Error('Recording not retained')) : undefined;
  await pane.open({ kind: 'history', agentId: 'a', title: 'Agent label' });
  assert.equal(ui(root, 'session-title').textContent, '<script>unsafe()</script>');
  assert.equal(ui(root, 'history-replay').textContent, 'View history');
  assert.equal(ui(root, 'history-live'), null);
  ui(root, 'history-replay').click(); await flush();
  assert.equal(pane.getState().kind, 'replay'); assert.equal(pane.getState().title, '<script>unsafe()</script>');
  assert.equal(ui(root, 'session-title').children.length, 0);
  assert.equal(ui(root, 'chat-composer').hidden, true);
  assert.equal(ui(root, 'session-resume').disabled, false); assert.equal(ui(root, 'session-rename').disabled, false);
  assert.match(ui(root, 'recording-notice').textContent, /not retained.*separate from native CLI resume/);
  assert.equal(h.sockets.length, 0); assert.equal(h.requests.some(request => request.method === 'POST'), false);
  pane.close();
});

test('Viewer, unsupported, offline and Terminal rows expose blocked reasons and cannot Rename or Resume', async () => {
  for (const [role, extra, reason] of [
    ['viewer', {}, /Read-only.*Operator/],
    ['operator', { resume_supported: false, can_resume: false, resume_reason: 'Native context unsupported' }, /Native context unsupported/],
    ['operator', { can_resume: false, resume_reason: 'Connector offline' }, /Connector offline/],
    ['operator', { surface: 'terminal', resume_supported: false, can_resume: false }, /not Terminal/],
  ]) {
    const h = harness({ role }), { pane, root } = h.create('blocked');
    h.sessions.set('a', [archived(extra)]);
    await pane.open({ kind: 'history', agentId: 'a' });
    assert.equal(ui(root, 'session-resume').disabled, true);
    assert.match(ui(root, 'session-action-reason').textContent, reason);
    ui(root, 'session-resume').click();
    if (role === 'viewer') {
      assert.equal(ui(root, 'session-rename').disabled, true); ui(root, 'session-rename').click();
      assert.equal(ui(root, 'session-rename-form').hidden, true);
    }
    assert.equal(h.requests.some(request => request.path === '/api/sessions/archived'), false);
    assert.equal(h.requests.some(request => request.method === 'POST' || request.method === 'PATCH'), false);
    assert.equal(h.sockets.length, 0); pane.close();
  }
});

test('Resume fetches current metadata and sends one same-ID websocket resume; starting remains read-only until ready', async () => {
  const h = harness(), { pane, root } = h.create('resume');
  h.sessions.set('a', [archived()]);
  h.recordings.set('archived', { surface: 'structured', events: [
    { time: 0, kind: 'event', data: payload({ ev: 'message.delta', text: 'Earlier transcript' }) },
  ] });
  await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'archived' });
  const latest = deferred();
  h.apiOverride = path => path === '/api/sessions/archived' ? latest.promise : undefined;
  ui(root, 'session-resume').click(); ui(root, 'session-resume').click();
  assert.equal(h.requests.filter(request => request.path === '/api/sessions/archived').length, 2, 'initial replay GET and only one resume GET');
  latest.resolve(archived({ launch_id: 'fresh-launch', title: 'Fresh title' })); await flush();
  assert.equal(pane.getState().sessionId, 'archived'); assert.equal(pane.getState().title, 'Fresh title');
  assert.equal(pane.getState().kind, 'live');
  assert.match(ui(root, 'chat-scroll').textContent, /Earlier transcript/);
  assert.match(ui(root, 'status').textContent, /Preparing resume/);
  const socket = h.sockets[0]; socket.open(); socket.open();
  assert.deepEqual(socket.frames, [{ type: 'resume', session_id: 'archived', agent_id: 'a', surface: 'structured', launch_id: 'fresh-launch', cols: 120, rows: 30 }]);
  socket.receive(collaboration('operator', true));
  assert.equal(ui(root, 'chat-input').disabled, true);
  socket.receive({ type: 'status', state: 'starting', launch_id: 'new-launch' });
  assert.equal(ui(root, 'chat-send').disabled, true); assert.equal(pane.getState().readOnly, true);
  socket.receive({ type: 'session.ready', session_id: 'archived', surface: 'structured', launch_id: 'new-launch', context_resume: 'next_turn' });
  assert.equal(ui(root, 'chat-input').disabled, false);
  assert.match(ui(root, 'resume-notice').textContent, /Next message resumes the CLI conversation.*checked on that turn/);
  socket.receive({ type: 'restore', data: '' });
  assert.match(ui(root, 'chat-scroll').textContent, /Earlier transcript/);
  submit(root, 'Continue');
  assert.equal(inputFrames(socket)[0].launch_id, 'new-launch');
  assert.equal(pane.interrupt(), true); await pane.endSession();
  assert.ok(socket.frames.some(frame => frame.type === 'terminate'));
  assert.ok(socket.frames.filter(frame => ['input', 'interrupt', 'terminate'].includes(frame.type)).every(frame => frame.launch_id === 'new-launch'));
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  const snapshot = plain(pane.snapshot());
  assert.deepEqual(Object.keys(snapshot).sort(), ['agentId', 'kind', 'sessionId', 'surface', 'title']);
  assert.doesNotMatch(JSON.stringify(snapshot), /launch|resume|intent/);
  pane.close();
});

test('Resume is never replayed by disconnect, explicit reconnect or restored layout, including before the first socket opens', async () => {
  for (const opens of [true, false]) {
    const h = harness(), { pane, root } = h.create('one-shot');
    h.sessions.set('a', [archived()]);
    await pane.open({ kind: 'history', agentId: 'a' });
    ui(root, 'session-resume').click(); await flush();
    const original = h.sockets[0], oldOpen = original.onopen;
    if (opens) original.open();
    original.close();
    const [timer] = [...h.timers].find(([, entry]) => !entry.repeat); h.runTimer(timer);
    const reconnected = h.sockets.at(-1); reconnected.open(); oldOpen();
    assert.equal(reconnected.frames[0].type, 'attach'); assert.equal(reconnected.frames[0].session_id, 'archived');
    pane.reconnect(); const explicit = h.sockets.at(-1); explicit.open();
    assert.equal(explicit.frames[0].type, 'attach');
    assert.equal(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.type === 'resume').length, opens ? 1 : 0);
    const saved = plain(pane.snapshot()), socketCount = h.sockets.length;
    await pane.open({ ...saved, restore: true, resume: true, launch_id: 'ignored', forceNew: true });
    assert.equal(pane.getState().kind, 'replay'); assert.equal(h.sockets.length, socketCount);
    assert.equal(h.requests.some(request => request.method === 'POST'), false); pane.close();
  }
});

test('Fresh metadata blocks stale Resume eligibility or a changed agent and attaches rather than resumes if already live', async () => {
  for (const extra of [{ can_resume: false, resume_reason: 'Context is in use' }, { agent_id: 'different' }, { id: 'different' }, { state: 'live' }]) {
    const h = harness(), { pane, root } = h.create('fresh');
    h.sessions.set('a', [archived()]); await pane.open({ kind: 'history', agentId: 'a' });
    h.apiOverride = path => path === '/api/sessions/archived' ? archived(extra) : undefined;
    ui(root, 'session-resume').click(); await flush();
    if (extra.state === 'live') {
      assert.equal(h.sockets.length, 1); h.sockets[0].open();
      assert.equal(h.sockets[0].frames[0].type, 'attach');
      assert.equal(h.sockets[0].frames[0].session_id, 'archived');
    } else {
      assert.equal(h.sockets.length, 0);
      assert.match(ui(root, 'session-action-error').textContent, /Context is in use|metadata changed/);
    }
    assert.equal(h.requests.some(request => request.method === 'POST'), false); pane.close();
  }
});

test('Delayed Rename and Resume callbacks cannot affect another target, closed pane, workspace or revoked access', async () => {
  for (const operation of ['rename', 'resume']) for (const change of ['target', 'close', 'workspace', 'role']) {
    const h = harness(), { pane, root } = h.create(operation + change);
    h.sessions.set('a', [archived()]); await pane.open({ kind: 'history', agentId: 'a' });
    const pending = deferred();
    h.apiOverride = path => path === '/api/sessions/archived' ? pending.promise : undefined;
    if (operation === 'rename') {
      ui(root, 'session-rename').click(); ui(root, 'session-rename-input').value = 'Stale title'; ui(root, 'session-rename-save').click();
    } else ui(root, 'session-resume').click();
    if (change === 'target') await pane.open({ kind: 'history', agentId: 'b', title: 'Other pane target' });
    if (change === 'close') pane.close();
    if (change === 'workspace') h.workspace.id = 'another-workspace';
    if (change === 'role') { h.workspace.role = 'viewer'; pane.refreshAccess(); }
    pending.resolve(archived({ title: 'Stale title' })); await flush();
    assert.equal(h.sockets.length, 0);
    assert.notEqual(pane.getState().title, 'Stale title');
    assert.equal(h.requests.some(request => request.method === 'POST'), false);
    if (change === 'role') assert.equal(ui(root, 'session-resume').disabled, true);
    pane.close();
  }
});

test('Access revoked while loading history or before socket-open consumes Resume without sending it', async () => {
  for (const stage of ['recording', 'socket']) {
    const h = harness(), { pane, root } = h.create('revoke-' + stage);
    h.sessions.set('a', [archived()]); await pane.open({ kind: 'history', agentId: 'a' });
    const pending = deferred();
    if (stage === 'recording') h.apiOverride = path => path.endsWith('/replay') ? pending.promise : undefined;
    ui(root, 'session-resume').click(); await flush();
    h.workspace.role = 'viewer'; pane.refreshAccess();
    if (stage === 'recording') { pending.resolve({ surface: 'structured', events: [] }); await flush(); }
    else h.sockets[0].open();
    assert.equal(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.type === 'resume').length, 0);
    assert.match(ui(root, 'error').textContent, /permission to resume was revoked/);
    assert.equal(h.requests.some(request => request.method === 'POST'), false); pane.close();
  }
});

test('Native resume errors stay visible and never fall back to create or automatic resume', async () => {
  for (const type of ['error', 'runtime.unavailable']) for (const code of ['resume_required', 'session_changed', 'context.not_found', 'context.in_use', 'context.recovery_required', 'cli_failed', 'runtime_not_authenticated', 'runtime_auth_probe_failed']) {
    const h = harness(), { pane, root } = h.create('error-' + code);
    h.sessions.set('a', [archived()]); await pane.open({ kind: 'history', agentId: 'a' });
    ui(root, 'session-resume').click(); await flush();
    const socket = h.sockets[0]; socket.open();
    socket.receive({ type: 'status', state: 'starting', launch_id: 'failed-launch' });
    assert.match(ui(root, 'session-detail').textContent, /starting/);
    socket.receive({ type, code, launch_id: 'failed-launch', message: 'CLI reported ' + code });
    assert.match(ui(root, 'session-detail').textContent, /inactive/);
    assert.doesNotMatch(ui(root, 'session-detail').textContent, /starting/);
    assert.match(ui(root, 'error').textContent, new RegExp(code.replace('.', '\\.')));
    assert.equal(ui(root, 'chat-input').disabled, true);
    socket.close(); assert.equal(h.timers.size, 0);
    assert.equal(h.requests.some(request => request.method === 'POST'), false);
    assert.equal(socket.frames.filter(frame => frame.type === 'resume').length, 1); pane.close();
  }
});

test('Terminal authentication failures show actionable guidance without input or automatic retry', async () => {
  for (const [code, message] of [
    ['runtime_not_authenticated', "The connector's runtime authentication check reported not signed in. Check the selected provider's authentication on the connector machine, then retry explicitly; no replacement session was created."],
    ['runtime_auth_probe_failed', 'The connector could not check runtime authentication. Check the local runtime and provider configuration, then retry explicitly; no replacement session was created.'],
  ]) {
    const h = harness(), { pane, root } = h.create('terminal-' + code);
    h.sessions.set('a', [session('term', 'terminal', 'live', { launch_id: 'failed-launch', agent_id: 'a' })]);
    await pane.open({ kind: 'live', agentId: 'a', sessionId: 'term', surface: 'terminal' });
    const socket = h.sockets[0]; socket.open();
    socket.receive({ type: 'status', state: 'starting', launch_id: 'failed-launch' });
    const requestCount = h.requests.length;
    socket.receive({ type: 'runtime.unavailable', code, message, launch_id: 'failed-launch' });
    assert.equal(ui(root, 'error').textContent, message);
    assert.match(ui(root, 'session-detail').textContent, /inactive/);
    assert.equal(pane.getState().readOnly, true);
    h.terminals[0].emit('must not reach the CLI');
    assert.equal(socket.frames.some(frame => ['stdin', 'resume', 'create'].includes(frame.type)), false);
    assert.equal(h.requests.slice(requestCount).some(request => request.method !== 'GET'), false);
    socket.close(); assert.equal(h.timers.size, 0); pane.close();
  }
});

test('Title broadcasts update matching panes safely without resetting drafts or in-progress edits', async () => {
  const h = harness(), a = h.create('title-live'), b = h.create('title-history');
  const socket = await h.attach(a.pane, 'a');
  await b.pane.open({ kind: 'history', agentId: 'a' });
  ui(a.root, 'chat-input').value = 'unsent';
  ui(b.root, 'session-rename').click(); ui(b.root, 'session-rename-input').value = 'editing';
  socket.receive({ type: 'session.updated', session_id: a.pane.getState().sessionId, title: '<svg onload=bad()>' });
  assert.equal(a.pane.getState().title, '<svg onload=bad()>');
  assert.equal(ui(b.root, 'session-title').textContent, '<svg onload=bad()>');
  assert.equal(ui(b.root, 'session-title').children.length, 0);
  assert.equal(ui(b.root, 'session-rename-input').value, 'editing');
  assert.equal(ui(a.root, 'chat-input').value, 'unsent');
  const staleMessage = socket.onmessage;
  await a.pane.open({ kind: 'history', agentId: 'b', title: 'Other target' });
  staleMessage({ data: JSON.stringify({ type: 'session.updated', session_id: 'a-created-1', title: 'stale' }) });
  assert.equal(a.pane.getState().title, 'Other target');
  assert.notEqual(ui(b.root, 'session-title').textContent, 'stale');
  a.pane.close(); b.pane.close();
});

test('Current launch generation accompanies Terminal input, keyboard controls, resize and terminate', async () => {
  const h = harness(), { pane } = h.create('generation');
  h.sessions.set('a', [session('term', 'terminal', 'live', { launch_id: 'first', agent_id: 'a' })]);
  await pane.open({ kind: 'live', agentId: 'a', sessionId: 'term', surface: 'terminal' });
  const socket = h.sockets[0]; socket.open(); assert.equal(socket.frames[0].launch_id, 'first');
  socket.receive({ type: 'session.ready', surface: 'terminal', launch_id: 'first' });
  socket.receive(collaboration('operator', true));
  h.terminals[0].emit('x'); pane.releaseKeyboard();
  socket.receive({ type: 'keyboard_request', requester_user_id: 22, requester_username: 'other' }); pane.handoffKeyboard();
  pane.resize(); await pane.endSession();
  assert.ok(socket.frames.filter(frame => frame.type !== 'attach').every(frame => frame.launch_id === 'first'));
  assert.ok(socket.frames.some(frame => frame.type === 'input')); assert.ok(socket.frames.some(frame => frame.type === 'terminate'));
  pane.close();
});

test('Resume waits for the new starting token and matching ready; stale lifecycle frames cannot regress it', async () => {
  const h = harness(), { pane, root } = h.create('resume-generation');
  h.sessions.set('a', [archived()]);
  await pane.open({ kind: 'history', agentId: 'a' });
  ui(root, 'session-resume').click(); await flush();
  const socket = h.sockets[0]; socket.open(); socket.receive(collaboration('operator', true));
  assert.equal(ui(root, 'resume-notice').hidden, false);
  assert.match(ui(root, 'resume-notice').textContent, /Native history has not been verified/);
  for (const frame of [
    { type: 'ready', launch_id: 'previous-launch' },
    { type: 'ready', launch_id: 'new-launch' },
    { type: 'status', state: 'live', launch_id: 'previous-launch' },
    { type: 'status', state: 'starting', launch_id: 'previous-launch' },
  ]) socket.receive(frame);
  assert.equal(pane.getState().status, 'starting'); assert.equal(ui(root, 'chat-input').disabled, true);
  h.sessions.set('a', [archived({ state: 'starting', launch_id: 'new-launch' })]);
  socket.receive({ type: 'status', state: 'starting', launch_id: 'new-launch' });
  assert.equal(ui(root, 'resume-notice').hidden, false);
  assert.match(ui(root, 'resume-notice').textContent, /next message may perform/);
  socket.receive({ type: 'status', state: 'live', launch_id: 'new-launch' });
  socket.receive({ type: 'ready' });
  assert.equal(ui(root, 'chat-input').disabled, true, 'neither live status nor untagged ready finishes a resume');
  for (const frame of [
    { type: 'ready', surface: 'terminal' }, { type: 'session.ready' }, { type: 'exit' },
    { type: 'status', state: 'starting' }, { type: 'status', state: 'live' },
    { type: 'status', state: 'ended' }, { type: 'status', state: 'offline' },
    { type: 'error', code: 'start_failed', message: 'stale failure' },
    { type: 'runtime.unavailable', message: 'stale unavailable' },
  ]) socket.receive({ ...frame, launch_id: 'previous-launch' });
  await flush();
  assert.equal(pane.getState().status, 'starting'); assert.equal(ui(root, 'error').textContent, '');
  socket.receive({ type: 'ready', launch_id: 'new-launch', context_resume: 'next_turn' });
  assert.equal(ui(root, 'chat-input').disabled, false);
  assert.match(ui(root, 'status').textContent, /Next message resumes/);
  assert.equal(ui(root, 'resume-notice').hidden, false);
  socket.receive({ type: 'status', state: 'starting', launch_id: 'new-launch' });
  socket.receive({ type: 'status', state: 'starting', launch_id: 'unrelated-launch' });
  assert.equal(pane.getState().status, 'live', 'a late starting cannot regress readiness');
  submit(root, 'current turn'); assert.equal(inputFrames(socket)[0].launch_id, 'new-launch');
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  pane.close();
});

test('Resume may acknowledge an already-live same-generation process without a second launch', async () => {
  const h = harness(), { pane, root } = h.create('resume-reattach');
  h.sessions.set('a', [archived()]);
  await pane.open({ kind: 'history', agentId: 'a' });
  ui(root, 'session-resume').click(); await flush();
  const socket = h.sockets[0]; socket.open(); socket.receive(collaboration('operator', true));
  socket.receive({ type: 'status', state: 'live', launch_id: 'previous-launch' });
  assert.equal(ui(root, 'chat-input').disabled, true, 'an ordinary live status is not a resume acknowledgement');
  socket.receive({ type: 'status', state: 'live', launch_id: 'unrelated-launch', reattached: true });
  assert.equal(ui(root, 'chat-input').disabled, true);
  socket.receive({ type: 'status', state: 'live', launch_id: 'previous-launch', reattached: true });
  assert.equal(ui(root, 'chat-input').disabled, false);
  assert.equal(pane.getState().status, 'live');
  assert.equal(ui(root, 'resume-notice').hidden, true, 'reattachment makes no new context-restoration claim');
  assert.equal(socket.frames.filter(frame => frame.type === 'resume').length, 1);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  pane.close();
});

test('Safe current-generation start failures retain the restored transcript and cannot be revived by late ready', async () => {
  for (const failure of [
    { type: 'error', code: 'start_failed', message: 'The saved conversation could not be opened.' },
    { type: 'runtime.unavailable', code: 'runtime_unavailable', message: 'This runtime is not available.' },
  ]) {
    const h = harness(), { pane, root } = h.create(failure.type);
    h.sessions.set('a', [archived()]);
    h.recordings.set('archived', { surface: 'structured', events: [
      { time: 0, kind: 'event', data: payload({ ev: 'message.delta', text: 'Keep the readable transcript' }) },
    ] });
    await pane.open({ kind: 'replay', agentId: 'a', sessionId: 'archived' });
    ui(root, 'session-resume').click(); await flush();
    const transcript = ui(root, 'chat-scroll'), socket = h.sockets[0];
    socket.open(); socket.receive(collaboration('operator', true));
    socket.receive({ type: 'status', state: 'starting', launch_id: 'new-launch' });
    socket.receive({ ...failure, session_id: 'archived', launch_id: 'new-launch' });
    assert.equal(pane.getState().status, 'unavailable');
    assert.strictEqual(ui(root, 'chat-scroll'), transcript);
    assert.match(transcript.textContent, /Keep the readable transcript/);
    assert.equal(ui(root, 'error').textContent, failure.message);
    assert.equal(ui(root, 'chat-input').disabled, true); assert.equal(ui(root, 'resume-notice').hidden, true);
    socket.receive({ type: 'ready', launch_id: 'new-launch' }); socket.close(); assert.equal(h.timers.size, 0);
    assert.equal(pane.getState().status, 'unavailable'); assert.equal(h.sockets.length, 1);
    assert.equal(h.requests.some(request => request.method === 'POST'), false);
    pane.close();
  }
});

test('Renaming the current replay updates sibling watchers in place, including subsequent server title events', async () => {
  const h = harness(), replay = h.create('replay-title'), history = h.create('history-title'), live = h.create('watch-title');
  h.sessions.set('a', [session('shared', 'structured', 'live', { title: 'Original', agent_id: 'a', can_rename: true })]);
  h.recordings.set('shared', { surface: 'structured', events: [
    { time: 0, kind: 'event', data: payload({ ev: 'message.delta', text: 'Recorded conversation' }) },
  ] });
  await replay.pane.open({ kind: 'replay', agentId: 'a', sessionId: 'shared' });
  await history.pane.open({ kind: 'history', agentId: 'a' });
  const socket = await h.attach(live.pane, 'a', 'structured', { sessionId: 'shared' });
  const transcript = ui(replay.root, 'chat-scroll'), row = ui(history.root, 'session-card'), composer = ui(live.root, 'chat-input');
  composer.value = 'Unsent draft';
  ui(replay.root, 'session-rename').click(); ui(replay.root, 'session-rename-input').value = 'Renamed replay';
  ui(replay.root, 'session-rename-save').click(); await flush();
  for (const item of [replay, live]) assert.equal(item.pane.getState().title, 'Renamed replay');
  assert.equal(ui(history.root, 'session-title').textContent, 'Renamed replay');
  socket.receive({ type: 'session.updated', session_id: 'shared', title: 'From another watcher' });
  assert.equal(replay.pane.getState().title, 'From another watcher');
  assert.equal(ui(history.root, 'session-title').textContent, 'From another watcher');
  assert.strictEqual(ui(replay.root, 'chat-scroll'), transcript); assert.match(transcript.textContent, /Recorded conversation/);
  assert.strictEqual(ui(history.root, 'session-card'), row);
  assert.strictEqual(ui(live.root, 'chat-input'), composer); assert.equal(composer.value, 'Unsent draft');
  replay.pane.close(); history.pane.close(); live.pane.close();
});

test('Old socket lifecycle callbacks cannot alter a new reattachment even with the same launch token', async () => {
  const h = harness(), { pane, root } = h.create('socket-generation');
  h.sessions.set('a', [session('shared', 'structured', 'live', { launch_id: 'current', agent_id: 'a' })]);
  await pane.open({ kind: 'live', agentId: 'a', sessionId: 'shared' });
  const old = h.sockets[0]; old.open(); old.receive({ type: 'ready', launch_id: 'current' }); old.receive(collaboration());
  const callbacks = { message: old.onmessage, error: old.onerror, close: old.onclose, open: old.onopen };
  await pane.reconnect();
  const socket = h.sockets[1]; socket.open(); socket.receive({ type: 'status', state: 'live', launch_id: 'current' });
  socket.receive(collaboration());
  const state = plain(pane.getState());
  for (const frame of [
    { type: 'ready', surface: 'terminal' }, { type: 'status', state: 'ended' }, { type: 'exit' },
    { type: 'error', code: 'start_failed', message: 'Old failure' }, { type: 'runtime.unavailable' },
  ]) callbacks.message({ data: JSON.stringify({ ...frame, session_id: 'shared', launch_id: 'current' }) });
  callbacks.error({}); callbacks.close({}); callbacks.open({});
  for (const timer of [...h.timers.keys()]) h.runTimer(timer);
  assert.deepEqual(plain(pane.getState()), state); assert.equal(ui(root, 'error').textContent, '');
  assert.equal(h.sockets.length, 2); assert.equal(socket.frames[0].type, 'attach');
  assert.equal(socket.frames.some(frame => frame.type === 'resume'), false);
  pane.close();
});

test('Rotated End status is verified against metadata; stale generations cannot end the current pane', async () => {
  const h = harness(), { pane, root } = h.create('end-generation');
  const metadata = extra => session('shared', 'structured', 'live', { launch_id: 'current', agent_id: 'a', ...extra });
  h.sessions.set('a', [metadata()]);
  await pane.open({ kind: 'live', agentId: 'a', sessionId: 'shared' });
  const socket = h.sockets[0]; socket.open(); socket.receive({ type: 'ready', launch_id: 'current' }); socket.receive(collaboration());
  socket.receive({ type: 'status', state: 'ended', launch_id: 'old-end' }); await flush();
  assert.equal(pane.getState().status, 'live'); assert.equal(ui(root, 'chat-input').disabled, false);
  h.sessions.set('a', [metadata({ state: 'ended', launch_id: 'ended-generation' })]);
  socket.receive({ type: 'status', state: 'ended', launch_id: 'ended-generation' }); await flush();
  assert.equal(pane.getState().status, 'ended'); assert.equal(ui(root, 'chat-input').disabled, true);
  pane.close();
});

test('Status generation verification is socket and workspace guarded, and supports authoritative live reattach', async () => {
  const h = harness(), { pane } = h.create('status-metadata');
  const metadata = launch_id => session('shared', 'structured', 'live', { launch_id, agent_id: 'a' });
  h.sessions.set('a', [metadata('old')]);
  await pane.open({ kind: 'live', agentId: 'a', sessionId: 'shared' });
  const old = h.sockets[0]; old.open();
  const pending = deferred(); h.apiOverride = path => path === '/api/sessions/shared' ? pending.promise : undefined;
  old.receive({ type: 'status', state: 'live', launch_id: 'new' });
  await pane.reconnect();
  const socket = h.sockets[1]; socket.open();
  pending.resolve(metadata('new')); await flush();
  assert.equal(pane.getState().status, 'connected', 'old socket cannot finish its metadata check into the new socket');
  h.apiOverride = null; h.sessions.set('a', [metadata('new')]);
  socket.receive({ type: 'status', state: 'live', launch_id: 'new' }); await flush(); socket.receive(collaboration());
  assert.equal(pane.getState().status, 'live');
  assert.equal(pane.interrupt(), true); assert.equal(socket.frames.at(-1).launch_id, 'new');
  const ending = deferred(); h.apiOverride = path => path === '/api/sessions/shared' ? ending.promise : undefined;
  socket.receive({ type: 'status', state: 'ended', launch_id: 'ended' });
  h.workspace.id = 8;
  ending.resolve({ ...metadata('ended'), state: 'ended' }); await flush();
  assert.equal(pane.getState().status, 'live', 'another workspace ignores the delayed response');
  assert.equal(socket.frames.some(frame => frame.type === 'resume'), false);
  pane.close();
});
