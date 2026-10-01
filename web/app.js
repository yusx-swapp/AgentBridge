/* Application shell: identity, workspace and catalog. Sessions belong to panes. */
(function(root, factory){
  const common = typeof module === 'object' && module.exports;
  const api = factory(
    common ? require('./ui.js') : root.AgentBridgeUI,
    common ? require('./api.js') : root.AgentBridgeApi,
    common ? require('./dialogs.js') : root.AgentBridgeDialogs,
    common ? require('./workbench.js') : root.AgentBridgeWorkbench,
    common ? require('./management.js') : root.AgentBridgeManagement,
    common ? require('./terminal-assets.js') : root.AgentBridgeTerminalAssets,
    common ? require('./tmux.js') : root.AgentBridgeTmux);
  if(common) module.exports = api;
  else root.AgentBridgeApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(UI, Api, Dialogs, Workbench, Management, TerminalAssets, Tmux){
  'use strict';
  const BRAND = 'AgentBridge';
  const svg=path=>`<svg viewBox="0 0 20 20" aria-hidden="true">${path}</svg>`;
  const MARK=svg('<path d="M3 5h5v10H3zM12 5h5v10h-5zM8 10h4"/>');
  const ICONS={
    sidebar:svg('<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/>'),
    search:svg('<circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/>'),
    chevron:svg('<path d="m6 8 4 4 4-4"/>'),
    plus:svg('<path d="M10 4v12M4 10h12"/>'),
    more:svg('<circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/>'),
    members:svg('<circle cx="7" cy="7" r="3"/><path d="M2 17v-2a5 5 0 0 1 10 0v2M13 4a3 3 0 0 1 0 6M15 12a4 4 0 0 1 3 4v1"/>'),
    agent:svg('<rect x="3" y="4" width="14" height="12" rx="3"/><path d="m6 8 2 2-2 2M11 12h3"/>'),
  };
  const esc = UI.escapeHtml;
  const EDITABLE = 'input,textarea,select,[contenteditable="true"]';

  function createApp({root, api:providedApi, fetch:providedFetch, storage:providedStorage,
                      sessionStorage:providedSessionStorage, poll=true, ensureTerminal:providedTerminal}={}){
    if(!root) throw new TypeError('App root is required');
    const document = root.ownerDocument, window = document.defaultView || globalThis;
    let storage = providedStorage, sessionStorage = providedSessionStorage;
    try { if(storage === undefined) storage = window.localStorage; } catch { storage = null; }
    try { if(sessionStorage === undefined) sessionStorage = window.sessionStorage; } catch { sessionStorage = null; }
    const api = providedApi || Api.createApi(providedFetch || window.fetch.bind(window));
    const dialogs = Dialogs.createDialogs(document);
    const terminalAssets = TerminalAssets.createTerminalAssets({document,window});
    const ensureTerminal = providedTerminal || terminalAssets.ready;
    let user = null, authConfig = null, workspaces = [], devboxes = [], activeWorkspaceId = null;
    let bench = null, epoch = 0, catalogRequest = 0, pollTimer = null, dead = false, shellReady = false;
    let prefixPending = false, commandOpen = false, commandReturnFocus = null, consumedKey = null;
    const savedSidebar=readPref('sidebar');
    let sidebarClosed=savedSidebar ? savedSidebar==='closed' : !!window.matchMedia?.('(max-width:680px)').matches;
    let query='', tmuxEnabled=readPref('shortcuts')==='tmux', expanded=null, liveSessions=null;
    let theme = readPref('theme', 'deepbox.theme') === 'light' ? 'light' : 'dark';
    let pendingInvite = null, accountInvite = '';
    const inviteKey = 'agentbridge.pendingWorkspaceInvitation';
    const legacyInviteKey = 'deepbox.pendingWorkspaceInvitation';
    applyTheme();
    readInvite();

    function readPref(name, legacy){
      try { return storage?.getItem('agentbridge.' + name) ?? (legacy ? storage?.getItem(legacy) : null); }
      catch { return null; }
    }
    function writePref(name,value){ try { storage?.setItem('agentbridge.'+name,String(value)); } catch {} }
    function applyTheme(){ (document.documentElement || root).dataset.theme = theme; }
    function readInvite(){
      try {
        const hash = new URLSearchParams((window.location.hash||'').slice(1));
        const search = new URLSearchParams(window.location.search||'');
        const account = hash.get('invite') || search.get('invite') || '';
        if(account){
          if(account.length <= 1024) accountInvite = account;
          hash.delete('invite'); search.delete('invite');
          const query = search.toString(), fragment = hash.toString();
          window.history?.replaceState(null,'',window.location.pathname+(query?'?'+query:'')+(fragment?'#'+fragment:''));
        }
        pendingInvite = new URLSearchParams((window.location.hash||'').slice(1)).get('join') ||
          sessionStorage?.getItem(inviteKey) || sessionStorage?.getItem(legacyInviteKey);
        if(pendingInvite && pendingInvite.length <= 1024) sessionStorage?.setItem(inviteKey,pendingInvite);
        else pendingInvite = null;
      } catch { pendingInvite = null; }
    }
    function clearInvite(){
      pendingInvite = null;
      try { sessionStorage?.removeItem(inviteKey); sessionStorage?.removeItem(legacyInviteKey); } catch {}
      if((window.location.hash||'').includes('join=')) window.history?.replaceState(null,'',window.location.pathname+window.location.search);
    }
    function workspace(){ return workspaces.find(item=>item.id === activeWorkspaceId) || null; }
    function boxes(){ return UI.devboxesForWorkspace(devboxes,activeWorkspaceId); }
    function findAgent(id){
      for(const box of boxes()){
        const agent = (box.agents||[]).find(item=>item.id === id);
        if(agent) return {agent,box};
      }
      return null;
    }
    function defaultSurface(id){
      const found = findAgent(id);
      return UI.preferredSurface(found ? UI.findRuntimeCapability(found.box.capabilities,found.agent.runtime) : null);
    }
    function canManage(){ return UI.canAdminWorkspace(workspace()?.role); }
    function context(){ return {user,workspace:workspace(),workspaces,devboxes,epoch}; }
    function by(id){ return root.querySelector('#'+id); }
    function scopedMenu(anchor,items){
      const scope=epoch;
      dialogs.menu(anchor,items.map(item=>item.action ? {...item,action:()=>{
        if(!dead && scope===epoch) return item.action();
      }} : item));
    }
    async function copyText(text){
      if(!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable. Select and copy the code manually.');
      await window.navigator.clipboard.writeText(text);
    }
    const management = Management.createManagement({api,dialogs,context,refresh,selectWorkspace,
      closeAgent:id=>bench?.closeAgent(id),copyText,location:window.location,document,window});

    function stopWorkbench(){
      resetKeys();
      dialogs.close(); bench?.close(); bench = null;
      if(pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
    }

    async function start(){
      if(dead) return;
      const current = ++epoch; ++catalogRequest;
      stopWorkbench(); shellReady = false; user = null;
      root.innerHTML = `<main class="start-screen"><span class="brand">${MARK}<b>${BRAND}</b></span><p class="empty-hint">Connecting…</p></main>`;
      try {
        const account = await api('/api/me/user');
        if(dead || epoch !== current) return;
        user = account;
        authConfig = await api('/api/auth/config');
        if(dead || epoch !== current) return;
        activeWorkspaceId = readPref('workspace','deepbox.workspace');
        await refresh();
        if(dead || epoch !== current) return;
        renderShell();
        if(poll) pollTimer = window.setInterval(()=>{
          const scope=epoch;
          refresh().then(()=>expanded && loadSessions(expanded)).catch(error=>{
            if(dead || scope!==epoch) return;
            if(error.status === 401 || error.status === 403) start();
            else notice('Catalog unavailable; existing sessions are independent.');
          });
        },15000);
        if(pendingInvite){
          const token = pendingInvite; clearInvite();
          await management.presentInvitation(token);
        }
      } catch(error) {
        if(dead || epoch !== current) return;
        if(error.status === 401){ user=null; await renderLogin(current); }
        else renderFailure(error.message || 'The server is unavailable.');
      }
    }

    async function renderLogin(current){
      let info;
      try { info = await api('/api/auth/config'); }
      catch { renderFailure('The sign-in service is unavailable.'); return; }
      if(dead || epoch !== current) return;
      authConfig = info;
      const mode = info.mode || 'local';
      root.innerHTML = `<main class="start-screen"><section class="login-card">
        <span class="brand">${MARK}<b>${BRAND}</b></span><h1>Sign in to your workspace</h1>
        <p class="login-caption">Your local agents, together in one place.</p>
        ${info.microsoft_enabled ? '<button class="login-microsoft" data-ms-login>Continue with Microsoft</button>' : ''}
        ${mode === 'microsoft' && !info.microsoft_enabled ? '<p class="modal-err">Microsoft sign-in is unavailable. Contact the service owner.</p>' : ''}
        ${info.password_enabled ? `<form data-login-form>
          <label>Username<input name="username" autocomplete="username" required/></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required/></label>
          <label data-invite-label hidden><span data-code-label>Invitation code</span><input name="invitation" autocomplete="off"/></label>
          <p data-login-error class="modal-err" role="alert"></p>
          <button type="submit" data-login-submit>Sign in</button><button type="button" class="ghost" data-toggle-register>Create an account</button>
        </form>` : '<p class="login-hint">Use your organization account.</p>'}
      </section></main>`;
      root.querySelector('[data-ms-login]')?.addEventListener('click',()=>{
        if(epoch !== current) return;
        window.location.href = info.microsoft_login_url || '/api/auth/microsoft/start';
      });
      const form = root.querySelector('[data-login-form]');
      if(!form) return;
      let authAction = accountInvite ? 'register' : 'login', pending = false, bootstrapAvailable = false;
      const submit = form.querySelector('[data-login-submit]'), toggle = form.querySelector('[data-toggle-register]');
      const invitation = form.querySelector('[data-invite-label]'), error = form.querySelector('[data-login-error]');
      form.querySelector('[name="invitation"]').value = accountInvite;
      try { bootstrapAvailable = !!(await api('/api/auth/bootstrap-status')).available; } catch {}
      if(dead || epoch !== current) return;
      if(bootstrapAvailable && !accountInvite) authAction = 'bootstrap';
      function modeChanged(){
        submit.textContent = authAction === 'bootstrap' ? 'Create first owner' : authAction === 'register' ? 'Create account' : 'Sign in';
        toggle.textContent = authAction !== 'login' ? 'Back to sign in' : bootstrapAvailable ? 'Set up first owner' : 'Create an account';
        invitation.hidden = authAction === 'login';
        invitation.querySelector('[data-code-label]').textContent = authAction === 'bootstrap' ? 'Bootstrap token' : 'Invitation code';
        form.querySelector('[name="invitation"]').required = authAction === 'bootstrap';
        error.textContent = '';
      }
      modeChanged();
      toggle.onclick = ()=>{ if(!pending){ authAction = authAction === 'login' ? (bootstrapAvailable ? 'bootstrap' : 'register') : 'login'; modeChanged(); } };
      form.onsubmit = async event=>{
        event.preventDefault();
        if(pending || epoch !== current) return;
        pending = true; submit.disabled = toggle.disabled = true; error.textContent = '';
        const username = form.querySelector('[name="username"]').value.trim();
        const password = form.querySelector('[name="password"]').value;
        try {
          const body={username,password};
          const code=form.querySelector('[name="invitation"]').value.trim();
          if(authAction === 'bootstrap') body.token=code;
          if(authAction === 'register') body.invite_code=code;
          await api('/api/auth/'+authAction,{method:'POST',body:JSON.stringify(body)});
          if(dead || epoch !== current) return;
          accountInvite=''; form.querySelector('[name="invitation"]').value='';
          if(!dead && epoch === current) await start();
        } catch(problem) {
          if(!dead && epoch === current) error.textContent = problem.message || 'Sign-in failed.';
        } finally {
          pending = false;
          if(!dead && epoch === current){ submit.disabled = toggle.disabled = false; }
        }
      };
    }

    function renderFailure(message){
      root.innerHTML = `<main class="start-screen"><section class="login-card"><span class="brand">${MARK}<b>${BRAND}</b></span><h1>Connection unavailable</h1><p>${esc(message)}</p><button data-retry>Retry</button></section></main>`;
      root.querySelector('[data-retry]').onclick = start;
    }

    async function refresh(){
      if(dead || !user) return false;
      const serial = ++catalogRequest, current = epoch;
      const [nextWorkspaces,nextBoxes] = await Promise.all([api('/api/workspaces'),api('/api/devboxes')]);
      if(dead || serial !== catalogRequest || current !== epoch) return false;
      workspaces = nextWorkspaces; devboxes = nextBoxes;
      const chosen = UI.selectWorkspace(workspaces,activeWorkspaceId);
      const changed = activeWorkspaceId !== (chosen?.id || null);
      activeWorkspaceId = chosen?.id || null;
      if(activeWorkspaceId) writePref('workspace',activeWorkspaceId);
      if(shellReady){
        if(changed){ ++epoch; query=''; if(by('agent-filter'))by('agent-filter').value=''; dialogs.close(); resetWorkbench(); }
        else bench?.refreshAccess();
        renderChrome();
      }
      return true;
    }

    async function selectWorkspace(id){
      if(dead || !user || activeWorkspaceId === id) return;
      if(!workspaces.some(item=>item.id === id)){
        await refresh(); if(!workspaces.some(item=>item.id === id)) return;
      }
      ++epoch; ++catalogRequest;
      activeWorkspaceId = id; writePref('workspace',id);
      query='';if(by('agent-filter'))by('agent-filter').value='';
      resetKeys(); dialogs.close(); resetWorkbench(); renderChrome();
    }

    function renderShell(){
      shellReady = true;
      root.innerHTML = `<div class="app-shell${sidebarClosed?' sidebar-closed':''}">
        <header class="app-bar">
          <button class="icon-button sidebar-toggle" id="toggle-sidebar" aria-label="Toggle sidebar" title="Toggle sidebar">${ICONS.sidebar}</button>
          <span class="brand">${MARK}<b>${BRAND}</b></span>
          <div class="workspace-picker"><span>Workspace</span><button id="workspace-switch" aria-label="Choose workspace"></button></div>
          <span class="app-bar-spacer"></span>
          <span class="shortcut-indicator" id="prefix-hint" hidden role="status">Prefix…</span>
          <button class="pane-count ghost" id="pane-count" aria-label="Switch panes" hidden></button>
          <button class="command-trigger" id="tree-trigger">${ICONS.search}<span>Find an agent</span><kbd>Ctrl K</kbd></button>
          <button class="account-trigger" id="account-menu" aria-label="Account and settings" title="${esc(user.display_name || user.username)}"><span class="account-avatar">${esc(UI.initials(user.display_name || user.username))}</span>${ICONS.chevron}</button>
        </header>
        <div class="app-body">
          <aside class="sidebar" id="sidebar">
            <div class="sidebar-heading"><span>Machines</span><span id="catalog-status"></span><button class="icon-button" id="connect-machine" aria-label="Connect a machine" title="Connect a machine">${ICONS.plus}</button></div>
            <label class="sidebar-filter">${ICONS.search}<input id="agent-filter" aria-label="Filter agents" placeholder="Filter agents…" autocomplete="off"/></label>
            <div class="machine-list" id="machine-list"></div>
            <footer class="sidebar-footer"><button id="workspace-members" class="ghost">${ICONS.members}<span>Members & invitations</span></button><span id="workspace-role"></span></footer>
          </aside>
          <main class="workspace-area" id="workspace-area" aria-label="Agent workbench"></main>
        </div>
        <div id="command-layer" class="command-layer" hidden><form id="tmux-command" class="quick-command" hidden><label for="tmux-command-input">UI command</label><input id="tmux-command-input" aria-label="UI command" autocomplete="off" spellcheck="false" placeholder="help — UI actions only, not a shell"/><button type="submit">Run</button><kbd>Esc</kbd></form></div>
      </div>`;
      by('toggle-sidebar').onclick = ()=>{
        sidebarClosed=!sidebarClosed;writePref('sidebar',sidebarClosed?'closed':'open');
        root.querySelector('.app-shell').classList.toggle('sidebar-closed',sidebarClosed);bench?.resize();
      };
      by('agent-filter').oninput = event=>{query=event.target.value;renderSidebar();};
      by('workspace-switch').onclick = chooseWorkspace;
      by('pane-count').onclick = choosePane;
      by('tree-trigger').onclick = chooseTree;
      by('account-menu').onclick = ()=>accountMenu(by('account-menu'));
      by('prefix-hint').onclick = showKeyHelp;
      by('connect-machine').onclick = ()=>management.createMachine();
      by('workspace-members').onclick = ()=>management.manageWorkspace(activeWorkspaceId);
      by('tmux-command').onsubmit = event=>{
        event.preventDefault();
        const action=Tmux.command(by('tmux-command-input').value);
        leaveCommand();
        if(action)runAction(action);else notice('Unknown UI command. No shell command was run.');
      };
      by('tmux-command-input').onkeydown = event=>{
        if(!event.isComposing && event.key==='Escape'){event.preventDefault();event.stopPropagation();leaveCommand();}
      };
      resetWorkbench(); renderChrome();
    }

    function renderChrome(){
      if(!by('workspace-switch'))return;
      const current=workspace(), count=bench?.getState().count||0;
      by('workspace-switch').textContent=(current?.name||'No workspace')+' ▾';
      by('workspace-members').disabled=!current;
      by('workspace-role').textContent=current?.role ? current.role[0].toUpperCase()+current.role.slice(1)+' access' : '';
      by('connect-machine').hidden=!canManage();
      by('pane-count').hidden=count<2;by('pane-count').textContent=count+' panes';
      by('prefix-hint').hidden=!tmuxEnabled||!prefixPending;
      renderSidebar();
    }

    function renderSidebar(){
      const list=by('machine-list');if(!list)return;
      const active=bench?.getActive()?.getState(), selected=active?.agentId;
      const visible=UI.filterDevboxes(boxes(),query), totals=UI.fleetSummary(boxes());
      by('catalog-status').textContent=totals.devboxOnline+'/'+totals.devboxTotal;
      by('catalog-status').title=totals.devboxOnline+' machines online';
      list.innerHTML=visible.length ? visible.map(box=>`<section class="machine-group">
        <header class="machine-heading"><span class="connection-dot" data-state="${box.online?'online':'offline'}" title="${box.online?'Online':'Offline'}"></span><span>${esc(box.name)}</span><button class="icon-button" data-machine-menu="${esc(box.id)}" aria-label="Actions for ${esc(box.name)}" title="Machine actions">${ICONS.more}</button></header>
        <div class="agent-list">${(box.agents||[]).map(agent=>{
          const state=UI.agentStatus(agent);
          return `<div class="agent-row${selected===agent.id?' is-selected':''}"><button class="agent-open" data-open-agent="${esc(agent.id)}" title="${esc(agent.display_name||agent.handle)}"><span class="agent-mark">${ICONS.agent}</span><span class="agent-handle">${esc(agent.display_name||agent.handle)}<small>@${esc(agent.handle)}</small></span><span class="connection-dot" data-state="${state.state}" title="${esc(state.label)}"></span></button><button class="icon-button agent-sessions-toggle" data-agent-sessions="${esc(agent.id)}" aria-expanded="${expanded===agent.id}" aria-label="Live sessions for ${esc(agent.handle)}" title="Live sessions">${ICONS.chevron}</button><button class="icon-button agent-menu" data-agent-menu="${esc(agent.id)}" aria-label="Actions for ${esc(agent.handle)}" title="Agent actions">${ICONS.more}</button></div>`
            +(expanded===agent.id && liveSessions ? `<div class="agent-sessions">${liveSessions.map(session=>`<button class="agent-session${active?.sessionId===session.id?' is-selected':''}" data-open-session="${esc(session.id)}">${esc((session.title||'Session')+' · '+new Date(session.created_at+'Z').toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</button>`).join('')||'<p class="group-empty">No live sessions</p>'}</div>` : '');
        }).join('')||'<p class="group-empty">No agents yet</p>'}</div>
      </section>`).join('') : `<div class="sidebar-empty"><p>${query?'No matching agents.':'Connect a machine to bring your agents here.'}</p>${!query&&canManage()?'<button class="ghost" data-connect-empty>Connect machine</button>':''}</div>`;
      list.querySelectorAll('[data-open-agent]').forEach(button=>button.onclick=()=>openAgent(button.dataset.openAgent));
      list.querySelectorAll('[data-agent-menu]').forEach(button=>button.onclick=()=>agentMenu(button.dataset.agentMenu,button));
      list.querySelectorAll('[data-agent-sessions]').forEach(button=>button.onclick=()=>toggleSessions(button.dataset.agentSessions));
      list.querySelectorAll('[data-open-session]').forEach(button=>button.onclick=()=>{
        const session=liveSessions.find(item=>item.id===button.dataset.openSession), found=findAgent(expanded);
        if(session && found) bench?.open({kind:'live',agentId:expanded,sessionId:session.id,surface:session.surface,title:found.agent.display_name||found.agent.handle});
      });
      list.querySelectorAll('[data-machine-menu]').forEach(button=>button.onclick=()=>machineMenu(button.dataset.machineMenu,button));
      list.querySelector('[data-connect-empty]')?.addEventListener('click',()=>management.createMachine());
    }

    async function choosePane(){
      if(!bench)return;
      const scope=epoch, owner=bench;
      const chosen=await dialogs.pick({title:'Switch pane',placeholder:'Choose an open pane…',items:bench.listPanes().map(pane=>({
        label:pane.title||'Empty pane',detail:pane.surface==='structured'?'Chat':pane.surface||'',value:pane.id,
      }))});
      if(dead||scope!==epoch||owner!==bench||!chosen)return;
      if(window.matchMedia?.('(max-width:680px)').matches && bench.getState().maximized!==chosen)bench.toggleMaximize(chosen);
      else bench.activate(chosen);
    }

    function notice(message){
      if(!dead)dialogs.notice(message);
    }

    function resetKeys(){
      prefixPending=false;consumedKey=null;
      if(commandOpen)leaveCommand(false);
      renderChrome();
    }
    function enterCommand(){
      if(!bench || dead || !tmuxEnabled) return;
      prefixPending=false;commandOpen=true;commandReturnFocus=document.activeElement;
      const form=by('tmux-command'),input=by('tmux-command-input');
      by('command-layer').hidden=false;form.hidden=false;input.value='';input.focus();renderChrome();
    }
    function leaveCommand(restore=true){
      const previous=commandReturnFocus;
      commandOpen=false;commandReturnFocus=null;
      if(by('tmux-command'))by('tmux-command').hidden=true;
      if(by('command-layer'))by('command-layer').hidden=true;
      if(by('tmux-command-input'))by('tmux-command-input').value='';
      if(restore){if(previous?.isConnected)previous.focus();else bench?.getActive()?.focus();}
      renderChrome();
    }

    function resetWorkbench(){
      bench?.close(); bench = null; expanded = null;
      const area = by('workspace-area'); if(!area) return;
      area.replaceChildren();
      if(!workspace()){
        area.innerHTML = '<div class="pane-empty"><p>No workspace.</p><button data-create-workspace>Create workspace</button></div>';
        area.querySelector('[data-create-workspace]').onclick = ()=>management.createWorkspace(); return;
      }
      bench = Workbench.createWorkbench({root:area,storage,storageKey:Workbench.storageKey(user.id,activeWorkspaceId),services:{
        api,getUser:()=>user,getWorkspace:workspace,findAgent,defaultSurface,ensureTerminal,
        confirm:dialogs.confirm,alert:dialogs.alert,menu:dialogs.menu,notice,
        chooseAgent:chooseAgentTarget,onActiveChange:renderChrome,onLayoutChange:renderChrome,
      }});
      renderChrome();
    }

    async function chooseTree(){
      if(!bench || !user)return;
      const current=epoch, owner=bench;
      const items=(bench.listPanes()||[]).filter(pane=>pane.agentId).map(pane=>({label:pane.title||'Open pane',detail:'Switch to open pane',value:{kind:'focus',id:pane.id}}));
      items.push(...agentTargets().map(item=>({...item,value:{kind:'target',target:item.value}})));
      items.push(...boxes().map(box=>({label:box.name,detail:'Machine actions'+(box.online?'':' · offline'),value:{kind:'machine',id:box.id}})));
      if(canManage())items.push({label:'Connect a machine',detail:'Add an explicit connection',value:{kind:'connect'}});
      const choice=await dialogs.pick({title:'Find an agent or action',placeholder:'Search agents, panes and machines…',items});
      if(dead || current!==epoch || bench!==owner || !choice)return;
      if(choice.kind==='focus')bench.activate(choice.id);
      else if(choice.kind==='target')await bench.open(choice.target);
      else if(choice.kind==='machine')machineMenu(choice.id,by('tree-trigger'));
      else if(choice.kind==='connect')await management.createMachine();
    }

    function setTmuxEnabled(value){
      tmuxEnabled=!!value;writePref('shortcuts',tmuxEnabled?'tmux':'standard');resetKeys();
    }
    function showKeyHelp(){
      prefixPending=false;renderChrome();
      return dialogs.modal({title:'AgentBridge shortcuts',desc:'Use the workbench normally, or opt into tmux-style navigation.',
        bodyHtml:`<dl class="key-help"><dt>Ctrl K</dt><dd>Find an agent, pane or machine outside editable fields</dd><dt>Enter</dt><dd>Send a message</dd><dt>Shift Enter</dt><dd>Insert a newline</dd><dt>Drag divider</dt><dd>Resize panes without interrupting sessions</dd></dl>
          <label class="shortcut-toggle"><input type="checkbox" data-enable-tmux/><span><b>Enable tmux-style shortcuts</b><small>Optional. Off by default so Ctrl+B remains native.</small></span></label>
          <details class="shortcut-reference"${tmuxEnabled?' open':''}><summary>Advanced key reference</summary><p class="hint">When enabled, press Ctrl+B, release it, then the next key.</p><dl class="key-help"><dt>% / "</dt><dd>Split right / below</dd><dt>Arrows / o</dt><dd>Move focus / next pane</dd><dt>0…3 / z</dt><dd>Select pane / maximize</dd><dt>x</dt><dd>Close view, keep agent running</dd><dt>w / s</dt><dd>Find agent / choose workspace</dd><dt>c / h / r</dt><dd>New session / history / reconnect</dd><dt>:</dt><dd>UI command prompt, not a shell</dd><dt>Ctrl+B again</dt><dd>Forward one literal prefix to an owned terminal</dd><dt>Esc</dt><dd>Cancel</dd></dl><p class="hint">The UI prompt supports split-window, select-pane, resize-pane -Z, choose-tree, close-pane and other actions shown by help. It never executes OS commands. End session keeps its permission check and confirmation.</p></details>`,
        actions:[{label:'Done',primary:true,value:true}],onReady:element=>{
          element.querySelector('.modal').classList.add('shortcut-help');
          const toggle=element.querySelector('[data-enable-tmux]');toggle.checked=tmuxEnabled;
          toggle.onchange=()=>{setTmuxEnabled(toggle.checked);element.querySelector('.shortcut-reference').open=tmuxEnabled;};
        }});
    }

    async function runAction(action){
      if(dead || !bench)return;
      const owner=bench, pane=bench.getActive(), state=pane?.getState();
      try {
        switch(action.type){
          case 'split':bench.split(undefined,action.axis);break;
          case 'focus':bench.moveFocus(action.direction);break;
          case 'cycle':bench.cycle(action.step);break;
          case 'select':if(action.index<bench.listPanes().length)bench.selectIndex(action.index);else notice('That pane is not open.');break;
          case 'zoom':bench.toggleMaximize();break;
          case 'close':bench.closePane();break;
          case 'tree':await chooseTree();break;
          case 'workspace':await chooseWorkspace();break;
          case 'new-session':if(!state?.agentId)await chooseTree();else if(state.canOperate)await pane.newSession();else notice('This workspace is read-only.');break;
          case 'reconnect':await pane?.reconnect();break;
          case 'history':if(state?.agentId)await pane.showHistory();else await chooseTree();break;
          case 'end-session':if(state?.canEndSession)await pane.endSession();else notice('End session needs the keyboard holder or the required workspace role.');break;
          case 'interrupt':pane?.interrupt?.();break;
          case 'request-keyboard':pane?.requestKeyboard();break;
          case 'release-keyboard':pane?.releaseKeyboard();break;
          case 'send-prefix':if(pane?.sendPrefix?.()===false)notice('Literal Ctrl+B is only sent to an owned, live terminal.');break;
          case 'theme':theme=action.value;writePref('theme',theme);applyTheme();break;
          case 'menu':accountMenu(by('account-menu'));break;
          case 'command':enterCommand();break;
          case 'help':await showKeyHelp();break;
          case 'cancel':break;
        }
      } catch(error){if(!dead && owner===bench)notice(error.message||'UI action failed.');}
      if(!dead && owner===bench)renderChrome();
    }

    async function openAgent(id,surface=null){
      const found=findAgent(id); if(!found || !bench) return;
      if(!found.box.online) return bench.open({kind:'history',agentId:id,title:found.agent.display_name||found.agent.handle});
      return bench.open({kind:'live',agentId:id,surface:surface||defaultSurface(id),title:found.agent.display_name||found.agent.handle});
    }
    function toggleSessions(id){
      expanded=expanded===id ? null : id; liveSessions=null; renderSidebar();
      if(expanded) return loadSessions(expanded);
    }
    async function loadSessions(id){
      const scope=epoch;
      try {
        const sessions=await api(UI.agentApiPath(id)+'/sessions');
        if(dead || scope!==epoch || expanded!==id) return;
        liveSessions=sessions.filter(session=>session.state==='live'); renderSidebar();
      } catch(error) { if(!dead && scope===epoch) notice(error.message||'Live sessions unavailable.'); }
    }
    function agentTargets(){
      const targets=[];
      for(const box of boxes()) for(const agent of box.agents||[]){
        const capability=UI.findRuntimeCapability(box.capabilities,agent.runtime);
        const surface=UI.preferredSurface(capability);
        const surfaces=UI.isCapabilityV2(capability) ? UI.capabilitySurfaces(capability).filter(item=>item.available!==false).map(item=>item.id) : [surface];
        for(const mode of [...new Set([surface,...surfaces])]) if(['terminal','structured'].includes(mode)){
          targets.push({label:'@'+agent.handle,detail:box.name+' · '+(mode==='structured'?'Chat':'Terminal')+(box.online?'':' · offline'),
            keywords:agent.display_name+' '+agent.runtime,
            value:box.online ? {kind:'live',agentId:agent.id,surface:mode,title:agent.display_name||agent.handle}
              : {kind:'history',agentId:agent.id,title:agent.display_name||agent.handle}});
        }
      }
      return targets;
    }
    async function chooseAgentTarget(){
      const current=epoch;
      const target=await dialogs.pick({title:'Choose an agent',placeholder:'Agent, machine or runtime…',items:agentTargets()});
      return !dead && current===epoch ? target : null;
    }
    async function chooseWorkspace(){
      const items=workspaces.map(item=>({label:item.name,detail:item.role,value:item.id}));
      items.push({label:'Create workspace',detail:'A separate sharing boundary',value:'__new__'});
      const current=epoch, choice=await dialogs.pick({title:'Choose workspace',items});
      if(dead || current!==epoch || !choice) return;
      if(choice==='__new__') await management.createWorkspace(); else await selectWorkspace(choice);
    }
    function agentMenu(id,anchor){
      const found=findAgent(id); if(!found) return;
      const capability=UI.findRuntimeCapability(found.box.capabilities,found.agent.runtime);
      const surfaces=UI.isCapabilityV2(capability) ? UI.capabilitySurfaces(capability).filter(item=>item.available!==false).map(item=>item.id) : [defaultSurface(id)];
      scopedMenu(anchor,[
        ...surfaces.filter(surface=>['terminal','structured'].includes(surface)).map(surface=>({label:surface==='structured'?'Open chat':'Open terminal',disabled:!found.box.online,action:()=>openAgent(id,surface)})),
        {label:'Session history',action:()=>bench?.open({kind:'history',agentId:id,title:found.agent.display_name||found.agent.handle})},
        ...(management.hasAgentSettings(found.agent) && canManage() ? [{label:'Agent settings',action:()=>management.agentSettings(id)}] : []),
        {separator:true}, {label:'Delete agent…',danger:true,disabled:!canManage(),action:()=>management.deleteAgent(id,found.agent.handle)},
      ]);
    }
    function machineMenu(id,anchor){
      scopedMenu(anchor,[
        {label:'Add agent',disabled:!canManage(),action:()=>management.createAgent(id)},
        {label:'Runtimes',action:()=>management.showRuntimes(id)},
        {label:'Skills',action:()=>management.showSkills(id)},
        {separator:true}, {label:'Rotate connection token…',disabled:!canManage(),action:()=>management.rotateMachineToken(id)},
        {label:'Delete machine…',disabled:!canManage(),danger:true,action:()=>management.deleteMachine(id)},
      ]);
    }
    function accountMenu(anchor){
      scopedMenu(anchor,[
        {label:theme==='dark'?'Use light theme':'Use dark theme',action:()=>{theme=theme==='dark'?'light':'dark';writePref('theme',theme);applyTheme();}},
        {label:'Keyboard shortcuts',action:showKeyHelp},
        {label:'Account administration',disabled:user?.role!=='owner',action:()=>management.admin()},
        {separator:true}, {label:'Sign out',action:logout},
      ]);
    }
    function openCommands(){return chooseTree();}
    async function logout(){
      const scope=epoch;
      const microsoftLogout=authConfig?.microsoft_enabled ? authConfig.microsoft_logout_url || '/api/auth/microsoft/logout' : null;
      try {
        await api('/api/auth/logout',{method:'POST'});
        if(dead || scope!==epoch) return;
        if(microsoftLogout) window.location.href=microsoftLogout;
        else await start();
      } catch(error){ dialogs.notice(error.message || 'Could not sign out.'); }
    }
    function key(event){
      if(dead || event.isComposing || commandOpen) return;
      const ctrlK=(event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='k';
      if(dialogs.isPicker()&&ctrlK){event.preventDefault();event.stopPropagation?.();dialogs.close();return;}
      if(!user || !bench || dialogs.isOpen()) return;
      const inside=!event.target || event.target===document.body || root.contains(event.target);
      if(!inside)return;
      const code=event.code||event.key;
      const consume=()=>{event.preventDefault();event.stopPropagation?.();};
      if(event.repeat && consumedKey===code){consume();return;}
      if(!event.repeat)consumedKey=null;
      if(prefixPending){
        if(['Control','Shift','Alt','Meta','AltGraph','CapsLock'].includes(event.key))return;
        consume();prefixPending=false;consumedKey=code;
        const action=Tmux.binding(event);renderChrome();
        if(action)runAction(action);else notice('Unknown prefix key. Ctrl+B, ? shows the key bindings.');
        return;
      }
      if(tmuxEnabled && Tmux.isPrefix(event)){
        if(event.target?.closest?.(EDITABLE) && !event.target?.closest?.('.workspace-area'))return;
        consume();if(!event.repeat){prefixPending=true;renderChrome();}return;
      }
      // Outside prefix mode, native editing keys (including Ctrl+K) stay native.
      if(ctrlK&&!event.target?.closest?.(EDITABLE)){consume();chooseTree();}
    }
    function pointer(event){
      if(prefixPending){prefixPending=false;consumedKey=null;renderChrome();}
      if(commandOpen&&!by('tmux-command')?.contains(event.target))leaveCommand(false);
    }
    function resized(){ bench?.resize(); }
    document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',pointer,true);window.addEventListener('resize',resized);
    function destroy(){
      if(dead) return; dead=true; ++epoch; ++catalogRequest; stopWorkbench(); dialogs.destroy();
      user=null; authConfig=null; workspaces=[]; devboxes=[]; activeWorkspaceId=null; accountInvite=''; pendingInvite=null;
      document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',pointer,true);window.removeEventListener('resize',resized);root.replaceChildren();
    }
    return {start,destroy,refresh,selectWorkspace,openAgent,openCommands,
      getState:()=>({userId:user?.id||null,workspaceId:activeWorkspaceId,epoch,theme,paneCount:bench?.getState().count||0,tmuxEnabled,prefixPending,commandOpen}),
    };
  }
  return {createApp};
});
