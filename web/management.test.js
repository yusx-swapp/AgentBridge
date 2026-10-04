const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowser, deferred} = require('./test-dom.js');

const clone = value=>JSON.parse(JSON.stringify(value));
async function flush(){ for(let index=0; index<24; index++) await Promise.resolve(); }
function change(element, value){ element.value = value; element.dispatchEvent({type:'change', bubbles:true}); }
function submit(root, selector='form'){ root.querySelector(selector).dispatchEvent({type:'submit', bubbles:true}); }
function action(root, label){
  const button = root.querySelectorAll('[data-action-index]').find(item=>item.textContent === label);
  assert.ok(button, `Missing dialog action ${label}`); button.click();
}

function harness({role='owner', localRole='owner', mockedDialogs}={}){
  const browser = createBrowser({terminal:false});
  browser.window.location.origin = 'https://agentbridge.invalid';
  const workspaces = [{id:'w1', name:'First workspace', role}, {id:'w2', name:'Second workspace', role:'owner'}];
  const h = {
    ...browser,
    ctx:{user:{id:'me', username:'owner', email:'owner@example.test', role:localRole}, workspace:workspaces[0], workspaces, epoch:1,
      devboxes:[
        {id:'m1', name:'First Machine', workspace_id:'w1', capabilities:{runtimes:[
          {runtime:'claude', label:'Claude', schema_version:2, surfaces:[], installation:{status:'installed'}, compatibility:{status:'compatible'}, authentication:{status:'ready'}},
          {runtime:'codex', installed:true}]},
          projects:[{id:'p1', name:'Project One'}], agents:[{id:'a1', handle:'one'}, {id:'a2', handle:'two'}], skills:[]},
        {id:'m2', name:'Other Machine', workspace_id:'w1', capabilities:{runtimes:['codex']}, agents:[{id:'a3', handle:'three'}]},
        {id:'m3', name:'Second workspace Machine', workspace_id:'w2', capabilities:{runtimes:['codex']}, agents:[{id:'a4'}]},
      ]},
    members:[
      {user_id:'me', username:'owner', display_name:'Me', role},
      {user_id:'viewer', username:'reader', display_name:'Read Only', role:'viewer'},
      {user_id:'admin', username:'administrator', display_name:'Workspace Admin', role:'admin'},
      {user_id:'workspace-owner', username:'founder', display_name:'Workspace Owner', role:'owner'},
    ],
    workspaceInvites:[{id:'wi1', email:'guest@example.test', role:'viewer', accepted_at:null, revoked_at:null}],
    localInvites:[{id:'li1', note:'Local invitation', status:'active', expires_at:'2030-01-01'}],
    users:[{id:'me', username:'owner', display_name:'Owner', role:'owner'},
      {id:'member', username:'member', display_name:'Member', role:'member', disabled:false},
      {id:'disabled', username:'disabled', display_name:'Disabled member', role:'member', disabled:true}],
    calls:[], copied:[], detached:[], selections:[], refreshes:0,
  };
  h.defaultApi = (path, options={})=>{
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    if(method === 'GET'){
      if(/^\/api\/workspaces\/[^/]+\/members$/.test(path)) return clone(h.members);
      if(/^\/api\/workspaces\/[^/]+\/invitations$/.test(path)) return clone(h.workspaceInvites);
      if(path === '/api/invitations') return clone(h.localInvites);
      if(path === '/api/users') return clone(h.users);
    }
    if(method === 'PATCH' && /\/members\//.test(path)) return {role:body.role};
    if(method === 'POST'){
      if(path === '/api/devboxes' || /\/tokens$/.test(path)) return {id:'new-machine', token:'test-machine-secret'};
      if(path === '/api/workspaces'){
        h.ctx.workspaces.push({id:'created-workspace', name:body.name, role:'owner'});
        return {id:'created-workspace', name:body.name};
      }
      if(/^\/api\/workspaces\/[^/]+\/invitations$/.test(path)){
        const invitation = {id:'wi-new', email:body.email, role:body.role};
        h.workspaceInvites.push(invitation);
        return {...invitation, join_url:'https://agentbridge.invalid/#workspace-invite=test-invitation'};
      }
      if(path === '/api/workspace-invitations/preview') return {workspace_name:'Second workspace', role:'operator', email_hint:'owner@…'};
      if(path === '/api/workspace-invitations/accept') return {workspace:{id:'w2', name:'Second workspace'}, role:'viewer', already_member:true};
      if(path === '/api/invitations') return {token:'test-local-invite-secret'};
      if(/\/agents$/.test(path) || /\/users\/[^/]+\/(enable|disable)$/.test(path)) return {};
    }
    if(method === 'DELETE') return {};
    throw new Error(`Unexpected API ${method} ${path}`);
  };
  h.dialogs = mockedDialogs || browser.loadModule('dialogs.js').createDialogs(browser.document);
  h.chat = browser.loadModule('chat.js');
  h.management = browser.loadModule('management.js').createManagement({
    api:async(path, options={})=>{
      h.calls.push({path, method:options.method || 'GET', body:options.body ? JSON.parse(options.body) : undefined});
      return h.apiHook ? h.apiHook(path, options) : h.defaultApi(path, options);
    },
    dialogs:h.dialogs, context:()=>h.ctx,
    refresh:async()=>{ h.refreshes++; if(h.refreshHook) return h.refreshHook(); },
    selectWorkspace:id=>{
      h.selections.push(id);
      h.ctx = {...h.ctx, workspace:h.ctx.workspaces.find(item=>item.id === id), epoch:h.ctx.epoch + 1};
      if(h.selectHook) return h.selectHook(id);
    },
    closeAgent:id=>h.detached.push(id), copyText:async text=>{
      if(h.copyHook) await h.copyHook(text);
      h.copied.push(text);
    },
    location:browser.window.location, document:browser.document, window:browser.window,
  });
  h.root = ()=>h.document.querySelector('.overlay');
  h.mutations = ()=>h.calls.filter(call=>call.method !== 'GET');
  h.switchWorkspace = id=>{ h.ctx = {...h.ctx, workspace:h.ctx.workspaces.find(item=>item.id === id), epoch:h.ctx.epoch + 1}; };
  h.close = async()=>{ h.dialogs.close(); await flush(); };
  return h;
}

test('UMD and CommonJS export only the public management factory and methods', ()=>{
  const browser = createBrowser({terminal:false});
  browser.loadScript('ui.js'); browser.loadScript('dialogs.js'); browser.loadScript('management.js');
  assert.deepEqual(Object.keys(browser.window.AgentBridgeManagement), ['createManagement']);
  assert.deepEqual(Object.keys(require('./management.js')), ['createManagement']);
  const h = harness();
  assert.deepEqual(Object.keys(h.management).sort(), ['createWorkspace','manageWorkspace','presentInvitation','admin',
    'createMachine','rotateMachineToken','deleteMachine','createAgent','agentSettings','hasAgentSettings',
    'deleteAgent','showRuntimes','showSkills'].sort());
});

test('real workspace dialog preserves Viewer until an explicit role Save; invitations default Operator', async()=>{
  const h = harness();
  h.management.manageWorkspace(); await flush();
  const root = h.root(), row = root.querySelector('[data-member="viewer"]');
  const role = row.querySelector('select'), save = row.querySelector('[data-save-member]');
  assert.equal(role.value, 'viewer'); assert.equal(save.disabled, true);
  assert.equal(root.querySelector('[data-invite-role]').value, 'operator');
  assert.equal(h.mutations().length, 0);
  change(role, 'operator');
  assert.equal(save.disabled, false); assert.equal(h.mutations().length, 0);
  save.click(); await flush();
  assert.deepEqual(h.mutations(), [{path:'/api/workspaces/w1/members/viewer', method:'PATCH', body:{role:'operator'}}]);
  assert.equal(role.dataset.memberRole, 'operator'); assert.equal(save.disabled, true);
  assert.equal(save.textContent, 'Saved'); assert.deepEqual(h.detached, []); assert.deepEqual(h.selections, []);
  await h.close();
});

test('failed role Save retains the draft role, saved role and an inline retryable error', async()=>{
  const h = harness();
  let failed = true;
  h.apiHook = (path, options)=>{
    if(options.method === 'PATCH' && failed) throw new Error('Role update denied');
    return h.defaultApi(path, options);
  };
  h.management.manageWorkspace(); await flush();
  const root = h.root(), row = root.querySelector('[data-member="viewer"]');
  const role = row.querySelector('select'), save = row.querySelector('button'), error = row.querySelector('[data-member-error]');
  change(role, 'operator'); save.click(); await flush();
  assert.equal(h.root(), root); assert.equal(role.value, 'operator'); assert.equal(role.dataset.memberRole, 'viewer');
  assert.equal(role.disabled, false); assert.equal(save.disabled, false); assert.match(error.textContent, /Role update denied/);
  failed = false; save.click(); await flush();
  assert.equal(error.textContent, ''); assert.equal(role.dataset.memberRole, 'operator');
  await h.close();
});

test('owner, self and admin role-editing rules match the existing permission contract', async t=>{
  for(const role of ['owner','admin','operator','viewer']) await t.test(role, async()=>{
    const h = harness({role});
    h.management.manageWorkspace(); await flush();
    const root = h.root();
    assert.equal(root.querySelector('[data-member="me"] select'), null);
    assert.equal(root.querySelector('[data-member="workspace-owner"] select'), null);
    assert.equal(!!root.querySelector('[data-member="admin"] select'), role === 'owner');
    assert.equal(!!root.querySelector('[data-member="viewer"] select'), role === 'owner' || role === 'admin');
    const invite = root.querySelector('[data-invite-role]');
    assert.equal(!!invite, role === 'owner' || role === 'admin');
    if(invite) assert.equal(!!invite.querySelector('option[value="admin"]'), role === 'owner');
    assert.equal(h.mutations().length, 0);
    await h.close();
  });
});

test('workspace role Save and invitation creation recheck current context and permissions before sending', async t=>{
  for(const changeContext of [h=>h.switchWorkspace('w2'), h=>{ h.ctx.epoch++; },
    h=>{ h.ctx = {...h.ctx, user:{...h.ctx.user, id:'another-user'}}; },
    h=>{ h.ctx = {...h.ctx, workspace:{...h.ctx.workspace, role:'viewer'}}; }]) await t.test('changed context', async()=>{
    const h = harness();
    h.management.manageWorkspace(); await flush();
    const root = h.root(), row = root.querySelector('[data-member="viewer"]');
    change(row.querySelector('select'), 'operator');
    root.querySelector('[data-invite-email]').value = 'guest@example.test';
    changeContext(h);
    row.querySelector('button').click(); submit(root, '[data-invite-form]'); await flush();
    assert.equal(h.mutations().length, 0);
    await h.close();
  });
});

test('failed invitations retain inputs; create, copy and revoke are explicit and stay scoped', async()=>{
  const h = harness(); let fail = true;
  h.apiHook = (path, options)=>{
    if(path === '/api/workspaces/w1/invitations' && options.method === 'POST' && fail) throw new Error('Email not allowed');
    return h.defaultApi(path, options);
  };
  h.management.manageWorkspace(); await flush();
  const root = h.root(), email = root.querySelector('[data-invite-email]');
  email.value = 'guest@example.test'; submit(root, '[data-invite-form]'); await flush();
  assert.equal(email.value, 'guest@example.test'); assert.equal(root.querySelector('[data-invite-role]').value, 'operator');
  assert.match(root.querySelector('[data-invite-error]').textContent, /Email not allowed/);
  assert.equal(root.querySelector('[data-invite-result]').hidden, true);
  fail = false; submit(root, '[data-invite-form]'); await flush();
  const link = root.querySelector('[data-invite-link]');
  assert.match(link.value, /#workspace-invite=/); assert.equal(h.copied.length, 0);
  const copy = root.querySelector('[data-invite-copy]'); copy.click(); await flush();
  assert.deepEqual(h.copied, [link.value]);
  root.querySelector('[data-revoke-invitation="0"]').click(); await flush();
  assert.ok(h.calls.some(call=>call.path === '/api/workspaces/w1/invitations/wi1' && call.method === 'DELETE'));
  assert.equal(root.querySelectorAll('[data-revoke-invitation]').length, 1);
  assert.equal(h.window.location.hash, '');
  await h.close(); assert.equal(link.value, '');
  copy.click(); await flush(); assert.equal(h.copied.length, 1);
});

test('workspace requests cannot replace another dialog or display private links after a switch', async()=>{
  const h = harness(), response = deferred();
  h.apiHook = (path, options)=>path.endsWith('/members') ? response.promise : h.defaultApi(path, options);
  h.management.manageWorkspace(); await flush();
  h.dialogs.modal({title:'Unrelated dialog', actions:[{label:'Close', value:true}]});
  const unrelated = h.root(); response.resolve(h.members); await flush();
  assert.equal(h.root(), unrelated); assert.doesNotMatch(unrelated.textContent, /Read Only/);
  h.apiHook = null; h.management.manageWorkspace(); await flush();
  const root = h.root(), invitation = deferred();
  h.apiHook = (path, options)=>options.method === 'POST' ? invitation.promise : h.defaultApi(path, options);
  root.querySelector('[data-invite-email]').value = 'guest@example.test';
  submit(root, '[data-invite-form]'); await flush();
  h.switchWorkspace('w2'); invitation.resolve({join_url:'https://agentbridge.invalid/#private-link'}); await flush();
  assert.equal(root.querySelector('[data-invite-link]').value, ''); assert.equal(h.root(), null);
});

test('workspace creation waits for explicit submit and selects the returned workspace', async()=>{
  const h = harness();
  h.management.createWorkspace(); await flush();
  assert.equal(h.mutations().length, 0);
  h.root().querySelector('[data-field="name"]').value = 'New workspace'; submit(h.root()); await flush();
  assert.deepEqual(h.mutations(), [{path:'/api/workspaces', method:'POST', body:{name:'New workspace'}}]);
  assert.deepEqual(h.selections, ['created-workspace']); assert.deepEqual(h.detached, []); assert.equal(h.refreshes, 1);
});

test('accepting an invitation preserves an existing Viewer role and never patches membership', async()=>{
  const h = harness();
  h.management.presentInvitation('test-workspace-invite'); await flush();
  assert.deepEqual(h.mutations().map(call=>call.path), ['/api/workspace-invitations/preview']);
  assert.match(h.root().textContent, /Machines/);
  action(h.root(), 'Join workspace'); await flush();
  assert.deepEqual(h.mutations().map(call=>call.path), ['/api/workspace-invitations/preview','/api/workspace-invitations/accept']);
  assert.deepEqual(h.selections, ['w2']); assert.deepEqual(h.detached, []);
  assert.match(h.root().textContent, /Already a member/); assert.match(h.root().textContent, /viewer access/);
  assert.equal(h.window.location.hash, ''); await h.close();
});

test('invitation preview, confirmation and acceptance all discard stale context', async t=>{
  await t.test('preview response', async()=>{
    const h = harness(), response = deferred(); h.apiHook = ()=>response.promise;
    h.management.presentInvitation('invitation'); h.switchWorkspace('w2');
    response.resolve({workspace_name:'Private workspace', role:'operator'}); await flush();
    assert.equal(h.root(), null); assert.equal(h.calls.length, 1);
  });
  await t.test('confirmation', async()=>{
    const h = harness(); h.management.presentInvitation('invitation'); await flush();
    h.ctx.epoch++; action(h.root(), 'Join workspace'); await flush();
    assert.equal(h.calls.length, 1); assert.deepEqual(h.selections, []);
  });
  await t.test('acceptance response', async()=>{
    const h = harness(), response = deferred();
    h.apiHook = (path, options)=>path.endsWith('/accept') ? response.promise : h.defaultApi(path, options);
    h.management.presentInvitation('invitation'); await flush(); action(h.root(), 'Join workspace'); await flush();
    h.switchWorkspace('w2'); response.resolve({workspace:{id:'w2', name:'Private workspace'}, role:'operator'}); await flush();
    assert.deepEqual(h.selections, []); assert.equal(h.root(), null);
  });
});

test('Machine creation uses the opening workspace and never mutates a newly selected workspace', async t=>{
  await t.test('successful explicit creation', async()=>{
    const h = harness(); h.management.createMachine(); await flush(); assert.equal(h.mutations().length, 0);
    h.root().querySelector('[data-field="name"]').value = 'Workstation'; submit(h.root()); await flush();
    assert.deepEqual(h.mutations(), [{path:'/api/devboxes', method:'POST', body:{name:'Workstation', workspace_id:'w1'}}]);
    assert.match(h.root().textContent, /Machine token/); assert.deepEqual(h.selections, []); await h.close();
  });
  for(const mutate of [h=>h.switchWorkspace('w2'), h=>{ h.ctx.epoch++; }, h=>{ h.ctx.user = {...h.ctx.user, id:'someone-else'}; }]){
    await t.test('stale form', async()=>{
      const h = harness(); h.management.createMachine(); await flush(); const root = h.root();
      mutate(h); submit(root); await flush(); assert.equal(h.mutations().length, 0); await h.close();
    });
  }
});

test('one-time Machine tokens are not displayed after stale responses, refreshes or replaced forms', async t=>{
  for(const stage of ['response','refresh','replacement','closed']) await t.test(stage, async()=>{
    const h = harness(), response = deferred(), refreshed = deferred();
    h.apiHook = (path, options)=>path === '/api/devboxes' ? response.promise : h.defaultApi(path, options);
    if(stage === 'refresh') h.refreshHook = ()=>refreshed.promise;
    h.management.createMachine(); await flush(); const original = h.root(); submit(original); await flush();
    assert.equal(h.mutations().length, 1);
    if(stage === 'refresh'){ response.resolve({token:'never-display-this-token'}); await flush(); }
    let replacement;
    if(stage === 'replacement'){
      h.dialogs.modal({title:'Different dialog', actions:[{label:'Close', value:true}]}); replacement = h.root();
    } else if(stage === 'closed') h.dialogs.close();
    else h.switchWorkspace('w2');
    response.resolve({token:'never-display-this-token'}); refreshed.resolve(); await flush();
    assert.doesNotMatch(h.document.body.textContent, /never-display-this-token/);
    assert.equal(h.root(), replacement || null); assert.deepEqual(h.copied, []);
    assert.doesNotMatch(original.textContent, /never-display-this-token/); await h.close();
  });
});

test('compact token dialog scopes OS and Copy, keeps installer collapsed and never persists secrets', async()=>{
  const h = harness(), storageTouches = [], logs = [];
  Object.defineProperty(h.window, 'localStorage', {get(){ storageTouches.push('read'); throw new Error('Forbidden persistence'); }});
  h.window.console = {log:(...args)=>logs.push(args), warn:(...args)=>logs.push(args), error:(...args)=>logs.push(args)};
  const before = clone(h.window.location);
  h.management.createMachine(); await flush(); submit(h.root()); await flush();
  const root = h.root(), code = root.querySelector('[data-connect-code]'), install = root.querySelector('[data-install-code]');
  const os = root.querySelector('[data-token-os]'), copy = root.querySelector('[data-token-copy]');
  assert.match(code.textContent, /\$env:AGENTBRIDGE_TOKEN = "test-machine-secret"/);
  assert.match(code.textContent, /agentbridge connect/); assert.doesNotMatch(code.textContent, /install|github/);
  assert.equal(root.querySelector('details').hasAttribute('open'), false);
  assert.match(install.textContent, /githubusercontent\.com\/yusx-swapp\/AgentBridge\/main\/scripts\/install\.ps1/);
  assert.equal(root.querySelectorAll('[data-connect-code]').length, 1); assert.equal(h.copied.length, 0);
  copy.click(); await flush(); assert.equal(h.copied[0], code.textContent);
  change(os, 'unix'); assert.match(code.textContent, /export AGENTBRIDGE_TOKEN=/); assert.match(install.textContent, /install\.sh/);
  assert.equal(copy.textContent, 'Copy'); assert.equal(h.copied.length, 1);
  root.querySelector('[data-install-copy]').click(); await flush(); assert.equal(h.copied[1], install.textContent);
  const retained = copy.onclick;
  h.dialogs.modal({title:'Unrelated dialog', bodyHtml:'<button data-token-copy>Other copy</button>', actions:[{label:'Close', value:true}]});
  const replacement = h.root(); await flush();
  assert.equal(code.textContent, ''); assert.equal(install.textContent, '');
  await retained(); assert.equal(h.copied.length, 2); assert.equal(h.root(), replacement);
  assert.equal(replacement.querySelector('[data-token-copy]').textContent, 'Other copy');
  assert.deepEqual(h.window.location, before); assert.deepEqual(storageTouches, []); assert.deepEqual(logs, []);
  assert.equal(h.window.document.body.querySelectorAll('a').length, 0); await h.close();
});

test('token copy completion cannot change another dialog and stale contexts cannot copy secrets', async()=>{
  const h = harness(), copied = deferred();
  h.copyHook = ()=>copied.promise;
  h.management.createMachine(); await flush(); submit(h.root()); await flush();
  const old = h.root(), button = old.querySelector('[data-token-copy]'); button.click();
  h.dialogs.modal({title:'Replacement', bodyHtml:'<button data-token-copy>Copy replacement</button>', actions:[]});
  const replacement = h.root(); copied.resolve(); await flush();
  assert.equal(replacement.querySelector('[data-token-copy]').textContent, 'Copy replacement');
  h.copyHook = null; h.management.createMachine(); await flush(); submit(h.root()); await flush();
  const token = h.root(), currentCopy = token.querySelector('[data-token-copy]');
  h.ctx.epoch++; currentCopy.click(); await flush();
  assert.equal(h.copied.length, 1); assert.equal(h.root(), null); assert.equal(token.querySelector('[data-connect-code]').textContent, '');
});

test('rotation requires explicit confirmation and checks context on both sides of HTTP', async t=>{
  await t.test('cancelled and stale confirmation', async()=>{
    const h = harness(); h.management.rotateMachineToken('m1'); await flush();
    assert.equal(h.mutations().length, 0); action(h.root(), 'Cancel'); await flush(); assert.equal(h.mutations().length, 0);
    h.management.rotateMachineToken('m1'); await flush(); h.switchWorkspace('w2'); action(h.root(), 'Rotate token'); await flush();
    assert.equal(h.mutations().length, 0);
  });
  await t.test('stale response', async()=>{
    const h = harness(), response = deferred(); h.apiHook = ()=>response.promise;
    h.management.rotateMachineToken('m1'); await flush(); action(h.root(), 'Rotate token'); await flush();
    assert.equal(h.calls[0].path, '/api/devboxes/m1/tokens'); h.switchWorkspace('w2');
    response.resolve({token:'discard-this-token'}); await flush(); assert.equal(h.root(), null); assert.deepEqual(h.copied, []);
  });
});

test('agent creation submits only project metadata and retains failed form inputs', async()=>{
  const h = harness(); let fail = true;
  h.apiHook = (path, options)=>{
    if(path === '/api/devboxes/m1/agents' && fail) throw new Error('Agent handle is already in use');
    return h.defaultApi(path, options);
  };
  h.management.createAgent('m1'); await flush(); const root = h.root();
  assert.equal(h.refreshes, 1); assert.equal(h.mutations().length, 0);
  root.querySelector('[data-field="handle"]').value = 'coder';
  change(root.querySelector('[data-field="runtime"]'), 'codex'); change(root.querySelector('[data-field="local_project_id"]'), 'p1');
  root.querySelector('[data-project-path]').value = 'C:\\private\\repo';
  root.querySelector('[data-project-name]').value = 'Private Repo';
  root.querySelector('[data-project-path]').dispatchEvent({type:'input'});
  assert.match(root.querySelector('[data-project-command]').textContent, /agentbridge project add/);
  assert.equal(h.copied.length, 0); root.querySelector('[data-project-copy]').click(); await flush(); assert.equal(h.copied.length, 1);
  submit(root); await flush();
  assert.equal(h.root(), root); assert.equal(root.querySelector('[data-field="handle"]').value, 'coder');
  assert.equal(root.querySelector('[data-field="runtime"]').value, 'codex'); assert.equal(root.querySelector('[data-field="local_project_id"]').value, 'p1');
  assert.match(root.querySelector('[data-error]').textContent, /already in use/);
  assert.deepEqual(h.mutations()[0], {path:'/api/devboxes/m1/agents', method:'POST', body:{
    handle:'coder', display_name:'coder', runtime:'codex', local_project_id:'p1', runtime_config:{}}});
  assert.doesNotMatch(JSON.stringify(h.calls), /private|Private Repo/);
  fail = false; submit(root); await flush(); assert.equal(h.root(), null); assert.equal(h.refreshes, 2);
  assert.deepEqual(h.detached, []); assert.deepEqual(h.selections, []);
});

test('project refresh preserves selection, adds reported projects and guards stale results', async()=>{
  const h = harness(); h.management.createAgent('m1'); await flush(); const root = h.root();
  const projects = root.querySelector('[data-field="local_project_id"]'); change(projects, 'p1');
  root.querySelector('[data-field="handle"]').value = 'preserved-handle';
  h.refreshHook = ()=>{ h.ctx.devboxes[0].projects.push({id:'p2', name:'Reported project'}); };
  root.querySelector('[data-refresh-projects]').click(); await flush();
  assert.equal(projects.value, 'p1'); assert.ok(projects.querySelector('option[value="p2"]'));
  assert.equal(root.querySelector('[data-field="handle"]').value, 'preserved-handle'); assert.equal(h.mutations().length, 0);
  const refreshed = deferred(); h.refreshHook = ()=>refreshed.promise;
  root.querySelector('[data-refresh-projects]').click(); await flush(); h.switchWorkspace('w2'); refreshed.resolve(); await flush();
  submit(root); await flush(); assert.equal(h.mutations().length, 0); assert.equal(h.root(), null);
});

test('agent creation drops stale initial refreshes and stale forms without mutating', async()=>{
  const h = harness(), refreshed = deferred(); h.refreshHook = ()=>refreshed.promise;
  h.management.createAgent('m1'); h.switchWorkspace('w2'); refreshed.resolve(); await flush();
  assert.equal(h.root(), null); assert.equal(h.mutations().length, 0);
  h.switchWorkspace('w1'); h.refreshHook = null;
  h.management.createAgent('m1'); await flush(); const root = h.root();
  root.querySelector('[data-field="handle"]').value = 'stale-agent'; h.switchWorkspace('w2'); submit(root); await flush();
  assert.equal(h.mutations().length, 0);
});

test('delete operations detach only affected agent panes, after successful server deletion', async t=>{
  for(const kind of ['agent','machine']) await t.test(kind, async()=>{
    const h = harness(), removed = deferred(); h.apiHook = ()=>removed.promise;
    if(kind === 'agent') h.management.deleteAgent('a1', 'one'); else h.management.deleteMachine('m1');
    await flush(); assert.equal(h.mutations().length, 0); assert.deepEqual(h.detached, []);
    action(h.root(), kind === 'agent' ? 'Delete agent' : 'Delete Machine'); await flush();
    assert.deepEqual(h.detached, []); assert.equal(h.mutations().length, 1);
    assert.equal(h.calls[0].path, kind === 'agent' ? '/api/agents/a1' : '/api/devboxes/m1');
    removed.resolve({}); await flush();
    assert.deepEqual(h.detached, kind === 'agent' ? ['a1'] : ['a1','a2']); assert.deepEqual(h.selections, []);
    assert.equal(h.refreshes, 1); assert.equal(h.root(), null);
  });
  await t.test('failed deletion retains every pane', async()=>{
    const h = harness(); h.apiHook = ()=>{ throw new Error('Deletion denied'); };
    h.management.deleteMachine('m1'); await flush(); action(h.root(), 'Delete Machine'); await flush();
    assert.deepEqual(h.detached, []); assert.match(h.root().textContent, /Deletion denied/); await h.close();
  });
  await t.test('completed deletion still detaches matching old panes after a switch', async()=>{
    const h = harness(), removed = deferred(); h.apiHook = ()=>removed.promise;
    h.management.deleteAgent('a1', 'one'); await flush(); action(h.root(), 'Delete agent'); await flush();
    h.switchWorkspace('w2'); removed.resolve({}); await flush();
    assert.deepEqual(h.detached, ['a1']); assert.equal(h.refreshes, 0); assert.equal(h.root(), null);
  });
});

test('mock confirmation cannot authorize a deletion after a workspace switch', async()=>{
  const confirmation = deferred();
  const h = harness({mockedDialogs:{confirm:()=>confirmation.promise}});
  const deleting = h.management.deleteAgent('a1', 'one'); h.switchWorkspace('w2'); confirmation.resolve(true); await deleting;
  assert.equal(h.mutations().length, 0); assert.deepEqual(h.detached, []);
});

test('owner administration remains available independently of workspace role and leaves all panes alone', async()=>{
  const h = harness({role:'viewer'}); h.ctx.workspace = null;
  h.management.admin(); await flush(); const root = h.root();
  assert.match(root.textContent, /agentbridge administration/); assert.equal(h.mutations().length, 0);
  assert.deepEqual(h.detached, []); assert.deepEqual(h.selections, []);
  assert.equal(root.querySelectorAll('[data-local-user]').length, 2);
  root.querySelector('[data-local-user="1"]').click(); await flush();
  assert.ok(h.calls.some(call=>call.path === '/api/users/member/disable' && call.method === 'POST'));
  root.querySelector('[data-local-user="2"]').click(); await flush();
  assert.ok(h.calls.some(call=>call.path === '/api/users/disabled/enable' && call.method === 'POST'));
  root.querySelector('[data-local-revoke]').click(); await flush();
  assert.ok(h.calls.some(call=>call.path === '/api/invitations/li1' && call.method === 'DELETE'));
  root.querySelector('[data-local-note]').value = 'Local account'; submit(root, '[data-local-invite-form]'); await flush();
  assert.deepEqual(h.calls.find(call=>call.path === '/api/invitations' && call.method === 'POST').body, {note:'Local account', ttl_hours:24});
  const code = root.querySelector('[data-local-code]'); assert.equal(code.textContent, 'test-local-invite-secret'); assert.equal(h.copied.length, 0);
  root.querySelector('[data-local-copy]').click(); await flush(); assert.deepEqual(h.copied, ['test-local-invite-secret']);
  assert.equal(h.window.location.hash, ''); assert.deepEqual(h.detached, []); assert.deepEqual(h.selections, []);
  await h.close(); assert.equal(code.textContent, '');
});

test('local owner mutations are guarded and private invitation codes never leak into stale dialogs', async t=>{
  await t.test('non-owner', async()=>{
    const h = harness({localRole:'member'}); await h.management.admin(); assert.equal(h.calls.length, 0); assert.equal(h.root(), null);
  });
  await t.test('owner role changed', async()=>{
    const h = harness(); h.management.admin(); await flush(); const root = h.root(); h.ctx.user.role = 'member';
    submit(root, '[data-local-invite-form]'); await flush(); assert.equal(h.mutations().length, 0);
    assert.match(root.querySelector('[data-admin-error]').textContent, /Only the local owner/); await h.close();
  });
  await t.test('stale mint response', async()=>{
    const h = harness(), minted = deferred();
    h.apiHook = (path, options)=>options.method === 'POST' ? minted.promise : h.defaultApi(path, options);
    h.management.admin(); await flush(); const root = h.root(); submit(root, '[data-local-invite-form]'); await flush();
    h.switchWorkspace('w2'); minted.resolve({token:'never-show-local-token'}); await flush();
    assert.equal(root.querySelector('[data-local-code]').textContent, ''); assert.equal(h.root(), null);
  });
});

test('runtime inventory has safe setup guidance and refresh-only reprobe help', async()=>{
  const h = harness({role:'viewer'});
  h.ctx.devboxes[0].capabilities.runtimes = [
    {runtime:'claude', label:'<script>bad</script>', schema_version:2, surfaces:[],
      installation:{status:'installed', guidance:{command:'claude auth login <manual>', url:'javascript:alert(1)'}},
      compatibility:{status:'compatible'}, authentication:{status:'needs_auth'}},
    {runtime:'codex', label:'Codex', schema_version:2, surfaces:[],
      installation:{status:'missing', guidance:{command:'npm install -g codex', url:'https://example.test/setup'}}},
    {runtime:'deeporca', label:'DeepOrca', schema_version:2, surfaces:[],
      installation:{status:'missing', guidance:{url:'https://aka.ms/deeporca'}}},
  ];
  h.management.showRuntimes('m1'); await flush(); const root = h.root();
  assert.match(root.textContent, /reprobe/); assert.match(root.textContent, /needs_auth/);
  assert.equal(root.querySelector('script'), null);
  assert.deepEqual(root.querySelectorAll('a').map(link=>link.getAttribute('href')), ['https://example.test/setup', 'https://aka.ms/deeporca']);
  const rows = root.querySelectorAll('[data-inventory] .runtime-setup-row');
  assert.equal(rows.length, 3); assert.match(rows[2].textContent, /DeepOrca.*missing.*Setup guide/);
  assert.equal(rows[2].querySelector('button'), null); assert.equal(rows[2].querySelector('pre'), null);
  assert.equal(h.mutations().length, 0); assert.equal(h.copied.length, 0);
  root.querySelector('[data-inventory-copy="0"]').click(); await flush(); assert.deepEqual(h.copied, ['claude auth login <manual>']);
  h.ctx.devboxes[0].capabilities.runtimes[2].installation.status = 'installed';
  root.querySelector('[data-refresh-inventory]').click(); await flush(); assert.equal(h.refreshes, 2); assert.equal(h.mutations().length, 0);
  assert.equal(root.querySelectorAll('[data-inventory] .runtime-setup-row').length, 3);
  assert.equal(root.querySelectorAll('a')[1].getAttribute('href'), 'https://aka.ms/deeporca');
  await h.close();
});

test('no available runtimes points to the shared Runtimes list without a creation form', async()=>{
  const h = harness(); h.ctx.devboxes[0].capabilities.runtimes = [];
  h.management.createAgent('m1'); await flush();
  assert.match(h.root().textContent, /Runtimes list/);
  assert.doesNotMatch(h.root().textContent, /adapter|DeepOrca/);
  assert.equal(h.root().querySelector('form'), null); assert.equal(h.mutations().length, 0);
  await h.close();
});

test('skill metadata and local help are escaped, project-aware and copy-only', async()=>{
  const h = harness({role:'viewer'});
  h.ctx.devboxes[0].skills = [{name:'review "code"', description:'<img src=x onerror=alert(1)>', scope:'project', project_id:'p1',
    status:'installed', targets:['claude','codex'], digest:'test-digest', contains_scripts:true}];
  h.management.showSkills('m1'); await flush(); const root = h.root();
  assert.equal(root.querySelector('img'), null); assert.match(root.textContent, /Project One/);
  assert.match(root.textContent, /not executed by agentbridge/); assert.match(root.textContent, /test-digest/);
  assert.equal(h.copied.length, 0); assert.equal(h.mutations().length, 0);
  root.querySelector('[data-inventory-copy="0"]').click(); await flush();
  assert.equal(h.copied[0], 'agentbridge skill inspect "review \\"code\\"" --project "Project One"');
  assert.equal(root.querySelector('details').hasAttribute('open'), false);
  assert.match(root.textContent, /agentbridge skill install/); assert.match(root.textContent, /agentbridge skill remove/);
  assert.equal(h.refreshes, 1); assert.deepEqual(h.detached, []); await h.close();
});

test('in-flight role Save cannot update a closed or replacement dialog', async()=>{
  const h = harness(), saved = deferred();
  h.apiHook = (path, options)=>options.method === 'PATCH' ? saved.promise : h.defaultApi(path, options);
  h.management.manageWorkspace(); await flush();
  const old = h.root(), row = old.querySelector('[data-member="viewer"]');
  change(row.querySelector('select'), 'operator'); row.querySelector('button').click(); await flush();
  h.dialogs.modal({title:'Replacement', bodyHtml:'<select data-member-role="viewer"><option value="viewer">Viewer</option></select><p data-member-error>Untouched</p>', actions:[]});
  const current = h.root(); saved.resolve({role:'operator'}); await flush();
  assert.equal(h.root(), current); assert.equal(current.querySelector('select').value, 'viewer');
  assert.equal(current.querySelector('[data-member-error]').textContent, 'Untouched');
  assert.equal(row.querySelector('select').dataset.memberRole, 'viewer'); await h.close();
});

test('managing another workspace uses its id and does not select it or close panes', async()=>{
  const h = harness(); h.management.manageWorkspace('w2'); await flush();
  const root = h.root();
  assert.match(root.textContent, /Second workspace/);
  assert.deepEqual(h.calls.map(call=>call.path), ['/api/workspaces/w2/members','/api/workspaces/w2/invitations']);
  const row = root.querySelector('[data-member="viewer"]');
  change(row.querySelector('select'), 'operator'); row.querySelector('button').click(); await flush();
  assert.equal(h.mutations()[0].path, '/api/workspaces/w2/members/viewer');
  assert.equal(h.ctx.workspace.id, 'w1'); assert.deepEqual(h.selections, []); assert.deepEqual(h.detached, []); await h.close();
});

test('a catalog refresh failure does not lose the newly created Machine token or repeat creation', async()=>{
  const h = harness(); h.refreshHook = ()=>{ throw new Error('Catalog unavailable'); };
  h.management.createMachine(); await flush(); submit(h.root()); await flush();
  assert.match(h.root().querySelector('[data-connect-code]').textContent, /test-machine-secret/);
  assert.equal(h.mutations().length, 1); assert.equal(h.refreshes, 1); assert.equal(h.copied.length, 0);
  await h.close(); assert.equal(h.mutations().length, 1);
});

test('workspace creation and owner metadata loads cannot cross an authentication change', async()=>{
  const h = harness(); h.management.createWorkspace(); await flush(); const root = h.root();
  root.querySelector('[data-field="name"]').value = 'Stale workspace'; h.ctx.epoch++; submit(root); await flush();
  assert.equal(h.mutations().length, 0);
  const loaded = deferred(); h.apiHook = ()=>loaded.promise; h.management.admin(); await flush();
  h.ctx.user = {...h.ctx.user, id:'different-owner'};
  loaded.resolve([{id:'private-user', role:'member', username:'private-username'}]); await flush();
  assert.equal(h.root(), null); assert.doesNotMatch(h.document.body.textContent, /private-username/);
});

function deeporcaHarness(options){
  const h=harness(options);
  h.agent={id:'native',handle:'native-helper',display_name:'Local helper',runtime:'deeporca',local_project_id:'p1',
    runtime_config:{integration_version:1,profile:{mode:'create',configuration_template_ref:'connector-default'}},
    runtime_status:{state:'needs_configuration',code:'configuration_required'}};
  h.box=h.ctx.devboxes[0];h.box.online=true;h.box.agents=[h.agent];
  h.box.capabilities.runtimes.push({runtime:'deeporca',installed:true,
    agent_config:{profile_modes:['create'],configuration_templates:[{id:'connector-default',label:'Connector default'}]}});
  h.field=()=>h.root().querySelector('[data-field="display_name"]');
  h.error=()=>h.root().querySelector('[data-error]').textContent;
  h.open=async()=>{h.management.agentSettings('native');await flush();};
  return h;
}

const modelValues={base_url:'http://localhost:11434/v1',model:'provider/test-model',context_window:'32768',reasoning_effort:'high'};
const modelConfig={provider:'openai',...modelValues,context_window:32768};
function fillModel(root){
  for(const [name,value] of Object.entries(modelValues)) change(root.querySelector(`[data-field="${name}"]`),value);
}

test('runtime UI creation owns configuration fields while management requires registered project metadata', async()=>{
  const h=deeporcaHarness(), loaded=[], load=h.chat.loadLocalModule;
  h.chat.loadLocalModule=id=>{loaded.push(id);return load(id);};
  h.management.createAgent('m1');await flush();
  const root=h.root(), runtime=root.querySelector('[data-field="runtime"]');
  const project=root.querySelector('[data-field="local_project_id"]');
  assert.equal(runtime.closest('.field').querySelector('label').textContent, 'Runtime');
  assert.doesNotMatch(root.textContent, /Runtime adapter/);
  assert.ok(runtime.querySelectorAll('option').some(option=>option.value === 'deeporca'));
  const endpoint=root.querySelector('[data-field="base_url"]'), auth=root.querySelector('[data-field="auth_mode"]');
  assert.deepEqual(loaded,['runtime-catalog']);
  assert.equal(root.querySelector('[data-field="template"]'),null);
  assert.equal(endpoint.closest('.field').hidden,true);assert.equal(endpoint.disabled,true);assert.equal(project.required,false);
  change(runtime,'deeporca');
  assert.equal(endpoint.closest('.field').hidden,false);assert.equal(endpoint.disabled,false);assert.equal(project.required,true);
  assert.equal(project.getAttribute('aria-required'),'true');
  assert.deepEqual(auth.querySelectorAll('option').map(option=>option.value),['api_key','none']);
  assert.equal(auth.value,'api_key');assert.equal(root.querySelector('[data-field="api_key"]').getAttribute('type'),'password');
  assert.match(root.textContent,/Model connection/);assert.match(root.textContent,/Model behavior/);
  assert.match(root.textContent,/Automatic managed profile, created on the Connector from its default template/);
  assert.doesNotMatch(root.textContent,/display name follows/);
  root.querySelector('[data-field="handle"]').value='new-helper';
  fillModel(root);change(auth,'none');
  assert.equal(root.querySelector('[data-field="api_key"]').disabled,true);
  submit(root);await flush();
  assert.equal(h.calls.length,0);assert.match(root.querySelector('[data-error]').textContent,/DeepOrca requires a registered local project/);
  change(project,'p1');
  h.apiHook=(path, options)=>{
    const body=JSON.parse(options.body);
    const created={id:'created-native',...body,runtime_status:{state:'pending'}};
    h.box.agents.push(created);return created;
  };
  submit(root);await flush();
  assert.deepEqual(h.calls,[{path:'/api/devboxes/m1/agents',method:'POST',body:{
    handle:'new-helper',display_name:'new-helper',runtime:'deeporca',local_project_id:'p1',
    runtime_config:{integration_version:1,profile:{mode:'create',configuration_template_ref:'connector-default'},
      llm:modelConfig,credential:{mode:'none'}}}}]);
  assert.doesNotMatch(JSON.stringify(h.calls),/api_key/);
  assert.notEqual(h.root(),root);assert.equal(h.field().value,'new-helper');
  assert.equal(h.root().querySelector('[data-runtime-status] .pill').textContent,'Pending');
  assert.deepEqual(loaded,['runtime-catalog','runtime-catalog']);
  await h.close();
});

test('switching from DeepOrca to a CLI runtime keeps its draft private and sends only CLI metadata', async()=>{
  const h=deeporcaHarness(), original=clone(h.agent);
  h.management.createAgent('m1');await flush();
  const root=h.root(), runtime=root.querySelector('[data-field="runtime"]');
  change(runtime,'deeporca');fillModel(root);
  root.querySelector('[data-field="api_key"]').value='private-unsent-draft-key';
  change(runtime,'codex');
  for(const name of ['base_url','model','auth_mode','api_key','context_window','reasoning_effort']){
    const field=root.querySelector(`[data-field="${name}"]`);
    assert.equal(field.disabled,true);assert.equal(field.closest('.field').hidden,true);
  }
  assert.equal(root.querySelector('[data-field="local_project_id"]').required,false);
  change(runtime,'deeporca');
  assert.equal(root.querySelector('[data-field="model"]').value,modelValues.model);
  assert.equal(root.querySelector('[data-field="api_key"]').value,'private-unsent-draft-key');
  change(runtime,'codex');root.querySelector('[data-field="handle"]').value='cli-helper';
  submit(root);await flush();
  assert.deepEqual(h.calls,[{path:'/api/devboxes/m1/agents',method:'POST',body:{
    handle:'cli-helper',display_name:'cli-helper',runtime:'codex',local_project_id:null,runtime_config:{}}}]);
  assert.doesNotMatch(JSON.stringify(h.calls),/private-unsent-draft-key|provider\/test-model|api_key/);
  assert.deepEqual(h.agent,original);assert.equal(h.root(),null);
  assert.deepEqual(h.detached,[]);assert.deepEqual(h.selections,[]);
});

test('CLI creation stays optional and does not load any runtime UI', async()=>{
  const h=harness();
  h.chat.loadLocalModule=()=>{throw new Error('CLI must not load runtime UI');};
  await h.management.agentSettings('a1');assert.equal(h.root(),null);
  h.management.createAgent('m1');await flush();
  const root=h.root();
  assert.equal(root.querySelector('[data-field="template"]'),null);
  assert.equal(root.querySelector('[data-field="local_project_id"]').required,false);
  root.querySelector('[data-field="handle"]').value='cli-helper';
  submit(root);await flush();
  assert.deepEqual(h.calls,[{path:'/api/devboxes/m1/agents',method:'POST',body:{
    handle:'cli-helper',display_name:'cli-helper',runtime:'claude',local_project_id:null,runtime_config:{}}}]);
  assert.equal(h.root(),null);
});

test('management discovers creation and settings through the runtime contract, not runtime IDs', async t=>{
  const h=deeporcaHarness(), contract=h.chat.runtimeContract({runtime:'deeporca'});
  const capability=h.box.capabilities.runtimes.find(item=>item.runtime==='deeporca');
  capability.runtime=h.agent.runtime='managed-test';
  h.chat.runtimeContract=agent=>agent?.runtime==='managed-test' ? {...contract,label:'Managed test'} : {};
  await t.test('creation fields follow the delegated runtime',async()=>{
    h.management.createAgent('m1');await flush();
    const root=h.root();change(root.querySelector('[data-field="runtime"]'),'managed-test');
    assert.equal(root.querySelector('[data-field="local_project_id"]').required,true);
    assert.match(root.querySelector('[data-project-help]').textContent,/Managed test requires/);
    assert.equal(root.querySelector('[data-field="template"]'),null);
    assert.equal(root.querySelector('[data-field="base_url"]').closest('.field').hidden,false);
    assert.equal(root.querySelector('[data-field="base_url"]').disabled,false);
  });
  await t.test('settings recheck the current runtime contract',async()=>{
    await h.close();await h.open();assert.equal(h.field().value,'Local helper');
    h.chat.runtimeContract=()=>({});
    h.field().value='Not authorized';submit(h.root());await flush();assert.equal(h.calls.length,0);
    assert.equal(h.agent.display_name,'Local helper');await h.close();
  });
});

test('runtime UI modules still use the fixed local allowlist', async()=>{
  const h=deeporcaHarness();
  h.chat.runtimeContract=()=>({agentUiModule:'https://invalid.example/agent-ui.js',label:'Unsupported'});
  h.management.createAgent('m1');await flush();
  assert.match(h.root().textContent,/Unsupported setup unavailable/);
  assert.equal(h.root().querySelector('[data-field="handle"]'),null);
  assert.equal(h.calls.length,0);
});

test('runtime UI loading rechecks modal lifetime, context and management authorization', async t=>{
  const changes={
    role:h=>{h.ctx.workspace.role='viewer';},
    epoch:h=>{h.ctx.epoch++;},
    removed:h=>{h.ctx.devboxes=[];},
    replacement:h=>{h.dialogs.modal({title:'Replacement',actions:[{label:'Done'}]});},
    closed:h=>h.dialogs.close(),
  };
  for(const operation of ['create','settings']){
    for(const [name,change] of Object.entries(changes)) await t.test(operation+' '+name,async()=>{
      const h=deeporcaHarness(), gate=deferred(), ui=await h.chat.loadLocalModule('runtime-catalog');
      let loads=0;h.chat.loadLocalModule=()=>{loads++;return gate.promise;};
      if(operation==='create') h.management.createAgent('m1');else h.management.agentSettings('native');
      await flush();assert.equal(loads,1);change(h);gate.resolve(ui);await flush();
      assert.equal(h.root()?.querySelector('form') || null,null);assert.equal(h.calls.length,0);
      if(name==='replacement') assert.match(h.root().textContent,/Replacement/);
      else assert.equal(h.root(),null);
    });
  }
});

test('DeepOrca settings reopen with immutable metadata, safe readiness and only a display rename payload', async()=>{
  const h=deeporcaHarness();
  h.agent.runtime_config.credentials='PRIVATE_TOKEN';h.agent.runtime_status.message='C:/private/credentials';
  const originalConfig=clone(h.agent.runtime_config);
  await h.open();
  for(const text of [/Agent settings/,/Project One/,/@native-helper/,/Needs configuration/,/configuration_required/]) assert.match(h.root().textContent,text);
  assert.doesNotMatch(h.root().textContent,/PRIVATE_TOKEN|C:\/private/);
  assert.equal(h.root().querySelector('[data-runtime-status] .pill').textContent,'Needs configuration');
  assert.match(h.root().textContent,/Model connection/);assert.match(h.root().textContent,/Model behavior/);
  for(const name of ['base_url','model','context_window','reasoning_effort']){
    const field=h.root().querySelector(`[data-field="${name}"]`);
    assert.equal(field.value,'');assert.equal(field.disabled,false);assert.equal(!!field.readOnly,false);
  }
  const auth=h.root().querySelector('[data-field="auth_mode"]');
  assert.equal(auth.value,'keep');
  assert.deepEqual(auth.querySelectorAll('option').map(option=>option.value),['keep','api_key','none']);
  assert.equal(h.root().querySelector('[data-field="api_key"]').value,'');
  assert.equal(h.root().querySelector('[data-field="api_key"]').disabled,true);
  for(const name of ['handle','runtime','local_project_id','template','runtime_config'])
    assert.equal(h.root().querySelector(`[data-field="${name}"]`),null);
  h.field().value='Renamed helper';
  h.apiHook=async()=>({...h.agent,display_name:'Renamed helper'});
  submit(h.root());await flush();
  assert.deepEqual(h.calls,[{path:'/api/agents/native',method:'PATCH',body:{display_name:'Renamed helper'}}]);
  assert.equal(h.agent.handle,'native-helper');assert.equal(h.agent.display_name,'Renamed helper');
  assert.equal(h.agent.local_project_id,'p1');assert.equal(h.box.agents.length,1);
  assert.deepEqual(h.agent.runtime_config,originalConfig);
  await h.close();await h.open();assert.equal(h.field().value,'Renamed helper');
  assert.equal(h.root().querySelector('[data-field="auth_mode"]').value,'keep');await h.close();
});

test('DeepOrca settings preserve failed model drafts, keep credentials without replay and require explicit auth for endpoint changes', async()=>{
  const h=deeporcaHarness();
  h.agent.runtime_config={...h.agent.runtime_config,llm:clone(modelConfig),credential:{mode:'sealed',ciphertext:'PRIVATE_STORED_ENVELOPE'}};
  const profile=clone(h.agent.runtime_config.profile);
  await h.open();const root=h.root(), auth=root.querySelector('[data-field="auth_mode"]');
  for(const [name,value] of Object.entries(modelValues)) assert.equal(root.querySelector(`[data-field="${name}"]`).value,value);
  assert.equal(auth.value,'keep');assert.equal(root.querySelector('[data-field="api_key"]').value,'');
  assert.doesNotMatch(root.textContent,/PRIVATE_STORED_ENVELOPE/);
  h.field().value='Configured helper';
  const edits={model:'provider/updated-model',context_window:'65536',reasoning_effort:'max'};
  for(const [name,value] of Object.entries(edits)) change(root.querySelector(`[data-field="${name}"]`),value);
  h.apiHook=()=>{throw new Error('Model update failed');};
  submit(root);await flush();
  const expected={display_name:'Configured helper',runtime_config:{integration_version:1,profile,
    llm:{...modelConfig,...edits,context_window:65536}}};
  assert.deepEqual(h.calls,[{path:'/api/agents/native',method:'PATCH',body:expected}]);
  assert.equal(h.root(),root);assert.match(h.error(),/Model update failed/);
  assert.equal(h.field().value,'Configured helper');assert.equal(h.agent.display_name,'Local helper');
  for(const [name,value] of Object.entries(edits)){
    const field=root.querySelector(`[data-field="${name}"]`);
    assert.equal(field.value,value);assert.equal(field.disabled,false);
  }
  assert.deepEqual(h.agent.runtime_config.llm,modelConfig);assert.equal(auth.value,'keep');
  h.apiHook=(path,options)=>{
    const payload=JSON.parse(options.body);
    return {...h.agent,...payload,runtime_config:{...h.agent.runtime_config,...payload.runtime_config}};
  };
  submit(root);await flush();
  assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].body,expected);
  assert.equal(h.agent.display_name,'Configured helper');assert.equal(root.querySelector('[data-submit]').textContent,'Saved');
  assert.deepEqual(h.agent.runtime_config.credential,{mode:'sealed',ciphertext:'PRIVATE_STORED_ENVELOPE'});
  const endpoint=root.querySelector('[data-field="base_url"]');
  change(endpoint,'https://different-provider.invalid/v1');endpoint.dispatchEvent({type:'input'});
  submit(root);await flush();
  assert.equal(h.calls.length,2);assert.match(h.error(),/Endpoint changed/);
  assert.equal(endpoint.value,'https://different-provider.invalid/v1');assert.equal(auth.value,'keep');
  change(auth,'none');submit(root);await flush();
  assert.equal(h.calls.length,3);
  assert.deepEqual(h.calls[2].body,{...expected,runtime_config:{...expected.runtime_config,
    llm:{...expected.runtime_config.llm,base_url:'https://different-provider.invalid/v1'},credential:{mode:'none'}}});
  assert.doesNotMatch(JSON.stringify(h.calls),/PRIVATE_STORED_ENVELOPE|api_key/);
  assert.deepEqual(h.agent.runtime_config.profile,profile);assert.equal(h.agent.handle,'native-helper');
  assert.equal(h.agent.local_project_id,'p1');assert.equal(h.box.agents.length,1);
  assert.equal(auth.value,'keep');assert.equal(root.querySelector('[data-field="api_key"]').value,'');
  assert.deepEqual(h.detached,[]);assert.deepEqual(h.selections,[]);await h.close();
  await h.open();assert.equal(h.field().value,'Configured helper');
  assert.equal(h.root().querySelector('[data-field="base_url"]').value,'https://different-provider.invalid/v1');
  assert.equal(h.root().querySelector('[data-field="model"]').value,edits.model);await h.close();
});

