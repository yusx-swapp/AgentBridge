const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const ui = require('./ui.js');

const INSTALL_PS1_URL = 'https://raw.githubusercontent.com/yusx-swapp/AgentBridge/main/scripts/install.ps1';
const INSTALL_SH_URL = 'https://raw.githubusercontent.com/yusx-swapp/AgentBridge/main/scripts/install.sh';

const fleet = [
  {id: 'b1', name: 'workstation', online: true, agents: [
    {id: 'a1', handle: 'claude', display_name: 'Claude', runtime: 'claude-code', presence: 'online'},
    {id: 'a2', handle: 'codex', display_name: 'Codex', runtime: 'codex-cli', presence: 'offline'},
  ]},
  {id: 'b2', name: 'laptop', online: false, agents: [
    {id: 'a3', handle: 'copilot', display_name: 'Copilot', runtime: 'copilot-cli', presence: 'busy'},
  ]},
];

test('escapeHtml neutralizes markup and quotes', () => {
  assert.equal(ui.escapeHtml('<b>"x"&\'</b>'),
    '&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;');
  assert.equal(ui.escapeHtml(null), '');
});

test('apiErrorMessage keeps API failures actionable when a proxy returns no body', () => {
  assert.equal(ui.apiErrorMessage(403, 'Forbidden', ''), 'Request failed (403 Forbidden)');
  assert.equal(ui.apiErrorMessage(403, '', null), 'Request failed (403)');
  assert.equal(ui.apiErrorMessage(400, 'Bad Request', '{"detail":"Name is required"}'),
    'Name is required');
  assert.equal(ui.apiErrorMessage(500, 'Server Error', 'upstream failed'), 'upstream failed');
});

test('initials builds a stable monogram', () => {
  assert.equal(ui.initials('Claude Code'), 'CC');
  assert.equal(ui.initials('@copilot'), 'CO');
  assert.equal(ui.initials(''), '?');
  assert.equal(ui.initials('  '), '?');
});

test('runtimeLabel keeps adapter-owned runtime IDs opaque', () => {
  assert.equal(ui.runtimeLabel('claude-code'), 'claude-code');
  assert.equal(ui.runtimeLabel('vendor/new-adapter'), 'vendor/new-adapter');
  assert.equal(ui.runtimeLabel(''), 'runtime');
});

test('runtimeOptions preserves reported adapter IDs and removes bad duplicates', () => {
  assert.deepEqual(ui.runtimeOptions([
    'claude-code', 'codex-cli', 'claude-code', '', '  ', null,
    ' vendor/new-adapter '
  ]), ['claude-code', 'codex-cli', 'vendor/new-adapter']);
  assert.deepEqual(ui.runtimeOptions(null), []);
});

test('localProjectOptions keeps path-free ids and names only', () => {
  assert.deepEqual(ui.localProjectOptions([
    {id:'p1', name:'Deepbox', path:'C:\\Code\\deepbox'},
    {id:'p1', name:'duplicate'},
    {id:'p2', name:'  Research  '},
    {id:'', name:'bad'}, null,
  ]), [
    {id:'p1', name:'Deepbox'},
    {id:'p2', name:'Research'},
  ]);
  assert.deepEqual(ui.localProjectOptions(null), []);
});

test('capability report helpers preserve legacy arrays and sanitize skills', () => {
  const runtimes = [{runtime:'claude-code'}];
  assert.equal(ui.runtimeCapabilities(runtimes), runtimes);
  assert.deepEqual(ui.runtimeCapabilities({runtimes}), runtimes);
  assert.deepEqual(ui.runtimeCapabilities(null), []);
  assert.deepEqual(ui.skillInventory({skills:[{
    name:'review-code', description:'Review changes', digest:'abc', scope:'project',
    project_id:'p1', targets:['claude-code'], status:'drifted', contains_scripts:true,
    source_path:'C:\\secret', bindings:['C:\\secret'],
  }]}), [{
    name:'review-code', description:'Review changes', digest:'abc', scope:'project',
    project_id:'p1', targets:['claude-code'], status:'drifted', contains_scripts:true,
  }]);
});

