const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createBrowser, deferred} = require('./test-dom.js');

function harness({signedIn=true,poll=false,hash='',search='',tmux=false,manualLaunch=false}={}){
  const browser=createBrowser();
  browser.window.location.hash=hash;browser.window.location.search=search;
  browser.window.history={replaceState(_state,_title,value){
    const url=new URL(value,'http://test.invalid');
    browser.window.location.hash=url.hash;browser.window.location.search=url.search;
  }};
  const Dialogs=browser.loadModule('./dialogs.js'), createDialogs=Dialogs.createDialogs;
  if(!manualLaunch) Dialogs.createDialogs=(...args)=>{
    const dialogs=createDialogs(...args), form=dialogs.form;
    dialogs.form=config=>['Launch session','Resume session'].includes(config.title)
      ? Promise.resolve({permission_mode:'',extra_args:''}) : form(config);
    return dialogs;
  };
  const App=browser.loadModule('./app.js');
  const storage=new Map(), session=new Map(), requests=[];
  if(tmux)storage.set('agentbridge.shortcuts','tmux');
  const store=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  const user={id:'user',username:'preview',role:'owner'};
  const workspaces=[{id:'one',name:'One',role:'owner',is_personal:true},{id:'two',name:'Two',role:'operator'}];
  const capabilities={runtimes:[{schema_version:2,runtime:'cli',installation:{status:'installed'},surfaces:[
    {id:'structured',default:true,available:true,features:{structured:true,controls:[]}},
    {id:'terminal',available:true,features:{structured:false,controls:[]}},
  ]}]};
  const devboxes=[{id:'m1',workspace_id:'one',name:'Machine one',online:true,capabilities,
    agents:[{id:'a1',handle:'alpha',display_name:'Alpha',runtime:'cli',presence:'idle'}]},
    {id:'m2',workspace_id:'two',name:'Machine two',online:true,capabilities,
    agents:[{id:'a2',handle:'beta',display_name:'Beta',runtime:'cli',presence:'idle'}]}];
  let signed=signedIn, sequence=0, override=null;
  const api=async(url,options={})=>{
    requests.push({url,...options});
    if(override){const answer=await override(url,options);if(answer!==undefined)return answer;}
    if(url==='/api/me/user'){
      if(!signed){const error=new Error('Sign in');error.status=401;throw error;}
      return user;
    }
    if(url==='/api/auth/config')return {mode:'local',password_enabled:true,microsoft_enabled:false};
    if(url==='/api/auth/bootstrap-status')return {available:false};
    if(url==='/api/auth/bootstrap'&&options.method==='POST'){signed=true;return user;}
    if(url==='/api/auth/register'){signed=true;return user;}
    if(url==='/api/auth/login'){signed=true;return user;}
    if(url==='/api/auth/logout'){signed=false;return {};}
    if(url==='/api/workspaces')return workspaces;
    if(url==='/api/devboxes')return devboxes;
    if(/^\/api\/agents\/[^/]+\/sessions$/.test(url))return options.method==='POST'
      ? {id:'created-'+(++sequence),agent_id:url.split('/')[3],surface:JSON.parse(options.body).surface,state:'inactive'} : [];
    if(url.endsWith('/messages'))return [];
    throw new Error('Unexpected API request: '+url);
  };
  const root=browser.document.createElement('main'); root.id='app'; browser.document.body.appendChild(root);
  const app=App.createApp({root,api,storage:store(storage),sessionStorage:store(session),poll});
  return {...browser,root,app,user,workspaces,devboxes,storage,session,requests,
    override:fn=>{override=fn;},setSigned:value=>{signed=value;},by:id=>root.querySelector('#'+id)};
}

function press(h,key,modifiers={},target=h.root){
  let prevented=false;
  h.document.body.dispatchEvent({type:'keydown',target,key,...modifiers,
    preventDefault(){prevented=true;},stopPropagation(){}});
  return prevented;
}