test('DeepOrca refresh is read-only; retry POST has no binding body and cannot duplicate an Agent', async()=>{
  const h=deeporcaHarness();await h.open();
  const binding=JSON.stringify(h.agent.runtime_config), refreshes=h.refreshes;
  h.field().value='Unsaved draft';
  h.root().querySelector('[data-refresh-status]').click();await flush();
  assert.equal(h.refreshes,refreshes+1);assert.equal(h.calls.length,0);
  assert.equal(h.field().value,'Unsaved draft');
  const gate=deferred();h.apiHook=()=>gate.promise;
  const retry=h.root().querySelector('[data-retry-runtime]');retry.click();retry.click();
  submit(h.root());h.root().querySelector('[data-refresh-status]').click();
  assert.equal(h.calls.length,1);assert.equal(retry.disabled,true);assert.equal(h.field().disabled,true);
  assert.deepEqual(h.calls[0],{path:'/api/agents/native/runtime/retry',method:'POST',body:undefined});
  gate.resolve({...h.agent,runtime_status:{state:'pending'}});await flush();
  assert.equal(h.box.agents.length,1);assert.equal(JSON.stringify(h.agent.runtime_config),binding);
  assert.equal(h.root().querySelector('[data-runtime-status] .pill').textContent,'Pending');assert.equal(retry.hidden,true);
  assert.equal(h.field().value,'Unsaved draft');assert.equal(h.field().disabled,false);
  h.agent.runtime_status={state:'ready'};
  h.root().querySelector('[data-refresh-status]').click();await flush();
  assert.match(h.root().textContent,/not been verified/);assert.equal(retry.hidden,true);assert.equal(h.calls.length,1);
});