test('local setup command helpers are copyable and keep paths browser-local', () => {
  assert.equal(
    ui.projectAddCommand('C:\\Code\\deepbox', 'Deepbox'),
    'agentbridge project add "C:\\Code\\deepbox" --name "Deepbox"'
  );
  assert.equal(
    ui.skillInstallCommand('C:\\skills\\review-code', 'Deepbox'),
    'agentbridge skill install "C:\\skills\\review-code" --project "Deepbox"'
  );
  assert.equal(
    ui.skillRemoveCommand('review-code'),
    'agentbridge skill remove "review-code"'
  );
});

test('agentApiPath safely addresses opaque agent IDs', () => {
  assert.equal(ui.agentApiPath('agent/with spaces'),
    '/api/agents/agent%2Fwith%20spaces');
});

test('install commands use the canonical AgentBridge repository and retain legacy home compatibility', () => {
  assert.equal(
    ui.windowsInstallCommand(),
    `irm ${INSTALL_PS1_URL} | iex`
  );
  assert.equal(
    ui.unixInstallCommand(),
    `curl -fsSL ${INSTALL_SH_URL} | bash && ` +
      'export PATH="${AGENTBRIDGE_HOME-${DEEPBOX_HOME-$HOME/.agentbridge}}/bin:$HOME/.deepbox/bin:$PATH"'
  );
});

test('all UI installer source URLs exclude forks and pre-rename repositories', () => {
  // Check the source too: an unused stale link must not hide behind a correct
  // command helper. This is local inspection only, never a network request.
  const source = readFileSync(require.resolve('./ui.js'), 'utf8');
  const urls = source.match(/https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/[^\s'"`<>]+/g) || [];
  assert.deepEqual([...new Set(urls)].sort(), [INSTALL_PS1_URL, INSTALL_SH_URL].sort());
});

test('windowsConnectorCommand reconnects without invoking the installer', () => {
  const command = ui.windowsConnectorCommand('https://deepbox.example', 'hpc_box_test');
  assert.equal(
    command,
    '$env:AGENTBRIDGE_SERVER_URL = "https://deepbox.example"\n' +
      '$env:AGENTBRIDGE_TOKEN = "hpc_box_test"\n' +
      'agentbridge connect'
  );
  assert.doesNotMatch(command, /install\.ps1|Invoke-WebRequest|\birm\b/);
});

test('unixConnectorCommand reconnects without invoking the installer', () => {
  const command = ui.unixConnectorCommand('https://deepbox.example', 'hpc_box_test');
  assert.equal(
    command,
    'export AGENTBRIDGE_SERVER_URL="https://deepbox.example"\n' +
      'export AGENTBRIDGE_TOKEN="hpc_box_test"\n' +
      'agentbridge connect'
  );
  assert.doesNotMatch(command, /install\.sh|curl|wget/);
});

test('status helpers always return a text label', () => {
  assert.deepEqual(ui.devboxStatus({online: true}), {state: 'online', label: 'Online'});
  assert.deepEqual(ui.devboxStatus({online: false}), {state: 'offline', label: 'Offline'});
  assert.equal(ui.agentStatus({presence: 'busy'}).label, 'Busy');
  assert.equal(ui.agentStatus({}).state, 'offline');
});

test('fleetSummary rolls up online/total counts', () => {
  assert.deepEqual(ui.fleetSummary(fleet), {
    devboxTotal: 2, devboxOnline: 1, agentTotal: 3, agentOnline: 1,
  });
  assert.deepEqual(ui.fleetSummary(null), {
    devboxTotal: 0, devboxOnline: 0, agentTotal: 0, agentOnline: 0,
  });
});

test('filterDevboxes keeps devbox and narrows agents on agent match', () => {
  const all = ui.filterDevboxes(fleet, '');
  assert.equal(all.length, 2);
  const byBox = ui.filterDevboxes(fleet, 'laptop');
  assert.equal(byBox.length, 1);
  assert.equal(byBox[0].id, 'b2');
  const byAgent = ui.filterDevboxes(fleet, 'codex');
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].agents.length, 1);
  assert.equal(byAgent[0].agents[0].id, 'a2');
  // Original fleet is not mutated.
  assert.equal(fleet[0].agents.length, 2);
});

test('flattenAgents annotates each agent with its devbox', () => {
  const flat = ui.flattenAgents(fleet);
  assert.equal(flat.length, 3);
  assert.equal(flat[0].devbox_name, 'workstation');
  assert.equal(flat[2].devbox_online, false);
});