test('the agentbridge shell starts empty and does not pre-create or connect agents', async()=>{
  const h=harness(); await h.app.start();
  assert.match(h.root.textContent,/AgentBridge/);
  assert.ok(h.root.querySelector('.app-bar'));
  assert.ok(h.root.querySelector('.sidebar'));
  assert.equal(h.root.querySelector('.tmux-status'),null);
  assert.equal(h.app.getState().tmuxEnabled,false);
  assert.equal(h.app.getState().workspaceId,'one');
  assert.equal(h.app.getState().paneCount,1);
  assert.equal(h.sockets.length,0);
  assert.equal(h.requests.some(request=>request.method==='POST'),false);
  assert.equal(h.root.querySelectorAll('.pane').length,1);
  h.app.destroy();
});

test('agent row expands to all sessions and attaches the chosen live one', async()=>{
  const h=harness(); await h.app.start();
  h.override(url=>url==='/api/agents/a1/sessions'?[
    {id:'s2',agent_id:'a1',title:'Second',surface:'structured',state:'live',created_at:'2026-01-01T10:00:00'},
    {id:'s1',agent_id:'a1',title:'Old',surface:'structured',state:'ended',created_at:'2026-01-01T09:00:00'}]:undefined);
  h.root.querySelector('[data-agent-sessions="a1"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  const rows=h.root.querySelectorAll('[data-open-session]');
  assert.equal(rows.length,2);
  assert.match(rows[0].textContent,/Second/);
  rows[0].click();
  await new Promise(resolve=>setTimeout(resolve,0));
  h.sockets[0].open();
  assert.equal(h.sockets[0].frames[0].type,'attach');
  assert.equal(h.sockets[0].frames[0].session_id,'s2');
  h.app.destroy();
});

test('opening an agent delegates to its pane and workspace switch detaches it, not the agent', async()=>{
  const h=harness(); await h.app.start();
  await h.app.openAgent('a1','structured');
  assert.equal(h.sockets.length,1); h.sockets[0].open();
  assert.equal(h.sockets[0].frames[0].type,'attach');
  const old=h.sockets[0];
  await h.app.selectWorkspace('two');
  assert.equal(old.readyState,3);
  assert.ok(!old.frames.some(frame=>frame.type==='terminate'));
  assert.match(h.by('workspace-switch').textContent,/Two/);
  assert.ok(h.root.querySelector('.pane-empty'));
  const before=h.requests.length; await h.app.openAgent('a1');
  assert.equal(h.requests.length,before,'old-workspace ids cannot open in the new workbench');
  const key='agentbridge.workbench.v1:'+JSON.stringify(['user','one']);
  assert.match(h.storage.get(key),/created-1/);
  assert.ok(!h.storage.get(key).includes('text'));
  h.app.destroy();
});

test('sidebar New session prompts before creating and cancellation never launches',async()=>{
  const h=harness({manualLaunch:true});await h.app.start();
  h.root.querySelector('[data-open-agent="a1"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.sockets.length,0);
  h.root.querySelector('[data-new-session="a1"]').click();
  h.document.querySelector('.context-menu button').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(h.document.querySelector('.overlay').textContent,/Launch session/);
  assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
  h.document.querySelector('[data-cancel]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
  const opening=h.app.openAgent('a1','structured');
  await new Promise(resolve=>setTimeout(resolve,0));
  h.document.querySelector('[data-field="extra_args"]').value='--model opus';
  h.document.querySelector('.overlay form').dispatchEvent({type:'submit',preventDefault(){}});
  await opening;
  const created=h.requests.find(r=>r.method==='POST');
  assert.deepEqual(JSON.parse(created.body).launch_options,{permission_mode:'',extra_args:'--model opus'});
  h.app.destroy();
});

test('sidebar rename and confirmed deletion operate on the selected session without a pane',async()=>{
  const h=harness();await h.app.start();
  const session={id:'s1',agent_id:'a1',title:'Old',surface:'structured',state:'ended',can_rename:true};
  let sessions=[session];
  h.override((url,options)=>{
    if(url==='/api/agents/a1/sessions')return sessions;
    if(url==='/api/sessions/s1'&&options.method==='PATCH'){session.title=JSON.parse(options.body).title;return session;}
    if(url==='/api/sessions/s1'&&options.method==='DELETE'){sessions=[];return {};}
  });
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const menu=async(label)=>{
    h.root.querySelector('[data-session-menu="s1"]').click();
    h.document.querySelectorAll('.context-menu button').find(button=>button.textContent===label).click();
    await tick();
  };
  h.root.querySelector('[data-agent-sessions="a1"]').click();await tick();
  await menu('Rename');
  h.document.querySelector('[data-field="title"]').value='Renamed';
  h.document.querySelector('.overlay form').dispatchEvent({type:'submit',preventDefault(){}});
  await tick();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.method==='PATCH').body),{title:'Renamed',expected_title:'Old'});
  assert.match(h.root.querySelector('[data-open-session="s1"]').textContent,/Renamed/);
  await menu('Delete session…');
  h.document.querySelectorAll('[data-action-index]').find(b=>b.textContent==='Cancel').click();await tick();
  assert.equal(h.requests.some(r=>r.method==='DELETE'),false);
  await menu('Delete session…');
  h.document.querySelectorAll('[data-action-index]').find(b=>b.textContent==='Delete session').click();await tick();
  assert.equal(h.root.querySelector('[data-open-session="s1"]'),null);
  assert.equal(h.sockets.length,0);
  h.app.destroy();
});