test('DeepOrca retry is offered only for repairable states, with safe codes and offline guidance', async t=>{
  for(const state of ['pending','provisioning','ready','needs_configuration','error','C:/private/state']){
    await t.test(state,async()=>{
      const h=deeporcaHarness();h.box.online=false;
      h.agent.runtime_status={state,code:'C:/private/token',message:'PRIVATE_DIAGNOSTIC'};
      await h.open();
      assert.equal(h.root().querySelector('[data-retry-runtime]').hidden,!['needs_configuration','error'].includes(state));
      assert.match(h.root().textContent,/Connector offline/);
      assert.doesNotMatch(h.root().textContent,/C:\/private|PRIVATE_DIAGNOSTIC/);assert.equal(h.calls.length,0);
    });
  }
});

test('Agent settings deny nonmanagers and other-workspace Agents', async t=>{
  for(const variant of ['operator','viewer','wrong workspace','missing']){
    await t.test(variant,async()=>{
      const h=deeporcaHarness();
      if(['operator','viewer'].includes(variant)) h.ctx.workspace.role=variant;
      if(variant==='wrong workspace') h.box.workspace_id='other';
      if(variant==='missing') h.box.agents=[];
      await h.open();assert.equal(h.root(),null);assert.equal(h.refreshes,0);assert.equal(h.calls.length,0);
    });

  }
  const h=deeporcaHarness({role:'admin'});await h.open();assert.ok(h.field());
});