test('filterAgents matches handle, runtime label and devbox', () => {
  const flat = ui.flattenAgents(fleet);
  assert.equal(ui.filterAgents(flat, 'copilot').length, 1);
  assert.equal(ui.filterAgents(flat, 'laptop').length, 1);
  assert.equal(ui.filterAgents(flat, '').length, 3);
});

test('commandItems includes actions, agents and owner console when allowed', () => {
  const ownerItems = ui.commandItems({devboxes: fleet, isOwner: true});
  assert.ok(ownerItems.some(i => i.id === 'owner.open'));
  assert.ok(ownerItems.some(i => i.id === 'devbox.create'));
  assert.ok(ownerItems.some(i => i.kind === 'agent' && i.agentId === 'a1'));
  assert.ok(ownerItems.some(i => i.kind === 'history' && i.agentId === 'a1'));
  const memberItems = ui.commandItems({devboxes: fleet, isOwner: false});
  assert.ok(!memberItems.some(i => i.id === 'owner.open'));
});

test('filterCommands ranks title-prefix matches first', () => {
  const items = ui.commandItems({devboxes: fleet, isOwner: true});
  const hits = ui.filterCommands(items, 'claude');
  assert.ok(hits.length >= 1);
  assert.ok(/claude/i.test(hits[0].title));
  assert.equal(ui.filterCommands(items, 'zzz-none').length, 0);
  assert.equal(ui.filterCommands(items, '').length, items.length);
});

test('moveSelection wraps in both directions', () => {
  assert.equal(ui.moveSelection(0, 1, 3), 1);
  assert.equal(ui.moveSelection(2, 1, 3), 0);
  assert.equal(ui.moveSelection(0, -1, 3), 2);
  assert.equal(ui.moveSelection(0, 1, 0), 0);
});


test('workspace selection keeps a valid preference and falls back to personal', () => {
  const shared = {id: 'shared', name: 'Team'};
  const personal = {id: 'personal', name: 'Mine', is_personal: true};
  assert.strictEqual(ui.selectWorkspace([shared, personal], 'shared'), shared);
  assert.strictEqual(ui.selectWorkspace([shared, personal], 'missing'), personal);
  assert.equal(ui.selectWorkspace([], 'missing'), null);
});

test('workspace devbox filtering never leaks boxes from another workspace', () => {
  const mine = {id: 'a', workspace_id: 'one'};
  const theirs = {id: 'b', workspace_id: 'two'};
  assert.deepEqual(ui.devboxesForWorkspace([mine, theirs, null], 'one'), [mine]);
  assert.deepEqual(ui.devboxesForWorkspace(null, 'one'), []);
});

test('only workspace owners and admins receive workspace admin controls', () => {
  assert.equal(ui.canAdminWorkspace('owner'), true);
  assert.equal(ui.canAdminWorkspace('admin'), true);
  assert.equal(ui.canAdminWorkspace('operator'), false);
  assert.equal(ui.canAdminWorkspace('viewer'), false);
});

test('workspace invitation copy follows the preview API flat response contract', () => {
  assert.deepEqual(ui.workspaceInvitationCopy({
    workspace_name: 'Model Lab', role: 'operator', email_hint: 'a***@example.com',
  }), {
    title: 'Join Model Lab',
    description: 'You were invited as operator. Every member can access all devboxes and agents in this workspace. Invitation: a***@example.com.',
  });
  assert.equal(ui.workspaceInvitationCopy(null).title, 'Join workspace');
});

test('workspace acceptance copy distinguishes new and existing memberships', () => {
  assert.deepEqual(ui.workspaceAcceptanceCopy({
    workspace: {name: 'Model Lab'}, role: 'operator', already_member: false,
  }), {
    title: 'Workspace joined',
    description: 'You now have operator access to Model Lab.',
  });
  assert.deepEqual(ui.workspaceAcceptanceCopy({
    workspace: {name: 'Model Lab'}, role: 'viewer', already_member: true,
  }), {
    title: 'Already a member',
    description: 'You already have viewer access to Model Lab.',
  });
});


test('terminal focus policy protects forms but restores xterm deliberately', () => {
  assert.equal(ui.shouldFocusTerminal(false, 'INPUT', false), false);
  assert.equal(ui.shouldFocusTerminal(false, 'BUTTON', false), false);
  assert.equal(ui.shouldFocusTerminal(false, 'BODY', false), true);
  assert.equal(ui.shouldFocusTerminal(false, 'TEXTAREA', true), true);
  assert.equal(ui.shouldFocusTerminal(true, 'INPUT', false), true);
});

