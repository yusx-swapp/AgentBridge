/* Workbench owns layout and focus. A pane owns its session and connection. */
(function(root, factory){
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./layout.js') : root.AgentBridgeLayout,
    options=>(common ? require('./pane.js') : root.AgentBridgePane).createPane(options));
  if(common) module.exports = api;
  else root.AgentBridgeWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Layout, defaultPaneFactory){
  'use strict';
  const VERSION = 1;
  const MAX_SAVED_LENGTH = 16384;
  const validResourceId = value=>typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
  // Static, trusted artwork only. Session titles and other remote text never enter SVG/HTML.
  const ICONS = {
    split:'<svg class="pane-icon" data-icon="split" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
    more:'<svg class="pane-icon" data-icon="more" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  };

  function storageKey(userId, workspaceId){
    if(userId == null || workspaceId == null) return null;
    return 'agentbridge.workbench.v1:' + JSON.stringify([String(userId), String(workspaceId)]);
  }

  function persistentTarget(value){
    if(!value || !['live','history','replay'].includes(value.kind) || !validResourceId(value.agentId)) return null;
    if(value.kind !== 'history' && !validResourceId(value.sessionId)) return null;
    const target = {kind:value.kind, agentId:value.agentId};
    if(value.kind !== 'history') target.sessionId = value.sessionId;
    if(['terminal','structured'].includes(value.surface)) target.surface = value.surface;
    return target;
  }

  function decodeSaved(raw){
    if(typeof raw !== 'string' || raw.length > MAX_SAVED_LENGTH) return null;
    try {
      const value = JSON.parse(raw);
      if(value.version !== VERSION) return null;
      const tree = Layout.sanitize(value.tree);
      if(!tree) return null;
      const ids = Layout.ids(tree), targets = new Map();
      for(const item of Array.isArray(value.panes) ? value.panes.slice(0, Layout.MAX_PANES) : []){
        if(!item || !ids.includes(item.id) || targets.has(item.id)) continue;
        const target = persistentTarget(item.target);
        if(target) targets.set(item.id, target);
      }
      return {tree, active:ids.includes(value.active) ? value.active : ids[0], targets};
    } catch { return null; }
  }

  function createWorkbench({root, services, storage, storageKey, createPane=defaultPaneFactory}){
    const document = root.ownerDocument;
    const window = document.defaultView || globalThis;
    let saved = null;
    try { if(storage && storageKey) saved = decodeSaved(storage.getItem(storageKey)); } catch {}
    let tree = saved?.tree || Layout.pane('pane-1');
    let active = saved?.active || Layout.ids(tree)[0];
    let maximized = null, counter = 1, disposed = false, dragging = null, initializing = true;
    let lastSaved = '', saveWarning = false;
    const entries = new Map();
    root.classList.add('workbench');

    function newId(){
      let id;
      do { id = 'pane-' + (++counter); } while(Layout.ids(tree).includes(id) || entries.has(id));
      return id;
    }

    function persist(){
      if(disposed || initializing || !storage || !storageKey) return;
      const panes = [];
      for(const id of Layout.ids(tree)){
        const entry = entries.get(id);
        const target = persistentTarget(entry.controller.snapshot()) || persistentTarget(entry.requested);
        if(target) panes.push({id, target});
      }
      const value = JSON.stringify({version:VERSION, tree, active, panes});
      if(value === lastSaved) return;
      try { storage.setItem(storageKey, value); lastSaved = value; }
      catch {
        if(!saveWarning) services.notice?.('Layout storage is unavailable; this view will not be remembered.');
        saveWarning = true;
      }
    }

    function updateChrome(entry, state, index){
      const title = state.title || state.agentId || 'Choose an agent';
      entry.stateKey = JSON.stringify(state);
      entry.title.textContent = title;
      entry.title.title = `Pane ${index}: ${title} · Choose agent`;
      entry.title.setAttribute('aria-label', `Choose agent for pane ${index}: ${title}`);
      entry.frame.dataset.paneIndex = String(index);
      entry.frame.setAttribute('aria-label', `Pane ${index}: ${title}`);
      entry.mode.textContent = state.surface === 'structured' ? 'Chat' : state.surface === 'terminal' ? 'Terminal'
        : state.kind === 'history' ? 'History' : '';
      entry.mode.hidden = !entry.mode.textContent;

      const connection = state.status || 'empty';
      const activity = connection === 'live' && state.surface === 'structured'
        ? state.permissionPending ? 'permission' : state.pending ? 'working' : 'idle' : 'idle';
      const labels = {empty:'', opening:'Opening', connecting:'Connecting', connected:'Waiting', live:'Live',
        offline:'Offline', disconnected:'Disconnected', reconnecting:'Reconnecting', unavailable:'Unavailable',
        error:'Error', history:'History', replay:'History', inactive:'Ended', ended:'Ended', closed:'Closed'};
      const status = activity === 'permission' ? 'Permission needed' : activity === 'working' ? 'Working'
        : labels[connection] ?? connection;
      const detail = [status, state.statusText].filter((text, i, all)=>text && all.indexOf(text) === i).join(' · ');
      entry.status.dataset.state = connection;
      entry.status.dataset.activity = activity;
      entry.status.title = detail || 'Empty pane';
      entry.status.setAttribute('aria-label', detail || 'Empty pane');
      entry.status.textContent = status;
      entry.status.hidden = !status;

      // A passive access badge keeps ownership clear without another row of controls.
      // Keyboard operations remain scoped to the pane controller in the overflow menu.
      let access = '', accessText = '', accessDetail = '';
      if(state.kind === 'live' && !state.canOperate){
        access = 'viewer'; accessText = 'Viewer'; accessDetail = 'Read-only viewer access';
      } else if(state.kind === 'live' && state.surface === 'terminal' && connection === 'live'){
        if(state.keyboardOwned){
          access = state.keyboardRequestPending ? 'requested' : 'owned';
          accessText = state.keyboardRequestPending ? 'Request waiting' : 'You control';
          accessDetail = state.keyboardRequestPending
            ? 'You control the keyboard · A collaborator is waiting. Hand off keyboard in Pane actions.'
            : 'You control the keyboard';
        } else if(state.keyboardPending){
          access = 'pending'; accessText = 'Syncing'; accessDetail = 'Read-only · Waiting for keyboard state';
        } else if(state.keyboardBusy){
          access = 'busy'; accessText = 'Keyboard held';
          accessDetail = `Read-only · Keyboard held by ${state.keyboardHolder || 'another collaborator'}. Request keyboard in Pane actions.`;
        } else {
          access = 'available'; accessText = 'Keyboard free';
          accessDetail = 'Read-only until you take the keyboard in Pane actions';
        }
      } else if(state.kind === 'replay' || state.kind === 'live' && state.readOnly){
        access = 'readonly'; accessText = 'Read-only'; accessDetail = 'Read-only view';
      }
      entry.access.dataset.access = access;
      entry.access.textContent = accessText;
      entry.access.title = accessDetail;
      entry.access.setAttribute('aria-label', accessDetail);
      entry.access.hidden = !accessText;
    }

    function notifyLayout(){
      services.onLayoutChange?.({count:entries.size, active, maximized});
    }

    function changed(entry){
      if(disposed || entries.get(entry.id) !== entry) return;
      const state = entry.controller.getState();
      // Output-only updates do not rebuild chrome/tabs or touch storage.
      if(entry.stateKey === JSON.stringify(state)) return;
      updateChrome(entry, state, Layout.ids(tree).indexOf(entry.id));
      if(entry.id === active) services.onActiveChange?.(state);
      notifyLayout(); persist();
    }

    function buildPane(id){
      const frame = document.createElement('section');
      frame.className = 'pane'; frame.dataset.paneId = id; frame.tabIndex = -1;
      frame.setAttribute('role', 'region');
      const bar = document.createElement('header'); bar.className = 'pane-bar';
      const title = document.createElement('button'); title.className = 'pane-title'; title.type = 'button';
      title.setAttribute('data-action', 'choose-agent'); title.setAttribute('aria-haspopup', 'dialog');
      const mode = document.createElement('span'); mode.className = 'pane-mode';
      const status = document.createElement('span'); status.className = 'pane-status';
      const access = document.createElement('span'); access.className = 'pane-access';
      const split = document.createElement('button'); split.className = 'pane-split pane-tool'; split.type = 'button';
      split.setAttribute('data-action', 'split'); split.setAttribute('aria-label', 'Split pane');
      split.setAttribute('aria-haspopup', 'menu'); split.title = 'Split pane'; split.innerHTML = ICONS.split;
      const menu = document.createElement('button'); menu.className = 'pane-menu pane-tool'; menu.type = 'button';
      menu.setAttribute('data-action', 'menu'); menu.setAttribute('aria-label', 'Pane actions');
      menu.setAttribute('aria-haspopup', 'menu'); menu.title = 'Pane actions'; menu.innerHTML = ICONS.more;
      bar.append(title, mode, status, access, split, menu);
      const body = document.createElement('div'); body.className = 'pane-content';
      body.innerHTML = '<div class="pane-empty"><button type="button" class="ghost" data-choose-agent>Choose an agent</button><p>Open another pane to work side by side.</p></div>';
      body.querySelector('[data-choose-agent]').onclick = ()=>chooseAgent(id);
      frame.append(bar, body);
      const entry = {id, frame, body, title, mode, status, access, stateKey:null, requested:null, controller:null};
      frame.addEventListener('pointerdown', event=>{
        activate(id, false);
        const interactive=event.target?.closest?.('button,input,textarea,select,a,[contenteditable="true"]');
        // A passive border/transcript click must not leave the caret in another pane.
        if(!frame.contains(document.activeElement) && (!interactive || interactive.disabled)) frame.focus();
        if(!interactive && event.target?.closest?.('.pane-bar')) entry.controller.focus();
      });
      frame.addEventListener('focusin', ()=>activate(id, false));
      title.onclick = ()=>chooseAgent(id);
      split.onclick = ()=>openSplitMenu(id, split);
      menu.onclick = ()=>openMenu(id, menu);
      entry.controller = createPane({id, root:body, services:{...services,
        isActive:()=>!disposed && active === id,
        onChange:()=>changed(entry),
      }});
      entries.set(id, entry);
      return entry;
    }

    function activate(id, focus=true){
      if(disposed || !entries.has(id)) return null;
      const different = active !== id;
      const switchZoom = !!maximized && maximized !== id;
      active = id;
      if(switchZoom) maximized = id;
      for(const entry of entries.values()){
        entry.frame.classList.toggle('is-active', entry.id === id);
        if(switchZoom) entry.frame.hidden = entry.id !== id;
      }
      if(switchZoom) resize();
      if(focus) entries.get(id).controller.focus();
      if(different){
        persist(); services.onActiveChange?.(entries.get(id).controller.getState()); notifyLayout();
      }
      return id;
    }

    function selectIndex(index){
      if(disposed || !Number.isInteger(index) || index < 0) return null;
      return activate(Layout.ids(tree)[index]);
    }

    function cycle(step=1){
      if(disposed || !Number.isInteger(step)) return null;
      const paneIds = Layout.ids(tree), index = paneIds.indexOf(active);
      if(index < 0) return null;
      return activate(paneIds[((index + step) % paneIds.length + paneIds.length) % paneIds.length]);
    }

    function moveFocus(direction){
      if(disposed) return null;
      const id = Layout.neighbor(tree, active, direction);
      return id ? activate(id) : null;
    }

    function listPanes(){
      return Layout.ids(tree).flatMap((id, index)=>{
        const entry = entries.get(id);
        return entry ? [{...entry.controller.getState(), id, index}] : [];
      });
    }

    async function chooseAgent(id=active){
      if(disposed || !entries.has(id)) return;
      activate(id, false);
      const target = await services.chooseAgent?.(entries.get(id).controller.getState());
      if(!disposed && target && entries.has(id)) await open(target, id);
    }

    async function open(value, id=active){
      if(disposed || !entries.has(id) || !value) return;
      let target = {...value};
      if(target.kind === 'live' && !target.surface && !target.sessionId){
        target.surface = services.defaultSurface?.(target.agentId) || 'terminal';
      }
      if(target.kind === 'live' && !target.forceNew){
        for(const entry of entries.values()){
          if(entry.id === id) continue;
          const other = entry.requested || entry.controller.snapshot();
          if(other?.kind !== 'live') continue;
          const same = target.sessionId ? other.sessionId === target.sessionId
            : target.agentId === other.agentId && target.surface === other.surface;
          if(same){
            if(target.resume){ id=entry.id; break; }
            if(!target.restore) activate(entry.id); return;
          }
        }
      }
      const entry = entries.get(id);
      entry.requested = target;
      if(!target.restore) activate(id, false);
      const previousFocus = document.activeElement;
      try {
        await entry.controller.open(target);
        if(!disposed && entries.get(id) === entry){
          changed(entry);
          if(active === id && (document.activeElement === previousFocus || document.activeElement === document.body)) entry.controller.focus();
        }
      } catch(error) {
        if(!disposed && entries.get(id) === entry) services.notice?.(error.message || 'Could not open this pane.');
      } finally {
        if(entries.get(id) === entry) entry.requested = null;
      }
    }

    function splitPane(id=active, axis='row'){
      if(disposed || !entries.has(id)) return null;
      if(Layout.ids(tree).length >= Layout.MAX_PANES){
        services.notice?.('Up to four panes can be open. Close a pane or maximize the one you need.');
        return null;
      }
      const newPaneId = newId();
      tree = Layout.split(tree, id, newPaneId, axis);
      maximized = null;
      buildPane(newPaneId);
      active = newPaneId;
      render(); persist();
      chooseAgent(newPaneId);
      return newPaneId;
    }

    function closePane(id=active){
      if(disposed || !entries.has(id)) return;
      stopDragging();
      const entry = entries.get(id);
      entries.delete(id);
      entry.controller.close();
      entry.frame.remove();
      tree = Layout.remove(tree, id);
      if(!tree){
        const blank = newId(); tree = Layout.pane(blank); buildPane(blank);
      }
      if(active === id) active = Layout.ids(tree)[0];
      if(maximized === id) maximized = null;
      render(); persist(); activate(active);
    }

    function toggleMaximize(id=active){
      if(disposed || !entries.has(id)) return;
      maximized = maximized === id ? null : id;
      active = id;
      render(); persist(); activate(id);
    }

    function resizePath(path, value, save=true){
      if(disposed) return;
      tree = Layout.resize(tree, path, value);
      const key = path.join('/');
      const branch = root.querySelector(`[data-split-path="${key}"]`);
      const node = Layout.at(tree, path);
      if(branch && node?.type === 'split'){
        branch.firstElementChild.style.flex = `${node.ratio} 1 0`;
        branch.lastElementChild.style.flex = `${1-node.ratio} 1 0`;
        branch.querySelector('[role="separator"]').setAttribute('aria-valuenow', Math.round(node.ratio*100));
      }
      resize(); if(save) persist();
    }

    function stopDragging(){
      if(!dragging) return;
      window.removeEventListener('pointermove', dragging.move);
      window.removeEventListener('pointerup', dragging.stop);
      window.removeEventListener('pointercancel', dragging.stop);
      dragging = null;
      root.classList.remove('is-resizing');
    }

    function makeSeparator(branch, path, axis, value){
      const separator = document.createElement('div');
      separator.className = 'splitter'; separator.tabIndex = 0;
      separator.setAttribute('role', 'separator');
      separator.setAttribute('aria-label', 'Resize panes');
      separator.setAttribute('aria-orientation', axis === 'row' ? 'vertical' : 'horizontal');
      separator.setAttribute('aria-valuemin', 15); separator.setAttribute('aria-valuemax', 85);
      separator.setAttribute('aria-valuenow', Math.round(value * 100));
      separator.onpointerdown = event=>{
        if(event.button !== 0) return;
        event.preventDefault(); stopDragging(); root.classList.add('is-resizing');
        const move = pointer=>{
          if(disposed || !branch.isConnected) return;
          const box = branch.getBoundingClientRect();
          const size = axis === 'row' ? box.width : box.height;
          if(size <= 0) return;
          const position = axis === 'row' ? pointer.clientX - box.left : pointer.clientY - box.top;
          const min = Math.min(0.45, 160 / size);
          resizePath(path, Math.max(min, Math.min(1-min, position/size)), false);
        };
        const stop = ()=>{ stopDragging(); persist(); };
        dragging = {move, stop};
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      };
      separator.ondblclick = ()=>resizePath(path, 0.5);
      separator.onkeydown = event=>{
        const backward = axis === 'row' ? 'ArrowLeft' : 'ArrowUp';
        const forward = axis === 'row' ? 'ArrowRight' : 'ArrowDown';
        if(![backward, forward, 'Home'].includes(event.key)) return;
        event.preventDefault();
        const current = Layout.at(tree, path);
        if(current?.type === 'split') resizePath(path, event.key === 'Home' ? 0.5 : current.ratio + (event.key === forward ? 0.05 : -0.05));
      };
      return separator;
    }

    function renderNode(node, path=[]){
      if(node.type === 'pane') return entries.get(node.id).frame;
      const branch = document.createElement('div'); branch.className = 'split';
      branch.dataset.axis = node.axis; branch.dataset.splitPath = path.join('/');
      const first = renderNode(node.first, [...path,'first']);
      const second = renderNode(node.second, [...path,'second']);
      first.style.flex = `${node.ratio} 1 0`; second.style.flex = `${1-node.ratio} 1 0`;
      branch.append(first, makeSeparator(branch, path, node.axis, node.ratio), second);
      return branch;
    }

    function render(){
      if(disposed) return;
      stopDragging();
      const ordered = Layout.ids(tree).map(id=>entries.get(id));
      ordered.forEach((entry, index)=>{
        entry.frame.hidden = !!maximized && entry.id !== maximized;
        entry.frame.classList.toggle('is-active', entry.id === active);
        updateChrome(entry, entry.controller.getState(), index);
      });
      if(maximized){
        for(const entry of ordered) entry.frame.style.flex = '1 1 0';
        root.replaceChildren(...ordered.map(entry=>entry.frame));
      } else {
        root.replaceChildren(renderNode(tree));
      }
      root.classList.toggle('is-maximized', !!maximized);
      resize();
      services.onActiveChange?.(entries.get(active).controller.getState());
      notifyLayout();
    }

    function menuAction(entry, action){
      return ()=>{ if(!disposed && entries.get(entry.id) === entry) return action(); };
    }

    function openSplitMenu(id, anchor){
      const entry = entries.get(id);
      if(!entry || disposed) return;
      activate(id, false);
      const disabled = entries.size >= Layout.MAX_PANES;
      services.menu?.(anchor, [
        {label:'Split right', disabled, action:menuAction(entry, ()=>splitPane(id,'row'))},
        {label:'Split below', disabled, action:menuAction(entry, ()=>splitPane(id,'column'))},
      ]);
    }

    function openMenu(id, anchor){
      const entry = entries.get(id);
      if(!entry || disposed) return;
      activate(id, false);
      const state = entry.controller.getState();
      const terminal = state.kind === 'live' && state.surface === 'terminal';
      const keyboardAvailable = state.canOperate && state.status === 'live' && !state.keyboardPending;
      const viewKey = state=>JSON.stringify([state.kind, state.agentId, state.sessionId, state.surface]);
      const view = viewKey(state);
      const action = name=>menuAction(entry, ()=>{
        // A menu from an old session must not operate on its replacement.
        if(viewKey(entry.controller.getState()) === view) return entry.controller[name]();
      });
      services.menu?.(anchor, [
        {label:'Choose agent', action:menuAction(entry, ()=>chooseAgent(id))},
        {label:'New session', disabled:!state.canOperate || !state.agentId, action:action('newSession')},
        ...(state.surface === 'structured' ? [{label:'Interrupt turn', disabled:state.kind !== 'live' || state.status !== 'live' || !state.canOperate || state.readOnly, action:action('interrupt')}] : []),
        {label:'Reconnect', disabled:state.kind !== 'live', action:action('reconnect')},
        {label:'History', disabled:!state.agentId, action:action('showHistory')},
        ...(terminal ? [
          {separator:true},
          {label:state.keyboardBusy ? 'Request keyboard' : 'Take keyboard',
            disabled:!keyboardAvailable || !!state.keyboardOwned, action:action('requestKeyboard')},
          {label:'Release keyboard', disabled:!keyboardAvailable || !state.keyboardOwned, action:action('releaseKeyboard')},
          {label:'Hand off keyboard', disabled:!keyboardAvailable || !state.keyboardOwned || !state.keyboardRequestPending,
            action:action('handoffKeyboard')},
        ] : []),
        {separator:true},
        {label:maximized === id ? 'Restore layout' : 'Maximize pane', action:menuAction(entry, ()=>toggleMaximize(id))},
        {separator:true},
        {label:'End session for everyone…', disabled:!state.canEndSession, danger:true, action:action('endSession')},
        {label:'Close pane (keep running)', action:menuAction(entry, ()=>closePane(id))},
      ]);
    }

    function resize(){
      for(const entry of entries.values()) if(!entry.frame.hidden) entry.controller.resize();
    }

    function close(){
      if(disposed) return;
      persist(); disposed = true; stopDragging();
      for(const entry of entries.values()) entry.controller.close();
      entries.clear(); root.replaceChildren();
    }

    function closeAgent(agentId){
      for(const [id, entry] of [...entries]){
        if(entry.controller.getState().agentId === agentId) closePane(id);
      }
    }
    function refreshAccess(){
      if(!disposed) for(const entry of entries.values()) entry.controller.refreshAccess?.();
    }

    for(const id of Layout.ids(tree)) buildPane(id);
    render();
    if(saved) for(const [id, target] of saved.targets) open({...target, restore:true}, id);
    initializing = false; persist();
    return {open, chooseAgent, split:splitPane, closePane, closeAgent, refreshAccess, activate,
      cycle, selectIndex, moveFocus, listPanes, toggleMaximize, resize, close,
      getActive:()=>entries.get(active)?.controller || null,
      getState:()=>({tree, active, maximized, count:entries.size}),
      getPane:id=>entries.get(id)?.controller || null,
    };
  }

  return {createWorkbench, decodeSaved, persistentTarget, storageKey};
});