test('CLI Agent defaults save without starting a session', async()=>{
  const h=harness(), box=h.ctx.devboxes[0], agent=box.agents[0];
  agent.runtime='claude'; agent.runtime_config={permission_mode:'plan',extra_args:'--model sonnet'};
  box.capabilities.runtimes[0].surfaces=[{id:'terminal',default:true,features:{permission_modes:['','plan','bypassPermissions']}}];
  h.apiHook=(path,options)=>options.method==='PATCH'?{}:h.defaultApi(path,options);
  h.management.agentSettings('a1'); await flush();
  const root=h.root();
  assert.equal(root.querySelector('[data-field="permission_mode"]').value,'plan');
  change(root.querySelector('[data-field="permission_mode"]'),'bypassPermissions');
  root.querySelector('[data-field="extra_args"]').value='--model opus';
  submit(root);await flush();
  assert.deepEqual(h.mutations()[0].body.runtime_config,{permission_mode:'bypassPermissions',extra_args:'--model opus'});
  assert.equal(h.mutations().length,1);
});

test('DeepOrca writes recheck workspace, identity, role, epoch and Agent ownership before HTTP', async t=>{
  const changes = {
    workspace:h=>{h.ctx.workspace={id:'other',role:'owner'};},
    user:h=>{h.ctx.user={id:8};}, role:h=>{h.ctx.workspace.role='operator';},
    epoch:h=>{h.ctx.epoch++;}, moved:h=>{h.box.workspace_id='other';},
    removed:h=>{h.box.agents=[];}, runtime:h=>{h.agent.runtime='cli';},
  };
  for(const [name,change] of Object.entries(changes)){
    for(const operation of ['rename','retry']) await t.test(name+' '+operation,async()=>{
      const h=deeporcaHarness();await h.open();h.field().value='Stale draft';const root=h.root();change(h);
      if(operation==='rename') submit(root);else root.querySelector('[data-retry-runtime]').click();
      await flush();assert.equal(h.calls.length,0);assert.equal(h.agent.display_name,'Local helper');
    });
  }
});