test('terminal lets the browser paste Ctrl+V except on macOS', () => {
  const key = (extra) => ({type: 'keydown', key: 'v', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, ...extra});
  assert.equal(ui.isTerminalPasteKey(key(), 'Win32'), true);
  assert.equal(ui.isTerminalPasteKey(key({key: 'V'}), 'Linux x86_64'), true);
  assert.equal(ui.isTerminalPasteKey(key(), 'MacIntel'), false);
  assert.equal(ui.isTerminalPasteKey(key({type: 'keyup'}), 'Win32'), false);
  assert.equal(ui.isTerminalPasteKey(key({key: 'c'}), 'Win32'), false);
  assert.equal(ui.isTerminalPasteKey(key({ctrlKey: false}), 'Win32'), false);
  assert.equal(ui.isTerminalPasteKey(key({altKey: true}), 'Win32'), false);
});

test('terminal input sender forwards each xterm event synchronously', () => {
  const sent = [];
  const sender = ui.createTerminalInputSender(sent.push.bind(sent));
  sender.push('a');
  sender.push('b');
  assert.deepEqual(sent, ['a', 'b']);
});

test('terminal input sender survives lease transitions but closes with its socket', () => {
  const sent = [];
  let allowed = true;
  const sender = ui.createTerminalInputSender(data=>allowed ? sent.push(data) : false);
  sender.push('before');
  allowed = false;
  assert.equal(sender.push('not the holder'), false);
  allowed = true;
  sender.push('after reacquire');
  sender.close();
  assert.equal(sender.push('stale socket'), false);
  assert.deepEqual(sent, ['before', 'after reacquire']);
});


test('runtimeOptions accepts detailed capability objects', () => {
  assert.deepEqual(ui.runtimeOptions([
    'claude-code',
    {runtime: 'copilot-cli-structured', installed: true, features: {}},
    {runtime: 'missing', installed: false},
    null,
  ]), ['claude-code', 'copilot-cli-structured']);
});


test('terminal input sender forwards optional structured turn options', () => {
  const sent = [];
  const sender = ui.createTerminalInputSender((data, options) => {
    sent.push({data, options});
    return true;
  });
  assert.equal(sender.push('hello', {model: 'sonnet'}), true);
  assert.deepEqual(sent, [{data: 'hello', options: {model: 'sonnet'}}]);
});


test('recognizes structured chat only from reported capability facts', () => {
  assert.equal(ui.supportsStructuredChat({features:{structured:true}}), true);
  assert.equal(ui.supportsStructuredChat({structured:true}), false);
  assert.equal(ui.supportsStructuredChat({features:{structured:false}}), false);
  assert.equal(ui.supportsStructuredChat(null), false);
});


test('capability v2 resolves legacy IDs and defaults to structured surface', () => {
  const capability = {
    schema_version: 2, runtime: 'claude-code', legacy_runtime_ids: ['claude-code-structured'],
    installation: {status: 'installed'}, compatibility: {status: 'compatible'},
    authentication: {status: 'authenticated'},
    models: {items: [{id: 'sonnet'}], allow_custom: true},
    surfaces: [
      {id: 'terminal', available: true, default: false, features: {controls: []}},
      {id: 'structured', available: true, default: true, features: {controls: [
        {key: 'model', kind: 'select', scope: 'turn', choices: [], allow_custom: false},
      ]}},
    ],
  };
  assert.strictEqual(ui.findRuntimeCapability([capability], 'claude-code-structured'), capability);
  assert.equal(ui.preferredSurface(capability), 'structured');
  const surface = ui.capabilityForSurface(capability, 'structured');
  assert.equal(ui.supportsStructuredChat(surface), true);
  const terminalSurface = ui.capabilityForSurface(capability, 'terminal');
  assert.equal(ui.supportsStructuredChat(terminalSurface), false);
  assert.equal(surface.features.structured, true);
  assert.deepEqual(surface.features.controls[0].choices, ['sonnet']);
  assert.equal(surface.features.controls[0].scope, 'turn');
  assert.equal(surface.features.controls[0].allow_custom, false);
  assert.deepEqual(ui.runtimeOptions([capability]), ['claude-code']);
});