test('Ctrl+K remains a native editing shortcut in chat and terminal input areas', async()=>{
  const h=harness(); await h.app.start(); await h.app.openAgent('a1','structured');
  const input=h.root.querySelector('[data-ui="chat-input"]');
  let prevented=false;
  h.document.body.dispatchEvent({type:'keydown',target:input,key:'k',ctrlKey:true,preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,false);
  assert.equal(h.document.getElementById('overlay'),null);
  h.document.body.dispatchEvent({type:'keydown',target:h.root,key:'k',ctrlKey:true,preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  assert.ok(h.document.getElementById('overlay'));
  h.app.destroy();
});

test('Ctrl+B prefix splits from an input without inserting prefix keys or creating hidden sessions',async()=>{
  const h=harness({tmux:true});await h.app.start();await h.app.openAgent('a1','structured');
  const input=h.root.querySelector('[data-ui="chat-input"]');input.value='untouched';
  const posts=h.requests.filter(r=>r.method==='POST').length;
  assert.equal(press(h,'b',{ctrlKey:true},input),true);
  assert.equal(h.app.getState().prefixPending,true);
  assert.match(h.by('prefix-hint').textContent,/Prefix/);
  assert.equal(press(h,'Shift',{},input),false);
  assert.equal(h.app.getState().prefixPending,true);
  assert.equal(press(h,'%',{shiftKey:true},input),true);
  assert.equal(h.app.getState().prefixPending,false);
  assert.equal(h.app.getState().paneCount,2);
  assert.equal(input.value,'untouched');
  assert.equal(h.requests.filter(r=>r.method==='POST').length,posts);
  assert.ok(h.document.getElementById('overlay'));
  h.app.destroy();
});

test('prefix is disabled in sign-in fields and never steals unprefixed editing keys',async()=>{
  const h=harness({signedIn:false});await h.app.start();
  const password=h.root.querySelector('[name="password"]');
  assert.equal(press(h,'b',{ctrlKey:true},password),false);
  h.app.destroy();
  const active=harness();await active.app.start();await active.app.openAgent('a1','structured');
  const input=active.root.querySelector('[data-ui="chat-input"]');
  assert.equal(press(active,'c',{ctrlKey:true},input),false);
  assert.equal(press(active,'%',{shiftKey:true},input),false);
  assert.equal(active.app.getState().paneCount,1);
  active.app.destroy();
});

test('tmux shortcuts are opt-in, persisted, and do not capture sidebar editing',async()=>{
  const h=harness();await h.app.start();await h.app.openAgent('a1','structured');
  const input=h.root.querySelector('[data-ui="chat-input"]');
  assert.equal(press(h,'b',{ctrlKey:true},input),false);
  assert.equal(h.app.getState().tmuxEnabled,false);
  h.by('account-menu').click();
  h.document.querySelectorAll('[role="menuitem"]').find(button=>button.textContent==='Keyboard shortcuts').click();
  for(let i=0;i<6;i++)await Promise.resolve();
  const toggle=h.document.querySelector('[data-enable-tmux]');toggle.checked=true;toggle.onchange();
  assert.equal(h.app.getState().tmuxEnabled,true);
  assert.equal(h.storage.get('agentbridge.shortcuts'),'tmux');
  h.document.body.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
  assert.equal(press(h,'b',{ctrlKey:true},h.by('agent-filter')),false);
  assert.equal(press(h,'b',{ctrlKey:true},input),true);
  assert.equal(h.app.getState().prefixPending,true);
  h.app.destroy();
});

test('double Ctrl+B forwards exactly one byte only through the owned terminal',async()=>{
  const h=harness({tmux:true});await h.app.start();await h.app.openAgent('a1','terminal');
  const socket=h.sockets[0];socket.open();
  socket.receive({type:'ready',surface:'terminal'});
  socket.receive({type:'collaboration',role:'owner',keyboard:{holder_user_id:'user',is_holder:true}});
  const inputs=()=>socket.frames.filter(f=>f.type==='input');
  const before=inputs().length;
  press(h,'b',{ctrlKey:true});assert.equal(inputs().length,before);
  press(h,'b',{ctrlKey:true});
  assert.equal(inputs().length,before+1);assert.equal(inputs().at(-1).data,'\u0002');
  assert.equal(h.app.getState().prefixPending,false);
  h.app.destroy();
});

test('the bottom command line accepts only UI commands and never sends its contents to agents',async()=>{
  const h=harness({tmux:true});await h.app.start();await h.app.openAgent('a1','structured');
  const socket=h.sockets[0];socket.open();
  const before=socket.frames.length;
  press(h,'b',{ctrlKey:true});press(h,':',{shiftKey:true});
  assert.equal(h.app.getState().commandOpen,true);
  h.by('tmux-command-input').value='run-shell touch do-not-run';
  h.by('tmux-command').onsubmit({preventDefault(){}});
  assert.equal(socket.frames.length,before);
  assert.equal(h.app.getState().commandOpen,false);
  assert.equal(h.by('tmux-command-input').value,'');
  assert.match(h.document.querySelector('.toast').textContent,/No shell command was run/);
  press(h,'b',{ctrlKey:true});press(h,':',{shiftKey:true});
  h.by('tmux-command-input').value='split-window -v';
  h.by('tmux-command').onsubmit({preventDefault(){}});
  assert.equal(h.app.getState().paneCount,2);
  assert.ok(![...h.storage.values()].some(value=>value.includes('run-shell')));
  h.app.destroy();assert.equal(h.timers.size,0);
});

test('a stale authentication response cannot repaint or connect a destroyed application', async()=>{
  const h=harness(), waiting=deferred();
  h.override(url=>url==='/api/me/user'?waiting.promise:undefined);
  const start=h.app.start();
  h.app.destroy(); waiting.resolve(h.user); await start;
  assert.equal(h.root.children.length,0);
  assert.equal(h.sockets.length,0);
  assert.equal(h.windowListeners.get('resize')?.size||0,0);
  assert.equal(h.document.body.listeners.get('keydown')?.size||0,0);
});

test('local registration uses the backend login response without pre-connecting machines', async()=>{
  const h=harness({signedIn:false}); await h.app.start();
  const form=h.root.querySelector('[data-login-form]');
  assert.ok(form);
  form.querySelector('[data-toggle-register]').onclick();
  form.querySelector('[name="username"]').value='new-owner';
  form.querySelector('[name="password"]').value='test-only';
  await form.onsubmit({preventDefault(){}});
  const posts=h.requests.filter(request=>request.method==='POST').map(request=>request.url);
  assert.deepEqual(posts,['/api/auth/register']);
  assert.equal(h.app.getState().userId,'user');
  assert.equal(h.sockets.length,0);
  h.app.destroy();
});

test('network outages are not mislabeled as a login screen', async()=>{
  const h=harness(); h.override(url=>{
    if(url==='/api/me/user')throw new Error('Server unavailable');
  });
  await h.app.start();
  assert.match(h.root.textContent,/Connection unavailable/);
  assert.ok(h.root.querySelector('[data-retry]'));
  assert.equal(h.root.querySelector('[data-login-form]'),null);
  h.app.destroy();
});

test('local account invitation links prefill registration and clear the address without persistence',async()=>{
  const h=harness({signedIn:false,hash:'#invite=test-only-invitation',search:'?keep=1'});
  h.override(url=>url==='/api/auth/bootstrap-status'?{available:false}:undefined);
  await h.app.start();
  assert.equal(h.window.location.hash,'');assert.equal(h.window.location.search,'?keep=1');
  const form=h.root.querySelector('[data-login-form]');
  assert.equal(form.querySelector('[name="invitation"]').value,'test-only-invitation');
  assert.equal(form.querySelector('[data-invite-label]').hidden,false);
  form.querySelector('[name="username"]').value='invitee';form.querySelector('[name="password"]').value='test-only';
  await form.onsubmit({preventDefault(){}});
  const registration=h.requests.find(request=>request.url==='/api/auth/register');
  assert.equal(JSON.parse(registration.body).invite_code,'test-only-invitation');
  assert.ok(![...h.storage.values(),...h.session.values()].some(value=>value.includes('test-only-invitation')));
  h.app.destroy();
});

test('first-owner bootstrap uses its dedicated token-protected endpoint',async()=>{
  const h=harness({signedIn:false});
  h.override(url=>url==='/api/auth/bootstrap-status'?{available:true}:undefined);
  await h.app.start();
  const form=h.root.querySelector('[data-login-form]');
  assert.equal(form.querySelector('[data-login-submit]').textContent,'Create first owner');
  assert.equal(form.querySelector('[data-code-label]').textContent,'Bootstrap token');
  form.querySelector('[name="username"]').value='owner';form.querySelector('[name="password"]').value='test-only';
  form.querySelector('[name="invitation"]').value='bootstrap-only';
  await form.onsubmit({preventDefault(){}});
  const posts=h.requests.filter(request=>request.method==='POST');
  assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/auth/bootstrap');
  assert.equal(JSON.parse(posts[0].body).token,'bootstrap-only');
  h.app.destroy();
});

test('Microsoft-only sign-in uses the configured routes and never renders password fields',async()=>{
  const h=harness({signedIn:false});
  h.override(url=>url==='/api/auth/config'?{mode:'microsoft',password_enabled:false,microsoft_enabled:true,
    microsoft_login_url:'/api/auth/microsoft/start',microsoft_logout_url:'/api/auth/microsoft/logout'}:undefined);
  await h.app.start();
  assert.equal(h.root.querySelector('[data-login-form]'),null);
  h.root.querySelector('[data-ms-login]').click();
  assert.equal(h.window.location.href,'/api/auth/microsoft/start');
  assert.equal(h.requests.some(request=>request.method==='POST'),false);
  h.app.destroy();
});

test('Microsoft sign-out clears app auth then visits the provider logout route',async()=>{
  const h=harness();
  h.override(url=>url==='/api/auth/config'?{mode:'microsoft',password_enabled:false,microsoft_enabled:true,
    microsoft_login_url:'/api/auth/microsoft/start',microsoft_logout_url:'/api/auth/microsoft/logout'}:undefined);
  await h.app.start();h.by('account-menu').click();
  h.document.querySelectorAll('[role="menuitem"]').find(button=>button.textContent==='Sign out').click();
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(h.window.location.href,'/api/auth/microsoft/logout');
  assert.ok(h.requests.some(request=>request.url==='/api/auth/logout'&&request.method==='POST'));
  h.app.destroy();
});

test('local helper order is deterministic and optional CDN assets are not in the boot path',()=>{
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  assert.match(html,/<title>AgentBridge<\/title>/);
  assert.doesNotMatch(html,/<(?:script|link)[^>]+(?:src|href)="https?:/);
  assert.ok(html.indexOf('/static/pane.js')<html.indexOf('/static/workbench.js'));
  assert.ok(html.indexOf('/static/app.js')<html.indexOf('/static/main.js'));
  const css=fs.readFileSync(path.join(__dirname,'styles.css'),'utf8');
  assert.match(css,/\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/);
});