test('DeepOrca async payload preparation rechecks permissions and dialog lifetime before HTTP', async t=>{
  for(const operation of ['create','settings']){
    for(const variant of ['role','workspace','replacement','closed']) await t.test(operation+' '+variant,async()=>{
      const h=deeporcaHarness(), gate=deferred(), ui=await h.chat.loadLocalModule('runtime-catalog');
      const method=operation==='create' ? 'creationConfigFromValues' : 'settingsPayload';
      let preparations=0;
      // Hold the real validated payload at the same async boundary as credential encryption.
      h.chat.loadLocalModule=async()=>({...ui,[method]:async(...args)=>{
        const payload=await ui[method](...args);preparations++;await gate.promise;return payload;
      }});
      if(operation==='create'){
        h.management.createAgent('m1');await flush();
        change(h.root().querySelector('[data-field="runtime"]'),'deeporca');
        change(h.root().querySelector('[data-field="local_project_id"]'),'p1');
        h.root().querySelector('[data-field="handle"]').value='pending-helper';
      } else await h.open();
      const root=h.root(), original=clone(h.agent), refreshes=h.refreshes;
      fillModel(root);change(root.querySelector('[data-field="auth_mode"]'),'none');
      submit(root);await flush();
      assert.equal(preparations,1);assert.equal(h.calls.length,0);assert.equal(root.querySelector('[data-submit]').disabled,true);
      if(variant==='role') h.ctx.workspace.role='viewer';
      if(variant==='workspace') h.switchWorkspace('w2');
      if(variant==='replacement') h.dialogs.modal({title:'Replacement',bodyHtml:'Keep this dialog',actions:[{label:'Done'}]});
      if(variant==='closed') h.dialogs.close();
      const replacement=variant==='replacement' ? h.root() : null;
      gate.resolve();await flush();
      assert.equal(h.calls.length,0,'No request may escape after authorization or dialog ownership changes during preparation');
      assert.deepEqual(h.agent,original);assert.equal(h.box.agents.length,1);assert.equal(h.refreshes,refreshes);
      assert.deepEqual(h.detached,[]);assert.deepEqual(h.selections,[]);
      if(replacement){assert.equal(h.root(),replacement);assert.match(replacement.textContent,/Keep this dialog/);}
      if(variant==='closed' || variant==='workspace') assert.equal(h.root(),null);
      await h.close();
    });
  }
});