test('model choices prefer control, then surface facts, then family discovery', () => {
  const capability = {
    schema_version: 2,
    models: {items: [{id: 'family-model'}], allow_custom: true},
    surfaces: [{id: 'structured', available: true, default: true, features: {
      models: [{id: 'sonnet'}, {id: 'opus'}, {id: 'haiku'}],
      controls: [{key: 'model', kind: 'select', scope: 'turn', choices: [],
        allow_custom: false}],
    }}],
  };
  const surface = ui.capabilityForSurface(capability, 'structured');
  assert.deepEqual(surface.features.controls[0].choices, ['sonnet', 'opus', 'haiku']);
  assert.equal(surface.features.controls[0].allow_custom, false);

  capability.surfaces[0].features.controls[0].choices = ['explicit-model'];
  assert.deepEqual(
    ui.capabilityForSurface(capability, 'structured').features.controls[0].choices,
    ['explicit-model'],
  );
  delete capability.surfaces[0].features.models;
  capability.surfaces[0].features.controls[0].choices = [];
  assert.deepEqual(
    ui.capabilityForSurface(capability, 'structured').features.controls[0].choices,
    ['family-model'],
  );
});


test('runtime inventory retains missing families for setup guidance', () => {
  assert.deepEqual(ui.runtimeInventory([{
    schema_version: 2, runtime: 'copilot-cli', label: 'Copilot CLI',
    installation: {status: 'missing', guidance: {command: 'install copilot'}},
    compatibility: {status: 'unknown'}, authentication: {status: 'unknown'}, surfaces: [],
  }]), [{
    id: 'copilot-cli', label: 'Copilot CLI', installation: 'missing',
    compatibility: 'unknown', authentication: 'unknown',
    guidance: {command: 'install copilot'},
  }]);
});

test('runtime helpers accept the capability report object sent by the server', () => {
  const capability = {runtime: 'claude-code', installed: true};
  const report = {runtimes: [capability], projects: [], skills: []};
  assert.deepEqual(ui.runtimeOptions(report), ['claude-code']);
  assert.equal(ui.findRuntimeCapability(report, 'claude-code'), capability);
  assert.equal(ui.runtimeInventory(report)[0].id, 'claude-code');
});

test('explicit Terminal never resumes a Chat session or an unknown legacy surface', () => {
  const chat = {id: 'chat', state: 'live', surface: 'structured'};
  const unknown = {id: 'legacy', state: 'live'};
  const terminal = {id: 'terminal', state: 'live', surface: 'terminal'};
  const sessions = [chat, unknown, terminal];
  assert.equal(ui.resumableSession(sessions, 'terminal'), terminal);
  assert.equal(ui.resumableSession(sessions, 'structured'), chat);
  assert.equal(ui.resumableSession(sessions), chat);
  assert.equal(ui.resumableSession([chat, unknown], 'terminal'), undefined);
  assert.equal(ui.resumableSession([{...terminal, state: 'inactive'}], 'terminal'), undefined);
  assert.equal(ui.resumableSession([{...terminal, state: 'ended'}], 'terminal'), undefined);
});

test('an explicit terminal capability never inherits structured controls', () => {
  const capability = {features: {structured: true, controls: [{key: 'model'}]}};
  assert.equal(ui.supportsStructuredChat(capability, 'terminal'), false);
  assert.equal(ui.supportsStructuredChat(capability, 'structured'), true);
});

test('account invitation links keep the secret in the fragment, never the query', () => {
  const url = new URL(ui.accountInvitationUrl('https://agentbridge.example/path?ignored=1', 'test&token'));
  assert.equal(url.origin, 'https://agentbridge.example');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('invite'), 'test&token');
  assert.throws(()=>ui.accountInvitationUrl('javascript:bad','test'), /HTTP origin/);
});

test('agentProjects groups sessions under machine projects', () => {
  const box = {projects: [{id: 'p1', name: 'One'}, {id: 'p2', name: 'Two'}]};
  const agent = {id: 'a', local_project_id: 'p1'};
  const groups = ui.agentProjects(box, agent, [{id: 's1', project_id: 'p2'}, {id: 's2'}, {id: 's3', project_id: 'gone'}]);
  assert.deepEqual(groups.map(g => [g.id, g.sessions.map(s => s.id)]),
    [['p1', ['s2']], ['p2', ['s1']], [null, ['s3']]]);
  assert.deepEqual(ui.agentProjects(box, {...agent, renderer: true}, []).map(g => g.id), ['p1']);
  assert.deepEqual(ui.agentProjects({}, {}, []).map(g => g.name), ['No project']);
});