test('DeepOrca stale async responses cannot mutate rows, refresh or replace another dialog', async t=>{
  for(const operation of ['rename','retry']){
    for(const change of ['role','workspace','replacement','closed']) await t.test(operation+' '+change,async()=>{
      const h=deeporcaHarness();await h.open();const gate=deferred();h.apiHook=()=>gate.promise;
      if(operation==='rename'){h.field().value='Late rename';submit(h.root());}
      else h.root().querySelector('[data-retry-runtime]').click();
      await flush();assert.equal(h.calls.length,1); // The async payload is prepared before testing an in-flight response.
      const count=h.refreshes;
      if(change==='role') h.ctx.workspace.role='viewer';
      if(change==='workspace') h.ctx.workspace={id:'other',role:'owner'};
      if(change==='replacement') h.dialogs.modal({title:'Replacement',bodyHtml:'Do not replace',actions:[{label:'Done'}]});
      if(change==='closed') h.dialogs.close();
      gate.resolve({...h.agent,display_name:'Late rename',runtime_status:{state:'pending'}});await flush();
      assert.equal(h.agent.display_name,'Local helper');assert.equal(h.agent.runtime_status.state,'needs_configuration');
      assert.equal(h.refreshes,count);assert.equal(h.calls.length,1);
      if(change==='replacement') assert.match(h.root().textContent,/Replacement/);
      if(change==='closed') assert.equal(h.root(),null);
    });
  }
  for(const change of ['role','workspace','replacement']) await t.test('initial refresh '+change,async()=>{
    const gate=deferred(),h=deeporcaHarness();h.refreshHook=()=>gate.promise;h.management.agentSettings('native');
    if(change==='role') h.ctx.workspace.role='viewer';
    if(change==='workspace') h.ctx.epoch++;
    if(change==='replacement') h.dialogs.modal({title:'Replacement',bodyHtml:'Keep this',actions:[{label:'Done'}]});
    gate.resolve();await flush();
    assert.equal(h.root()?.querySelector('[data-field="display_name"]') || null,null);
    if(change==='replacement') assert.match(h.root().textContent,/Replacement/);
    assert.equal(h.calls.length,0);
  });
});

test('DeepOrca failed retry and rename preserve drafts and allow explicit retry only', async()=>{
  const h=deeporcaHarness();await h.open();h.field().value='Keep draft';
  h.apiHook=async()=>{throw new Error('Connector request failed');};
  h.root().querySelector('[data-retry-runtime]').click();await flush();
  assert.match(h.error(),/Connector request failed/);assert.equal(h.field().value,'Keep draft');
  assert.equal(h.root().querySelector('[data-retry-runtime]').disabled,false);
  assert.equal(h.calls.length,1);assert.equal(h.box.agents.length,1);
  submit(h.root());await flush();assert.match(h.error(),/Connector request failed/);
  assert.equal(h.field().value,'Keep draft');assert.equal(h.calls.length,2);
  h.field().value='x'.repeat(201);submit(h.root());await flush();assert.equal(h.calls.length,2);assert.match(h.error(),/at most 200/);
  h.field().value='';submit(h.root());await flush();assert.equal(h.calls.length,2);
});
